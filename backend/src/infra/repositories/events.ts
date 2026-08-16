import BetterSqlite3 from "better-sqlite3";
import { newObjectId, utcNow } from "../../domain/common.js";
import { DomainEvent, DomainEventDraft, materializeEvent, parseEventDraft, AppendResult, validateAppendResult } from "../../domain/events.js";
import { InvalidArgumentError, VersionConflictError } from "../../domain/errors.js";
import { OutboxRepository } from "../outbox.js";
import { jsonText, jsonValue } from "./common.js";

/** 追加领域事件、分配全局序号并同步写 Outbox 的 SQLite EventStore。 */
export class SqliteEventStore {
  constructor(private readonly outbox = new OutboxRepository()) {}
  /** 按聚合 expectedVersion 原子追加事件；历史事件正文永不更新。 */
  append(connection: BetterSqlite3.Database, aggregateType: string, aggregateId: string, expectedVersion: number, drafts: DomainEventDraft[]): AppendResult {
    if (drafts.length === 0) throw new InvalidArgumentError("a command must append at least one domain event");
    const currentRow = connection.prepare("SELECT COALESCE(MAX(aggregate_version),0) AS version FROM domain_events WHERE aggregate_type=? AND aggregate_id=?").get(aggregateType, aggregateId) as { version: number };
    const current = currentRow.version;
    if (current !== expectedVersion) throw new VersionConflictError("对象版本冲突，未覆盖最新事实", { data: { aggregateType, aggregateId, expectedVersion, actualVersion: current } });
    let sequence = (connection.prepare("SELECT COALESCE(MAX(global_sequence),0) AS sequence FROM domain_events").get() as { sequence: number }).sequence;
    const events: DomainEvent[] = [];
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = parseEventDraft(drafts[index]); const event = materializeEvent(draft, expectedVersion + index + 1, ++sequence); const projectId = this.projectId(connection, aggregateType, aggregateId, draft.payload);
      connection.prepare("INSERT INTO domain_events (event_id,project_id,event_type,aggregate_type,aggregate_id,aggregate_version,global_sequence,occurred_at,duration_ms,actor_type,actor_id,input_summary,output_summary,result,failure,retry_count,trace_id,attempt_id,rejection_reason,redaction_reason,event_category,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(event.eventId, projectId, event.eventType, event.aggregateType, event.aggregateId, event.aggregateVersion, event.globalSequence, event.occurredAt, event.durationMs, event.actor.type, event.actor.id, jsonText(event.inputSummary), jsonText(event.outputSummary), event.result, event.failure, event.retryCount, event.traceId, event.attemptId, event.rejectionReason, event.redactionReason, event.eventCategory, jsonText(event.payload));
      this.outbox.enqueue(connection, { projectId, eventId: event.eventId, topic: event.eventType, payload: event.payload }); events.push(event);
    }
    return validateAppendResult({ aggregateType, aggregateId, expectedVersion, aggregateVersion: expectedVersion + events.length, events });
  }
  /** 通过稳定 eventId 游标读取已提交事件。 */
  listAfter(connection: BetterSqlite3.Database, eventId: string | null, projectId: string | null = null, limit = 10000): DomainEvent[] { const cursor = eventId ? (connection.prepare("SELECT global_sequence FROM domain_events WHERE event_id=?").get(eventId) as { global_sequence: number } | undefined)?.global_sequence ?? 0 : 0; const rows = projectId ? connection.prepare("SELECT * FROM domain_events WHERE global_sequence>? AND project_id=? ORDER BY global_sequence LIMIT ?").all(cursor, projectId, limit) : connection.prepare("SELECT * FROM domain_events WHERE global_sequence>? ORDER BY global_sequence LIMIT ?").all(cursor, limit); return (rows as EventRow[]).map(fromRow); }
  /** 查询某一聚合的完整事件链。 */
  listForAggregate(connection: BetterSqlite3.Database, aggregateType: string, aggregateId: string): DomainEvent[] { return (connection.prepare("SELECT * FROM domain_events WHERE aggregate_type=? AND aggregate_id=? ORDER BY aggregate_version").all(aggregateType, aggregateId) as EventRow[]).map(fromRow); }
  /** 统计某一聚合已经提交的事件数。 */
  countForAggregate(connection: BetterSqlite3.Database, aggregateType: string, aggregateId: string): number { return (connection.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_type=? AND aggregate_id=?").get(aggregateType, aggregateId) as { count: number }).count; }
  /** 从事件 payload 或所有 Task 2 项目对象中解析 project_id，避免事件脱离项目范围。 */
  private projectId(connection: BetterSqlite3.Database, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): string | null { if (aggregateType === "project") return aggregateId; if (typeof payload.projectId === "string") return payload.projectId; const tables: Record<string, { table: string; idColumn: string }> = { task: { table: "tasks", idColumn: "id" }, artifact: { table: "artifacts", idColumn: "id" }, artifact_version: { table: "artifact_versions", idColumn: "id" }, approval: { table: "approvals", idColumn: "id" }, review: { table: "reviews", idColumn: "id" }, test_case: { table: "test_cases", idColumn: "id" }, test_run: { table: "test_runs", idColumn: "id" }, defect: { table: "defects", idColumn: "id" }, execution_attempt: { table: "execution_attempts", idColumn: "id" }, model_call: { table: "model_calls", idColumn: "id" }, tool_call: { table: "tool_calls", idColumn: "id" }, notification: { table: "notifications", idColumn: "id" }, domain_event: { table: "domain_events", idColumn: "event_id" } }; const descriptor = tables[aggregateType]; if (!descriptor) return null; const row = connection.prepare(`SELECT project_id FROM ${descriptor.table} WHERE ${descriptor.idColumn}=?`).get(aggregateId) as { project_id: string | null } | undefined; return row?.project_id ?? null; }
}

/** 为异步 Worker 提供 Promise 形式的 EventStore 接口。 */
export class AsyncEventStoreAdapter {
  constructor(private readonly database: { connection: BetterSqlite3.Database }, private readonly store = new SqliteEventStore()) {}
  /** 异步追加领域事件。 */
  async append(aggregateType: string, aggregateId: string, expectedVersion: number, drafts: DomainEventDraft[]): Promise<AppendResult> { return this.store.append(this.database.connection, aggregateType, aggregateId, expectedVersion, drafts); }
  /** 异步读取事件。 */
  async listAfter(eventId: string | null, projectId?: string | null): Promise<DomainEvent[]> { return this.store.listAfter(this.database.connection, eventId, projectId); }
}
type EventRow = { event_id: string; project_id: string | null; event_type: string; aggregate_type: string; aggregate_id: string; aggregate_version: number; global_sequence: number; occurred_at: string; duration_ms: number; actor_type: string; actor_id: string; input_summary: string; output_summary: string; result: string; failure: string | null; retry_count: number; trace_id: string; attempt_id: string | null; rejection_reason: string | null; redaction_reason: string | null; event_category: "ordinary" | "call" | "security"; payload_json: string };
function fromRow(row: EventRow): DomainEvent { return { eventId: row.event_id, eventType: row.event_type, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version, globalSequence: row.global_sequence, payload: jsonValue(row.payload_json), inputSummary: jsonValue(row.input_summary), outputSummary: jsonValue(row.output_summary), result: row.result, failure: row.failure, retryCount: row.retry_count, durationMs: row.duration_ms, actor: { type: row.actor_type, id: row.actor_id }, traceId: row.trace_id, occurredAt: row.occurred_at, attemptId: row.attempt_id, rejectionReason: row.rejection_reason, redactionReason: row.redaction_reason, eventCategory: row.event_category }; }
