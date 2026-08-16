import BetterSqlite3 from "better-sqlite3";
import { newObjectId, utcNow } from "../domain/common.js";
import { ReadOnlyProjectError } from "../domain/errors.js";
import { jsonText, ensureProjectWritable } from "./repositories/common.js";

/** Outbox 消息的脱敏持久化模型。 */
export type OutboxMessage = {
  id: string;
  projectId: string | null;
  eventId: string;
  topic: string;
  payload: Record<string, unknown>;
  createdAt: string;
  publishedAt: string | null;
  status: string;
  retryCount: number;
  lastError: string | null;
  availableAt: string | null;
};
/** 在同一 SQLite 事务中创建、发布和重试 Outbox 消息。 */
export class OutboxRepository {
  /** 为已提交领域事件创建一条唯一 Outbox 消息。 */
  enqueue(
    connection: BetterSqlite3.Database,
    input: {
      projectId?: string | null;
      eventId: string;
      topic: string;
      payload: Record<string, unknown>;
      availableAt?: string | null;
    },
  ): OutboxMessage {
    if (input.projectId) ensureProjectWritable(connection, input.projectId);
    const message: OutboxMessage = {
      id: newObjectId("outbox"),
      projectId: input.projectId ?? null,
      eventId: input.eventId,
      topic: input.topic,
      payload: input.payload,
      createdAt: utcNow(),
      publishedAt: null,
      status: "pending",
      retryCount: 0,
      lastError: null,
      availableAt: input.availableAt ?? null,
    };
    connection
      .prepare(
        "INSERT INTO outbox_messages (id,project_id,event_id,topic,payload_json,created_at,published_at,status,retry_count,last_error,available_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        message.id,
        message.projectId,
        message.eventId,
        message.topic,
        jsonText(message.payload),
        message.createdAt,
        null,
        message.status,
        message.retryCount,
        null,
        message.availableAt,
      );
    return message;
  }
  /** 返回未发布且到达可用时间的消息。 */
  listUnpublished(
    connection: BetterSqlite3.Database,
    limit = 100,
  ): OutboxMessage[] {
    const rows = connection
      .prepare(
        "SELECT * FROM outbox_messages WHERE published_at IS NULL AND status IN ('pending','retry') AND (available_at IS NULL OR available_at<=?) ORDER BY created_at,id LIMIT ?",
      )
      .all(utcNow(), limit) as OutboxRow[];
    return rows.map(fromRow);
  }
  /** 标记消息已发布。 */
  markPublished(
    connection: BetterSqlite3.Database,
    messageId: string,
    publishedAt = utcNow(),
  ): OutboxMessage {
    const row = this.getRow(connection, messageId);
    if (row.project_id) ensureProjectWritable(connection, row.project_id);
    connection
      .prepare("UPDATE outbox_messages SET published_at=?,status=? WHERE id=?")
      .run(publishedAt, "published", messageId);
    return fromRow(this.getRow(connection, messageId));
  }
  /** 记录永久失败。 */
  markFailed(
    connection: BetterSqlite3.Database,
    messageId: string,
    error: string,
  ): OutboxMessage {
    const row = this.getRow(connection, messageId);
    if (row.project_id) ensureProjectWritable(connection, row.project_id);
    connection
      .prepare(
        "UPDATE outbox_messages SET status=?,last_error=?,retry_count=retry_count+1 WHERE id=?",
      )
      .run("failed", error, messageId);
    return fromRow(this.getRow(connection, messageId));
  }
  /** 安排一次可重复消费的重试。 */
  scheduleRetry(
    connection: BetterSqlite3.Database,
    messageId: string,
    availableAt: string,
    error: string,
  ): OutboxMessage {
    const row = this.getRow(connection, messageId);
    if (row.project_id) ensureProjectWritable(connection, row.project_id);
    connection
      .prepare(
        "UPDATE outbox_messages SET status=?,last_error=?,available_at=?,retry_count=retry_count+1 WHERE id=?",
      )
      .run("retry", error, availableAt, messageId);
    return fromRow(this.getRow(connection, messageId));
  }
  /** 别名：将消息重新放回重试队列。 */
  retry(
    connection: BetterSqlite3.Database,
    messageId: string,
    availableAt: string,
    error = "retry requested",
  ): OutboxMessage {
    return this.scheduleRetry(connection, messageId, availableAt, error);
  }
  private getRow(connection: BetterSqlite3.Database, id: string): OutboxRow {
    const row = connection
      .prepare("SELECT * FROM outbox_messages WHERE id=?")
      .get(id) as OutboxRow | undefined;
    if (!row) throw new Error("outbox message not found");
    return row;
  }
}
type OutboxRow = {
  id: string;
  project_id: string | null;
  event_id: string;
  topic: string;
  payload_json: string;
  created_at: string;
  published_at: string | null;
  status: string;
  retry_count: number;
  last_error: string | null;
  available_at: string | null;
};
function fromRow(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    topic: row.topic,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    status: row.status,
    retryCount: row.retry_count,
    lastError: row.last_error,
    availableAt: row.available_at,
  };
}
