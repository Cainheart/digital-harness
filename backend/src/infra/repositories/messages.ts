import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { CreateMessageInput, materializeMessage, MessageStatus, StructuredMessage } from "../../domain/messages.js";
import { IdempotencyKeyReusedError, InvalidMessageError, NotFoundError } from "../../domain/errors.js";
import { canonicalRoleId, OrganizationMember } from "../../domain/organization/definitions.js";
import { Page } from "../../domain/common.js";
import { ensureProjectChild, ensureProjectWritable, jsonText, jsonValue, page } from "./common.js";

/** 结构化消息的 SQLite 仓储；消息幂等键和项目/任务复合外键由数据库共同保护。 */
export class StructuredMessageRepository {
  /** 检查消息端点的岗位与员工实例是否一致。 */
  assertEndpoint(connection: BetterSqlite3.Database, endpoint: { roleId: string; instanceId: string }, name: string): OrganizationMember {
    if (canonicalRoleId(endpoint.roleId) === "boss" && endpoint.instanceId.trim()) return { instanceId: endpoint.instanceId, roleId: "boss", displayName: "Boss", specialistTag: "boss", officeZone: "boss", deskGroup: "boss", status: "available", roleVersion: 1 };
    const row = connection.prepare("SELECT * FROM organization_members WHERE instance_id=?").get(endpoint.instanceId) as { instance_id: string; role_id: string; display_name: string; specialist_tag: string; office_zone: string; desk_group: string; status: "available" | "busy" | "blocked"; role_version: number } | undefined;
    if (!row || canonicalRoleId(row.role_id) !== canonicalRoleId(endpoint.roleId)) throw new InvalidMessageError(`${name} 岗位或员工实例无效`, { data: { instanceId: endpoint.instanceId, roleId: endpoint.roleId } });
    return { instanceId: row.instance_id, roleId: row.role_id, displayName: row.display_name, specialistTag: row.specialist_tag, officeZone: row.office_zone, deskGroup: row.desk_group, status: row.status, roleVersion: row.role_version };
  }
  /** 持久化一条结构化消息；重复请求返回原消息，复用不同 payload 则拒绝。 */
  create(connection: BetterSqlite3.Database, input: CreateMessageInput): { message: StructuredMessage; created: boolean } {
    ensureProjectWritable(connection, input.projectId); ensureProjectChild(connection, "tasks", input.projectId, input.taskId); this.assertEndpoint(connection, input.sender, "sender"); this.assertEndpoint(connection, input.receiver, "receiver");
    const hash = messageHash(input); const existing = connection.prepare("SELECT * FROM structured_messages WHERE idempotency_key=?").get(input.idempotencyKey) as MessageRow | undefined;
    if (existing) { if (existing.request_hash !== hash) throw new IdempotencyKeyReusedError("消息幂等键已被其他 payload 使用", { data: { idempotencyKey: input.idempotencyKey } }); return { message: messageFromRow(existing), created: false }; }
    const message = materializeMessage(input); connection.prepare("INSERT INTO structured_messages (message_id,sender_role,sender_instance_id,receiver_role,receiver_instance_id,project_id,task_id,message_type,payload_json,created_at,status,handled_at,handled_by,source_object_type,source_object_id,response_object_type,response_object_id,trace_id,idempotency_key,version,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(message.messageId, canonicalRoleId(message.sender.roleId), message.sender.instanceId, canonicalRoleId(message.receiver.roleId), message.receiver.instanceId, message.projectId, message.taskId, message.messageType, jsonText(message.payload), message.createdAt, message.status, message.handledAt, message.handledBy, message.sourceObjectType, message.sourceObjectId, message.responseObjectType, message.responseObjectId, message.traceId ?? `tr_message_${message.messageId}`, message.idempotencyKey, message.version, hash);
    return { message: { ...message, sender: { ...message.sender, roleId: canonicalRoleId(message.sender.roleId) }, receiver: { ...message.receiver, roleId: canonicalRoleId(message.receiver.roleId) }, traceId: message.traceId ?? `tr_message_${message.messageId}` }, created: true };
  }
  /** 按项目和任务读取消息，供办公室、任务详情和审批链路消费。 */
  list(connection: BetterSqlite3.Database, input: { projectId?: string | null; taskId?: string | null; limit: number; cursor?: string | null }): Page<StructuredMessage> {
    const values: unknown[] = []; const conditions: string[] = []; if (input.projectId) { conditions.push("project_id=?"); values.push(input.projectId); } if (input.taskId) { conditions.push("task_id=?"); values.push(input.taskId); } if (input.cursor) { conditions.push("message_id>? "); values.push(input.cursor); } const rows = connection.prepare(`SELECT * FROM structured_messages ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY message_id LIMIT ?`).all(...values, input.limit + 1) as MessageRow[]; return page(rows.map(messageFromRow), input.limit);
  }
  /** 将待处理消息标记为已接收，并保留处理人和时间。 */
  acknowledge(connection: BetterSqlite3.Database, messageId: string, handledBy: string): StructuredMessage { const row = connection.prepare("SELECT * FROM structured_messages WHERE message_id=?").get(messageId) as MessageRow | undefined; if (!row) throw new NotFoundError("结构化消息不存在"); if (row.status === "pending") connection.prepare("UPDATE structured_messages SET status='acknowledged',handled_at=?,handled_by=?,version=version+1 WHERE message_id=?").run(new Date().toISOString(), handledBy, messageId); return messageFromRow((connection.prepare("SELECT * FROM structured_messages WHERE message_id=?").get(messageId) as MessageRow)); }
}

/** Task 3 消息表的内部行形状；request_hash 用于幂等冲突检测。 */
type MessageRow = { message_id: string; sender_role: string; sender_instance_id: string; receiver_role: string; receiver_instance_id: string; project_id: string; task_id: string; message_type: StructuredMessage["messageType"]; payload_json: string; created_at: string; status: MessageStatus; handled_at: string | null; handled_by: string | null; source_object_type: string | null; source_object_id: string | null; response_object_type: string | null; response_object_id: string | null; trace_id: string; idempotency_key: string; version: number; request_hash: string };
/** 将 SQLite 行恢复为 API 消息对象。 */
function messageFromRow(row: MessageRow): StructuredMessage { return { messageId: row.message_id, sender: { roleId: row.sender_role, instanceId: row.sender_instance_id }, receiver: { roleId: row.receiver_role, instanceId: row.receiver_instance_id }, projectId: row.project_id, taskId: row.task_id, messageType: row.message_type, payload: jsonValue<Record<string, unknown>>(row.payload_json), createdAt: row.created_at, status: row.status, handledAt: row.handled_at, handledBy: row.handled_by, sourceObjectType: row.source_object_type, sourceObjectId: row.source_object_id, responseObjectType: row.response_object_type, responseObjectId: row.response_object_id, traceId: row.trace_id, idempotencyKey: row.idempotency_key, version: row.version } as StructuredMessage; }
/** 对消息请求生成不含随机 ID 的稳定 SHA-256 指纹。 */
function messageHash(input: CreateMessageInput): string { return createHash("sha256").update(JSON.stringify({ ...input, sender: { ...input.sender, roleId: canonicalRoleId(input.sender.roleId) }, receiver: { ...input.receiver, roleId: canonicalRoleId(input.receiver.roleId) } })).digest("hex"); }
