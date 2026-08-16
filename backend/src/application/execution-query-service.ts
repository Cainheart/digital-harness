import type BetterSqlite3 from "better-sqlite3";
import { NotFoundError } from "../domain/errors.js";
import { redact, redactJsonValue } from "../security/redaction.js";
import type { Database } from "../infra/database.js";

/** 执行控制台的分页筛选条件；分页在数据库查询层生效。 */
export type ExecutionQuery = {
  projectId?: string | null;
  taskId?: string | null;
  workerId?: string | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  traceId?: string | null;
  page: number;
  pageSize: number;
};

/** 执行控制台列表和详情共用的摘要字段。 */
export type ExecutionSummary = {
  executionId: string;
  projectId: string;
  taskId: string;
  role: string;
  status: string;
  traceId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  modelProvider: string | null;
  modelName: string | null;
  toolCallCount: number;
  commandCount: number;
  testCount: number;
  errorCount: number;
  retryCount: number;
};

/** 将真实执行尝试、模型账本、工具、测试、事件和产物聚合成只读证据。 */
export class ExecutionQueryService {
  /** 绑定只读查询使用的 SQLite 连接。 */
  constructor(private readonly database: Database) {}

  /** 分页返回执行摘要，避免把项目全部日志一次性送入前端。 */
  list(query: ExecutionQuery): {
    items: ExecutionSummary[];
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  } {
    const connection = this.database.connection;
    const { where, values } = executionWhere(query);
    const total = (
      connection
        .prepare(`SELECT COUNT(*) AS count FROM execution_attempts a ${where}`)
        .get(...values) as { count: number }
    ).count;
    const offset = (query.page - 1) * query.pageSize;
    const rows = connection
      .prepare(
        `SELECT a.id,a.project_id,a.task_id,a.role,a.status,a.trace_id,
                a.started_at,a.ended_at,a.model_provider,a.model_name,
                a.retry_count,
                (SELECT COUNT(*)
                 FROM tool_calls t
                 WHERE t.execution_attempt_id=a.id) AS tool_count,
                (SELECT COUNT(*)
                 FROM test_runs r
                 WHERE r.task_id=a.task_id AND r.project_id=a.project_id) AS test_count,
                (SELECT COUNT(*)
                 FROM domain_events e
                 WHERE e.attempt_id=a.id
                   AND e.result IN ('failed','blocked','rejected')) AS error_count,
                (SELECT COUNT(*)
                 FROM domain_events e
                 WHERE e.attempt_id=a.id
                   AND e.event_type LIKE '%Command%') AS command_count
         FROM execution_attempts a ${where}
         ORDER BY a.started_at DESC,a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, query.pageSize, offset) as ExecutionRow[];
    return {
      items: rows.map(summaryFromRow),
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: offset + rows.length < total,
    };
  }

  /** 返回单次执行的完整证据索引，并按字段脱敏摘要和绝对路径。 */
  get(executionId: string, projectId?: string | null): Record<string, unknown> {
    const connection = this.database.connection;
    const row = connection
      .prepare("SELECT * FROM execution_attempts WHERE id=?")
      .get(executionId) as ExecutionRow | undefined;
    if (!row || (projectId && row.project_id !== projectId)) {
      throw new NotFoundError("执行记录不存在或不属于指定项目");
    }
    const summary = summaryFromRow(row);
    const modelUsage = connection
      .prepare(
        `SELECT provider,model,
                MIN(started_at) AS requested_at,
                MAX(ended_at) AS responded_at,
                COALESCE(SUM(duration_ms),0) AS duration_ms,
                COALESCE(SUM(input_tokens),0) AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0) AS total_tokens,
                COALESCE(SUM(cost_micros),0) AS cost_micros,
                COUNT(*) AS call_count
         FROM model_calls WHERE execution_attempt_id=? GROUP BY provider,model
         ORDER BY requested_at ASC`,
      )
      .all(executionId) as ModelUsageRow[];
    const toolCalls = connection
      .prepare(
        `SELECT id,tool_name,started_at,ended_at,duration_ms,summary,error_code,trace_id
         FROM tool_calls WHERE execution_attempt_id=? ORDER BY started_at ASC,id ASC`,
      )
      .all(executionId) as ToolRow[];
    const commands = connection
      .prepare(
        `SELECT event_id,event_type,occurred_at,duration_ms,result,failure,
                input_summary,output_summary,trace_id,retry_count
         FROM domain_events
         WHERE attempt_id=? AND event_type LIKE '%Command%'
         ORDER BY global_sequence ASC`,
      )
      .all(executionId) as EventRow[];
    const errors = connection
      .prepare(
        `SELECT event_id,event_type,occurred_at,result,failure,retry_count,
                rejection_reason,trace_id
         FROM domain_events
         WHERE attempt_id=? AND (result IN ('failed','blocked','rejected') OR failure IS NOT NULL)
         ORDER BY global_sequence ASC`,
      )
      .all(executionId) as ErrorRow[];
    const tests = connection
      .prepare(
        `SELECT id,test_case_id,command_or_steps,environment_json,started_at,
                ended_at,actual_result,exit_code,status,evidence_version_id,trace_id
         FROM test_runs WHERE project_id=? AND task_id=? ORDER BY started_at ASC,id ASC`,
      )
      .all(row.project_id, row.task_id) as TestRow[];
    const artifacts = connection
      .prepare(
        `SELECT DISTINCT a.id,a.name,a.artifact_type,a.status,a.task_id,
                av.id AS version_id,av.version_number,av.created_at,av.sha256,av.size_bytes
         FROM artifacts a
         LEFT JOIN artifact_versions av ON av.artifact_id=a.id
         LEFT JOIN trace_links l ON l.project_id=a.project_id
           AND ((l.source_type='artifact' AND l.source_id=a.id)
             OR (l.target_type='artifact' AND l.target_id=a.id))
         WHERE a.project_id=? AND (a.task_id=? OR l.source_id=? OR l.target_id=? )
         ORDER BY av.created_at ASC,a.id ASC`,
      )
      .all(row.project_id, row.task_id, executionId, executionId) as ArtifactRow[];
    const timeline = this.timeline(executionId);
    const traceLinks = connection
      .prepare(
        `SELECT id,source_type,source_id,target_type,target_id,relation,trace_id,created_at
         FROM trace_links WHERE project_id=? AND trace_id=? ORDER BY created_at ASC,id ASC`,
      )
      .all(row.project_id, row.trace_id) as TraceLinkRow[];

    return {
      ...summary,
      businessContext: {
        projectId: row.project_id,
        taskId: row.task_id,
        role: row.role,
        executionPurpose: "受授权任务执行和验证",
      },
      modelUsage: modelUsage.map(modelUsageView),
      toolCalls: toolCalls.map(toolCallView),
      commands: commands.map(commandView),
      tests: testSummary(tests),
      testRuns: tests.map(testView),
      errors: errors.map(errorView),
      retryCount: row.retry_count,
      artifacts: artifacts.map(artifactView),
      traceLinkIds: traceLinks.map((link) => link.id),
      timeline,
    };
  }

  /** 按事件序号返回单次执行时间线，重复事件不会被数据库聚合重复返回。 */
  timeline(executionId: string): Array<Record<string, unknown>> {
    this.assertExecution(executionId);
    const rows = this.database.connection
      .prepare(
        `SELECT event_id,event_type,aggregate_type,aggregate_id,occurred_at,
                duration_ms,result,failure,retry_count,trace_id,input_summary,
                output_summary,redaction_reason,global_sequence
         FROM domain_events WHERE attempt_id=? ORDER BY global_sequence ASC,event_id ASC`,
      )
      .all(executionId) as TimelineRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      entityType: row.aggregate_type,
      entityId: row.aggregate_id,
      occurredAt: row.occurred_at,
      durationMs: row.duration_ms,
      result: row.result,
      failure: row.failure ? redact(row.failure) : null,
      retryCount: row.retry_count,
      traceId: row.trace_id,
      inputSummary: safeSummary(row.input_summary),
      outputSummary: safeSummary(row.output_summary),
      redactionReason: row.redaction_reason,
      projectionVersion: row.global_sequence,
    }));
  }

  /** 确认时间线查询对应真实执行记录，避免不存在的执行被误显示为空。 */
  private assertExecution(executionId: string): void {
    const found = this.database.connection
      .prepare("SELECT 1 FROM execution_attempts WHERE id=?")
      .get(executionId);
    if (!found) throw new NotFoundError("执行记录不存在");
  }

  /** 返回项目范围内当前执行关联的产物索引，不返回文件正文。 */
  listArtifacts(executionId: string, projectId?: string | null): Array<Record<string, unknown>> {
    const detail = this.get(executionId, projectId);
    return detail.artifacts as Array<Record<string, unknown>>;
  }
}

type ExecutionRow = {
  id: string;
  project_id: string;
  task_id: string;
  role: string;
  status: string;
  trace_id: string;
  started_at: string;
  ended_at: string | null;
  model_provider: string | null;
  model_name: string | null;
  retry_count: number;
  tool_count?: number;
  command_count?: number;
  test_count?: number;
  error_count?: number;
};
type ModelUsageRow = {
  provider: string;
  model: string;
  requested_at: string;
  responded_at: string | null;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_micros: number;
  call_count: number;
};
type ToolRow = {
  id: string;
  tool_name: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  summary: string;
  error_code: string | null;
  trace_id: string;
};
type EventRow = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  duration_ms: number;
  result: string;
  failure: string | null;
  input_summary: string;
  output_summary: string;
  trace_id: string;
  retry_count: number;
};
type ErrorRow = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  result: string;
  failure: string | null;
  retry_count: number;
  rejection_reason: string | null;
  trace_id: string;
};
type TestRow = {
  id: string;
  test_case_id: string;
  command_or_steps: string;
  environment_json: string;
  started_at: string;
  ended_at: string | null;
  actual_result: string;
  exit_code: number | null;
  status: string;
  evidence_version_id: string | null;
  trace_id: string;
};
type ArtifactRow = {
  id: string;
  name: string;
  artifact_type: string;
  status: string;
  task_id: string | null;
  version_id: string | null;
  version_number: number | null;
  created_at: string;
  sha256: string | null;
  size_bytes: number | null;
};
type TraceLinkRow = { id: string };
type TimelineRow = EventRow & {
  aggregate_type: string;
  aggregate_id: string;
  redaction_reason: string | null;
  global_sequence: number;
};

/** 将固定字段映射到参数化 SQL 条件，拒绝动态列名和未声明过滤器。 */
function executionWhere(query: ExecutionQuery): {
  where: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];
  addFilter(clauses, values, "a.project_id", query.projectId);
  addFilter(clauses, values, "a.task_id", query.taskId);
  addFilter(clauses, values, "a.worker_lease_id", query.workerId);
  addFilter(clauses, values, "a.status", query.status);
  addFilter(clauses, values, "a.trace_id", query.traceId);
  if (query.from) {
    clauses.push("a.started_at >= ?");
    values.push(query.from);
  }
  if (query.to) {
    clauses.push("a.started_at <= ?");
    values.push(query.to);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

/** 添加一个非空等值过滤器；值始终通过 SQLite 参数绑定传入。 */
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

/** 将数据库行转换为不含凭据和绝对路径的执行摘要。 */
function summaryFromRow(row: ExecutionRow): ExecutionSummary {
  return {
    executionId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    role: row.role,
    status: row.status,
    traceId: row.trace_id,
    startedAt: row.started_at,
    finishedAt: row.ended_at,
    durationMs: row.ended_at ? Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at)) : null,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    toolCallCount: row.tool_count ?? 0,
    commandCount: row.command_count ?? 0,
    testCount: row.test_count ?? 0,
    errorCount: row.error_count ?? 0,
    retryCount: row.retry_count,
  };
}

/** 将模型调用账本转换为控制台展示字段并保留 Token/成本单位。 */
function modelUsageView(row: ModelUsageRow): Record<string, unknown> {
  return {
    provider: row.provider,
    model: row.model,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    estimatedCostMicros: row.cost_micros,
    currency: "USD",
    callCount: row.call_count,
  };
}

/** 将工具调用转换为参数和结果摘要，不暴露工具原始正文。 */
function toolCallView(row: ToolRow): Record<string, unknown> {
  return {
    toolCallId: row.id,
    toolName: row.tool_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    parameterSummary: redact(row.summary),
    resultSummary: redact(row.summary),
    status: row.error_code ? "failed" : "succeeded",
    errorCode: row.error_code,
    traceId: row.trace_id,
  };
}

/** 将命令事件转换为时间线摘要，并继续执行统一脱敏。 */
function commandView(row: EventRow): Record<string, unknown> {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    startedAt: row.occurred_at,
    durationMs: row.duration_ms,
    status: row.result,
    commandSummary: safeSummary(row.input_summary),
    outputSummary: safeSummary(row.output_summary),
    exitCode: null,
    error: row.failure ? redact(row.failure) : null,
    retryCount: row.retry_count,
    traceId: row.trace_id,
  };
}

/** 将错误事件转换为可审计的错误类型、重试和最终结论。 */
function errorView(row: ErrorRow): Record<string, unknown> {
  return {
    eventId: row.event_id,
    errorType: row.event_type,
    occurredAt: row.occurred_at,
    errorSummary: row.failure ? redact(row.failure) : row.rejection_reason,
    retryCount: row.retry_count,
    finalConclusion: row.result,
    traceId: row.trace_id,
  };
}

/** 将测试记录转换为脱敏验证证据。 */
function testView(row: TestRow): Record<string, unknown> {
  return {
    testRunId: row.id,
    testCaseId: row.test_case_id,
    commandOrSteps: redact(row.command_or_steps),
    environment: redactJsonValue(parseJson(row.environment_json)),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    actualResult: redact(row.actual_result),
    exitCode: row.exit_code,
    status: row.status,
    evidenceVersionId: row.evidence_version_id,
    traceId: row.trace_id,
  };
}

/** 计算测试通过、失败和总数摘要。 */
function testSummary(rows: TestRow[]): Record<string, unknown> {
  const passed = rows.filter((row) => ["passed", "PASS", "通过"].includes(row.status)).length;
  return { total: rows.length, passed, failed: rows.length - passed };
}

/** 返回产物索引和完整性字段，不读取或返回文件正文。 */
function artifactView(row: ArtifactRow): Record<string, unknown> {
  return {
    artifactId: row.id,
    name: row.name,
    type: row.artifact_type,
    status: row.status,
    taskId: row.task_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    createdAt: row.created_at,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
  };
}

/** 限长并脱敏事件摘要，避免大字段进入前端响应。 */
function safeSummary(value: string): string {
  return redact(value).slice(0, 2_000);
}

/** 解析历史 JSON 字段；坏数据返回可解释的不可用标记。 */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    return { unavailable: true, reason: "stored JSON is invalid" };
  }
}
