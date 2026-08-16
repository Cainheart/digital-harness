import type BetterSqlite3 from "better-sqlite3";
import { newObjectId, utcNow } from "../domain/common.js";
import type { ModelDomain, ModelProvider } from "../domain/model-config.js";
import { ModelGatewayError } from "../gateway/model/errors.js";
import type { ModelUsage } from "../gateway/model/model-adapter.js";
import { calculateCostMicros, DEFAULT_MODEL_PRICING, PricingResolver } from "../gateway/model/usage.js";
import { Database } from "../infra/database.js";
import { ensureProjectChild, ensureProjectWritable } from "../infra/repositories/common.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import type { TraceContext } from "./trace.js";
import {
  RedactionResult,
  summarizeModelError,
} from "./redaction.js";

/** 模型调用开始时必须持久化的最小关联上下文。 */
export type ModelCallStart = {
  modelCallId?: string;
  projectId: string;
  taskId: string | null;
  attemptId: string;
  domain: ModelDomain;
  role: string;
  provider: ModelProvider;
  modelName: string;
  configVersion: number;
  startedAt?: string;
  timeoutMs: number;
  trace: TraceContext;
  inputSummary: RedactionResult;
  artifactRef?: string | null;
};
/** 模型调用成功时追加的用量、成本、输出摘要和重试结果。 */
export type ModelCallResult = {
  endedAt?: string;
  outputSummary: RedactionResult;
  usage: ModelUsage;
  costMicros?: number;
  retryCount: number;
  artifactRef?: string | null;
};
/** 模型调用失败时追加的归一化错误和最终状态。 */
export type ModelCallFailure = {
  endedAt?: string;
  error: ModelGatewayError;
  retryCount: number;
};
/** 调用句柄只包含 ID 和不可变开始时间，不能携带凭据。 */
export type CallHandle = {
  modelCallId: string;
  startedAt: string;
};
/** 调用控制台可展示的脱敏模型调用记录。 */
export type ModelCallView = {
  modelCallId: string;
  projectId: string;
  taskId: string | null;
  attemptId: string;
  domain: string;
  role: string;
  provider: string;
  modelName: string;
  configVersion: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  timeoutMs: number | null;
  timedOut: boolean;
  retryCount: number;
  inputSummary: string;
  outputSummary: string;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costMicros: number | null;
  artifactRef: string | null;
  redactionStatus: string;
  finalStatus: string;
  traceId: string;
  spanId: string;
};
/** 调用查询过滤器；所有字段都只允许映射到固定 SQL 列。 */
export type ModelCallQuery = {
  projectId?: string | null;
  taskId?: string | null;
  traceId?: string | null;
  domain?: string | null;
  model?: string | null;
  limit?: number;
};
/** 按领域和模型聚合的调用控制台指标。 */
export type ModelCallAggregate = {
  key: string;
  domain: string;
  modelName: string;
  callCount: number;
  averageDurationMs: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
  retryCount: number;
  completedTaskCostMicros: number;
};

/** 将模型调用开始、完成、失败写入数据库、领域事件和 TraceLink。 */
export class SqliteModelCallRecorder {
  private readonly eventStore = new SqliteEventStore();

  /** 注入数据库和可替换的模型价格解析器，成本计算不依赖供应商字段。 */
  constructor(
    private readonly database: Database,
    private readonly pricingResolver: PricingResolver = DEFAULT_MODEL_PRICING,
  ) {}

