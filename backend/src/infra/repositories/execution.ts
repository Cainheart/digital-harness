import BetterSqlite3 from "better-sqlite3";
import {
  ExecutionAttempt,
  ModelCall,
  Notification,
  ToolCall,
} from "../../domain/entities.js";
import { NotFoundError } from "../../domain/errors.js";
import {
  ensureProjectChild,
  ensureProjectWritable,
  jsonValue,
} from "./common.js";

/** 保存 Attempt、ModelCall、ToolCall 和 Notification 事实的仓储。 */
export class ExecutionRepository {
  /** 创建执行尝试并固定模型配置版本。 */
  createAttempt(
    connection: BetterSqlite3.Database,
    attempt: ExecutionAttempt,
  ): void {
    ensureProjectWritable(connection, attempt.projectId);
    ensureProjectChild(connection, "tasks", attempt.projectId, attempt.taskId);
    connection
      .prepare(
        "INSERT INTO execution_attempts (id,project_id,task_id,role,model_config_version,model_domain,model_provider,model_name,model_secret_ref,model_timeout_ms,model_retry_max_attempts,workspace_ref,worker_lease_id,status,started_at,ended_at,retry_of_attempt_id,retry_count,trace_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        attempt.id,
        attempt.projectId,
        attempt.taskId,
        attempt.role,
        attempt.modelConfigVersion,
        attempt.modelDomain ?? null,
        attempt.modelProvider ?? null,
        attempt.modelName ?? null,
        attempt.modelSecretRef ?? null,
        attempt.modelTimeoutMs ?? null,
        attempt.modelRetryMaxAttempts ?? null,
        attempt.workspaceRef,
        attempt.workerLeaseId,
        attempt.status,
        attempt.startedAt,
        attempt.endedAt,
        attempt.retryOfAttemptId,
        attempt.retryCount,
        attempt.traceId,
        attempt.version,
      );
  }
  /** 创建脱敏模型调用记录。 */
  createModelCall(connection: BetterSqlite3.Database, call: ModelCall): void {
    ensureProjectWritable(connection, call.projectId);
    ensureProjectChild(
      connection,
      "execution_attempts",
      call.projectId,
      call.executionAttemptId,
    );
    connection
      .prepare(
        "INSERT INTO model_calls (id,project_id,task_id,execution_attempt_id,role,provider,model,started_at,ended_at,duration_ms,summary,error_code,input_tokens,output_tokens,cost_micros,trace_id,created_at,domain,config_version,span_id,input_summary,output_summary,timeout_ms,timed_out,retry_count,artifact_ref,redaction_status,final_status,total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        call.id,
        call.projectId,
        call.taskId,
        call.executionAttemptId,
        call.role,
        call.provider,
        call.model,
        call.startedAt,
        call.endedAt,
        call.durationMs,
        call.summary,
        call.errorCode,
        call.inputTokens,
        call.outputTokens,
        call.costMicros,
        call.traceId,
        call.startedAt,
        call.domain ?? "product",
        call.configVersion ?? 0,
        call.spanId ?? "",
        call.inputSummary ?? "",
        call.outputSummary ?? "",
        call.timeoutMs ?? null,
        call.timedOut ? 1 : 0,
        call.retryCount ?? 0,
        call.artifactRef ?? null,
        call.redactionStatus ?? "passed",
        call.finalStatus ?? "finished",
        call.totalTokens ?? (call.inputTokens ?? 0) + (call.outputTokens ?? 0),
      );
  }
  /** 创建脱敏工具调用记录。 */
  createToolCall(connection: BetterSqlite3.Database, call: ToolCall): void {
    ensureProjectWritable(connection, call.projectId);
    ensureProjectChild(
      connection,
      "execution_attempts",
      call.projectId,
      call.executionAttemptId,
    );
    connection
      .prepare(
        "INSERT INTO tool_calls (id,project_id,task_id,execution_attempt_id,role,tool_name,started_at,ended_at,duration_ms,summary,error_code,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        call.id,
        call.projectId,
        call.taskId,
        call.executionAttemptId,
        call.role,
        call.toolName,
        call.startedAt,
        call.endedAt,
        call.durationMs,
        call.summary,
        call.errorCode,
        call.traceId,
        call.startedAt,
      );
  }
  /** 创建通知事实。 */
  createNotification(
    connection: BetterSqlite3.Database,
    notification: Notification,
  ): void {
    ensureProjectWritable(connection, notification.projectId);
    ensureProjectChild(
      connection,
      "domain_events",
      notification.projectId,
      notification.eventId,
      "event_id",
    );
    connection
      .prepare(
        "INSERT INTO notifications (id,project_id,event_id,notification_type,severity,subject_type,subject_id,unread,pending,handled_by,action,created_at,read_at,handled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        notification.id,
        notification.projectId,
        notification.eventId,
        notification.notificationType,
        notification.severity,
        notification.subjectType,
        notification.subjectId,
        notification.unread ? 1 : 0,
        notification.pending ? 1 : 0,
        notification.handledBy,
        notification.action,
        notification.createdAt,
        notification.readAt,
        notification.handledAt,
      );
  }
  /** 读取执行尝试。 */
  getAttempt(connection: BetterSqlite3.Database, id: string): ExecutionAttempt {
    const row = connection
      .prepare("SELECT * FROM execution_attempts WHERE id=?")
      .get(id) as AttemptRow | undefined;
    if (!row) throw new NotFoundError("ExecutionAttempt 不存在");
    return attemptFromRow(row);
  }
  /** 读取模型调用。 */
  getModelCall(connection: BetterSqlite3.Database, id: string): ModelCall {
    const row = connection
      .prepare("SELECT * FROM model_calls WHERE id=?")
      .get(id) as ModelCallRow | undefined;
    if (!row) throw new NotFoundError("ModelCall 不存在");
    return modelCallFromRow(row);
  }
  /** 读取工具调用。 */
  getToolCall(connection: BetterSqlite3.Database, id: string): ToolCall {
    const row = connection
      .prepare("SELECT * FROM tool_calls WHERE id=?")
      .get(id) as ToolCallRow | undefined;
    if (!row) throw new NotFoundError("ToolCall 不存在");
    return toolCallFromRow(row);
  }
  /** 读取通知。 */
  getNotification(
    connection: BetterSqlite3.Database,
    id: string,
  ): Notification {
    const row = connection
      .prepare("SELECT * FROM notifications WHERE id=?")
      .get(id) as NotificationRow | undefined;
    if (!row) throw new NotFoundError("Notification 不存在");
    return notificationFromRow(row);
  }
}
type AttemptRow = {
  id: string;
  project_id: string;
  task_id: string;
  role: string;
  model_config_version: string;
  workspace_ref: string | null;
  worker_lease_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  retry_of_attempt_id: string | null;
  retry_count: number;
  trace_id: string;
  version: number;
  model_domain: string | null;
  model_provider: string | null;
  model_name: string | null;
  model_secret_ref: string | null;
  model_timeout_ms: number | null;
  model_retry_max_attempts: number | null;
};
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
type ToolCallRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  execution_attempt_id: string;
  role: string;
  tool_name: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  summary: string;
  error_code: string | null;
  trace_id: string;
  created_at: string;
};
type NotificationRow = {
  id: string;
  project_id: string;
  event_id: string;
  notification_type: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  unread: number;
  pending: number;
  handled_by: string | null;
  action: string | null;
  created_at: string;
  read_at: string | null;
  handled_at: string | null;
};
function attemptFromRow(row: AttemptRow): ExecutionAttempt {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    role: row.role,
    modelConfigVersion: row.model_config_version,
    workspaceRef: row.workspace_ref,
    workerLeaseId: row.worker_lease_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    retryOfAttemptId: row.retry_of_attempt_id,
    retryCount: row.retry_count,
    traceId: row.trace_id,
    version: row.version,
    modelDomain: row.model_domain,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    modelSecretRef: row.model_secret_ref,
    modelTimeoutMs: row.model_timeout_ms,
    modelRetryMaxAttempts: row.model_retry_max_attempts,
  };
}
function modelCallFromRow(row: ModelCallRow): ModelCall {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    executionAttemptId: row.execution_attempt_id,
    role: row.role,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    summary: row.summary,
    errorCode: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicros: row.cost_micros,
    traceId: row.trace_id,
    version: 1,
    domain: row.domain,
    configVersion: Number(row.config_version),
    spanId: row.span_id,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    timeoutMs: row.timeout_ms,
    timedOut: Boolean(row.timed_out),
    retryCount: row.retry_count,
    artifactRef: row.artifact_ref,
    redactionStatus: row.redaction_status,
    finalStatus: row.final_status,
    totalTokens: row.total_tokens,
  };
}
function toolCallFromRow(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    executionAttemptId: row.execution_attempt_id,
    role: row.role,
    toolName: row.tool_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    summary: row.summary,
    errorCode: row.error_code,
    traceId: row.trace_id,
    version: 1,
  };
}
function notificationFromRow(row: NotificationRow): Notification {
  return {
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    notificationType: row.notification_type,
    severity: row.severity,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    unread: Boolean(row.unread),
    pending: Boolean(row.pending),
    handledBy: row.handled_by,
    action: row.action,
    createdAt: row.created_at,
    readAt: row.read_at,
    handledAt: row.handled_at,
    version: 1,
  };
}