  /** 创建 started 调用记录并建立任务、Attempt 和可选 Artifact 的双向链路。 */
  async started(call: ModelCallStart): Promise<CallHandle> {
    const modelCallId = call.modelCallId ?? newObjectId("model_call");
    const startedAt = call.startedAt ?? utcNow();
    this.database.transaction((connection) => {
      ensureProjectWritable(connection, call.projectId);
      ensureProjectChild(
        connection,
        "execution_attempts",
        call.projectId,
        call.attemptId,
      );
      if (call.taskId) {
        ensureProjectChild(connection, "tasks", call.projectId, call.taskId);
      }
      connection
        .prepare(
          `INSERT INTO model_calls
           (id,project_id,task_id,execution_attempt_id,role,provider,model,started_at,
            ended_at,duration_ms,summary,error_code,input_tokens,output_tokens,cost_micros,
            trace_id,created_at,domain,config_version,span_id,input_summary,output_summary,
            timeout_ms,timed_out,retry_count,artifact_ref,redaction_status,final_status,
            total_tokens)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          modelCallId,
          call.projectId,
          call.taskId,
          call.attemptId,
          call.role,
          call.provider,
          call.modelName,
          startedAt,
          null,
          null,
          "model call started",
          null,
          null,
          null,
          null,
          call.trace.traceId,
          startedAt,
          call.domain,
          call.configVersion,
          call.trace.spanId,
          call.inputSummary.value,
          "",
          call.timeoutMs,
          0,
          0,
          call.artifactRef ?? null,
          call.inputSummary.status,
          "started",
          null,
        );
      this.createTraceLinks(connection, call, modelCallId);
      this.appendCallEvent(connection, call, modelCallId, "ModelCallStarted", 0, {
        result: "started",
        inputSummary: call.inputSummary.value,
      });
    });
    return { modelCallId, startedAt };
  }

  /** 原子写入成功结果、Token、成本、重试和结构化输出摘要。 */
  async finished(
    handle: CallHandle,
    result: ModelCallResult,
  ): Promise<void> {
    const endedAt = result.endedAt ?? utcNow();
    this.database.transaction((connection) => {
      const row = this.startedRow(connection, handle.modelCallId);
      const durationMs = durationBetween(handle.startedAt, endedAt);
      const call = updateResult(
        connection,
        handle.modelCallId,
        endedAt,
        durationMs,
        result,
        this.pricingResolver(row.provider, row.model),
      );
      this.appendCallEvent(
        connection,
        call,
        handle.modelCallId,
        "ModelCallFinished",
        1,
        { result: "succeeded", outputSummary: result.outputSummary.value },
      );
    });
  }

  /** 原子写入归一化失败；失败原因、影响和重试次数保留但不写入供应商原文。 */
  async failed(handle: CallHandle, failure: ModelCallFailure): Promise<void> {
    const endedAt = failure.endedAt ?? utcNow();
    this.database.transaction((connection) => {
      const row = this.startedRow(connection, handle.modelCallId);
      const durationMs = durationBetween(handle.startedAt, endedAt);
      const errorSummary = summarizeModelError(failure.error.code);
      // 修改日期：2026-08-16
      // 修改原因：脱敏失败必须在调用控制台显式标记为 failed，不能被安全错误摘要的 passed 状态掩盖。
      const redactionStatus =
        failure.error.code === "REDACTION_FAILED"
          ? "failed"
          : errorSummary.status;
      const updated = connection
        .prepare(
          `UPDATE model_calls
           SET ended_at=?,duration_ms=?,summary=?,error_code=?,timeout_ms=?,timed_out=?,
               retry_count=?,redaction_status=?,final_status=?
           WHERE id=? AND final_status='started'`,
        )
        .run(
          endedAt,
          durationMs,
          errorSummary.value,
          failure.error.code,
          row.timeout_ms,
          failure.error.timedOut ? 1 : 0,
          failure.retryCount,
          redactionStatus,
          "failed",
          handle.modelCallId,
        );
      if (updated.changes !== 1) {
        throw new Error("model call is already finalized");
      }
      const finalized = connection
        .prepare("SELECT * FROM model_calls WHERE id=?")
        .get(handle.modelCallId) as ModelCallRow;
      this.appendCallEvent(
        connection,
        finalized,
        handle.modelCallId,
        "ModelCallFailed",
        1,
        { result: "failed", errorCode: failure.error.code },
      );
    });
  }

  /** 查询调用控制台记录并按字段聚合成本，返回值不含 secretRef。 */
  list(query: ModelCallQuery = {}): {
    items: ModelCallView[];
    aggregate: ModelCallAggregate[];
  } {
    // 修改日期：2026-08-16
    // 修改原因：调用查询也可能被非 HTTP 消费者直接调用，必须在 recorder 边界限制资源消耗。
    if (
      query.limit !== undefined &&
      (!Number.isSafeInteger(query.limit) || query.limit < 1)
    ) {
      throw new Error("model call query limit must be a positive safe integer");
    }
    const clauses: string[] = [];
    const values: unknown[] = [];
    addFilter(clauses, values, "project_id", query.projectId);
    addFilter(clauses, values, "task_id", query.taskId);
    addFilter(clauses, values, "trace_id", query.traceId);
    addFilter(clauses, values, "domain", query.domain);
    addFilter(clauses, values, "model", query.model);
    const limit = Math.min(query.limit ?? 500, 500);
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM model_calls
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...values, limit) as ModelCallRow[];
    const items = rows.map(modelCallView);
    return { items, aggregate: aggregateModelCalls(items) };
  }

  /** 生成模型调用到 Attempt、Task 和 Artifact 的项目范围 TraceLink。 */
  private createTraceLinks(
    connection: BetterSqlite3.Database,
    call: ModelCallStart,
    modelCallId: string,
  ): void {
    const insert = connection.prepare(
      `INSERT INTO trace_links
       (id,project_id,source_type,source_id,target_type,target_id,relation,trace_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    insert.run(
      newObjectId("trace_link"),
      call.projectId,
      "model_call",
      modelCallId,
      "execution_attempt",
      call.attemptId,
      "belongs_to_attempt",
      call.trace.traceId,
      call.startedAt ?? utcNow(),
    );
    if (call.taskId) {
      insert.run(
        newObjectId("trace_link"),
        call.projectId,
        "model_call",
        modelCallId,
        "task",
        call.taskId,
        "belongs_to_task",
        call.trace.traceId,
        call.startedAt ?? utcNow(),
      );
    }
    if (
      call.artifactRef &&
      connection
        .prepare("SELECT 1 FROM artifacts WHERE project_id=? AND id=?")
        .get(call.projectId, call.artifactRef)
    ) {
      insert.run(
        newObjectId("trace_link"),
        call.projectId,
        "model_call",
        modelCallId,
        "artifact",
        call.artifactRef,
        "references_artifact",
        call.trace.traceId,
        call.startedAt ?? utcNow(),
      );
    }
  }

  /** 追加不可变模型调用事件，保证事件与调用记录使用同一事务。 */
  private appendCallEvent(
    connection: BetterSqlite3.Database,
    call: ModelCallStart | ModelCallRow,
    modelCallId: string,
    eventType: string,
    expectedVersion: number,
    payload: Record<string, unknown>,
  ): void {
    const traceId = "trace" in call ? call.trace.traceId : call.trace_id;
    const attemptId = "attemptId" in call ? call.attemptId : call.execution_attempt_id;
    const outputSummary = payload.outputSummary;
    const safeOutputSummary =
      typeof outputSummary === "string"
        ? outputSummary
        : outputSummary && typeof outputSummary === "object"
          ? (outputSummary as Record<string, unknown>)
          : String(payload.result ?? "");
    this.eventStore.append(connection, "model_call", modelCallId, expectedVersion, [
      {
        eventType,
        aggregateType: "model_call",
        aggregateId: modelCallId,
        payload,
        inputSummary: "model call summary is redacted",
        outputSummary: safeOutputSummary,
        result: String(payload.result ?? "success"),
        failure: eventType === "ModelCallFailed" ? String(payload.errorCode) : null,
        retryCount: "retry_count" in call ? call.retry_count : 0,
        durationMs: "duration_ms" in call ? call.duration_ms ?? 0 : 0,
        actor: { type: "worker", id: "model-gateway" },
        traceId,
        occurredAt: utcNow(),
        attemptId,
        rejectionReason: "model gateway completed the call lifecycle",
        redactionReason: "model gateway persisted summaries after redaction",
        eventCategory: "call",
      },
    ]);
  }

  /** 读取仍处于 started 状态的调用，并阻止重复完成或失败写入。 */
  private startedRow(
    connection: BetterSqlite3.Database,
    modelCallId: string,
  ): ModelCallRow {
    const row = connection
      .prepare("SELECT * FROM model_calls WHERE id=?")
      .get(modelCallId) as ModelCallRow | undefined;
    if (!row) throw new Error("model call does not exist");
    if (row.final_status !== "started") {
      throw new Error("model call is already finalized");
    }
    return row;
  }
}

/** 模型网关 recorder 公开的开始/完成/失败协议别名。 */
export interface ModelCallRecorder {
  started(call: ModelCallStart): Promise<CallHandle>;
  finished(handle: CallHandle, result: ModelCallResult): Promise<void>;
  failed(handle: CallHandle, failure: ModelCallFailure): Promise<void>;
}

type ModelCallRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  execution_attempt_id: string;
  role: string;
  provider: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  summary: string;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  trace_id: string;
  created_at: string;
  domain: string;
  config_version: string;
  span_id: string;
  input_summary: string;
  output_summary: string;
  timeout_ms: number | null;
  timed_out: number;
  retry_count: number;
  artifact_ref: string | null;
  redaction_status: string;
  final_status: string;
  total_tokens: number | null;
};

/** 将完成结果写入调用表，并返回事件追加所需的最新调用行。 */
function updateResult(
  connection: BetterSqlite3.Database,
  modelCallId: string,
  endedAt: string,
  durationMs: number,
  result: ModelCallResult,
  pricing: ReturnType<PricingResolver>,
): ModelCallRow {
  const costMicros =
    result.costMicros === undefined
      ? calculateCostMicros(result.usage, pricing)
      : normalizeCostMicros(result.costMicros);
  const updated = connection
    .prepare(
      `UPDATE model_calls
       SET ended_at=?,duration_ms=?,summary=?,output_summary=?,input_tokens=?,
           output_tokens=?,total_tokens=?,cost_micros=?,retry_count=?,artifact_ref=?,
           redaction_status=?,final_status='succeeded'
       WHERE id=? AND final_status='started'`,
    )
    .run(
      endedAt,
      durationMs,
      result.outputSummary.value,
      result.outputSummary.value,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.totalTokens,
      costMicros,
      result.retryCount,
      result.artifactRef ?? null,
      result.outputSummary.status,
      modelCallId,
    );
  if (updated.changes !== 1) {
    throw new Error("model call is already finalized");
  }
  return connection
    .prepare("SELECT * FROM model_calls WHERE id=?")
    .get(modelCallId) as ModelCallRow;
}

/** 校验外部传入的成本为非负安全整数，避免污染成本聚合。 */
function normalizeCostMicros(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("costMicros must be a non-negative safe integer");
  }
  return value;
}

/** 计算合法 UTC 时间之间的非负毫秒耗时。 */
function durationBetween(startedAt: string, endedAt: string): number {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error("model call timestamps are invalid");
  }
  return duration;
}

/** 添加固定列过滤条件，拒绝让外部输入进入 SQL 标识符位置。 */
function addFilter(
  clauses: string[],
  values: unknown[],
  column: string,
  value: string | null | undefined,
): void {
  if (value) {
    clauses.push(`${column}=?`);
    values.push(value);
  }
}

/** 将数据库模型调用行转换为不含凭据的控制台视图。 */
function modelCallView(row: ModelCallRow): ModelCallView {
  return {
    modelCallId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    attemptId: row.execution_attempt_id,
    domain: row.domain,
    role: row.role,
    provider: row.provider,
    modelName: row.model,
    configVersion: Number(row.config_version),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    timeoutMs: row.timeout_ms,
    timedOut: Boolean(row.timed_out),
    retryCount: row.retry_count,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    errorCode: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costMicros: row.cost_micros,
    artifactRef: row.artifact_ref,
    redactionStatus: row.redaction_status,
    finalStatus: row.final_status,
    traceId: row.trace_id,
    spanId: row.span_id,
  };
}

/** 按领域和模型聚合调用次数、错误率、Token、成本、耗时和重试。 */
function aggregateModelCalls(items: ModelCallView[]): ModelCallAggregate[] {
  const groups = new Map<string, ModelCallView[]>();
  for (const item of items) {
    const key = `${item.domain}:${item.modelName}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const completed = group.filter((item) => item.finalStatus === "succeeded");
    const durationValues = group
      .map((item) => item.durationMs)
      .filter((value): value is number => value !== null);
    const errorCount = group.filter((item) => item.finalStatus === "failed").length;
    const totalCost = group.reduce((sum, item) => sum + (item.costMicros ?? 0), 0);
    // 修改日期：2026-08-16
    // 修改原因：已完成任务成本只能统计成功调用成本，不能把同组失败调用成本一并计入。
    const completedTaskCostMicros = completed.reduce(
      (sum, item) => sum + (item.costMicros ?? 0),
      0,
    );
    return {
      key,
      domain: group[0]?.domain ?? "",
      modelName: group[0]?.modelName ?? "",
      callCount: group.length,
      averageDurationMs: durationValues.length
        ? durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length
        : 0,
      errorRate: group.length ? errorCount / group.length : 0,
      inputTokens: group.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
      outputTokens: group.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
      totalTokens: group.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
      costMicros: totalCost,
      retryCount: group.reduce((sum, item) => sum + item.retryCount, 0),
      completedTaskCostMicros,
    };
  });
}
