import { newObjectId, utcNow, validateJsonObject, validateSafeValue } from "./common.js";
import { InvalidMessageError } from "./errors.js";
import { canonicalRoleId } from "./organization/definitions.js";

/** Task 3 冻结的最小结构化业务消息类型。 */
export type MessageType = "task_assignment" | "feasibility_opinion" | "approval_direction" | "review_feedback" | "defect_handoff" | "regression_request" | "risk_escalation" | "coordination_item";
/** 消息处理状态；acknowledge 只推进状态，不覆盖原始 payload。 */
export type MessageStatus = "pending" | "acknowledged" | "handled" | "rejected";
/** 结构化消息中的岗位/员工端点。 */
export type MessageEndpoint = { roleId: string; instanceId: string };
/** 可追溯的消息创建请求，不允许把自由对话当作业务事实。 */
export type CreateMessageInput = { sender: MessageEndpoint; receiver: MessageEndpoint; projectId: string; taskId: string; messageType: MessageType; payload: Record<string, unknown>; idempotencyKey: string; sourceObjectType?: string | null; sourceObjectId?: string | null; traceId?: string | null };
/** 持久化结构化消息及原始对象、响应对象关联。 */
export type StructuredMessage = CreateMessageInput & { messageId: string; createdAt: string; status: MessageStatus; handledAt: string | null; handledBy: string | null; responseObjectType: string | null; responseObjectId: string | null; version: number };
/** 允许进入业务流的消息类型集合。 */
export const MESSAGE_TYPES: readonly MessageType[] = ["task_assignment", "feasibility_opinion", "approval_direction", "review_feedback", "defect_handoff", "regression_request", "risk_escalation", "coordination_item"];

/** 解析创建请求并拒绝缺少接收方、任务或追踪字段的消息。 */
export function parseCreateMessage(input: unknown): CreateMessageInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidMessageError("消息请求必须是对象");
  const value = input as Record<string, unknown>;
  const endpoint = (candidate: unknown, name: string): MessageEndpoint => { if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new InvalidMessageError(`${name} 不能为空`); const item = candidate as Record<string, unknown>; return { roleId: canonicalRoleId(validateSafeValue(String(item.roleId ?? ""), `${name}.roleId`)), instanceId: validateSafeValue(String(item.instanceId ?? ""), `${name}.instanceId`) }; };
  const sender = endpoint(value.sender, "sender"); const receiver = endpoint(value.receiver, "receiver");
  const projectId = validateSafeValue(String(value.projectId ?? ""), "projectId"); const taskId = validateSafeValue(String(value.taskId ?? ""), "taskId"); const messageType = String(value.messageType ?? "") as MessageType;
  if (!MESSAGE_TYPES.includes(messageType)) throw new InvalidMessageError("messageType 不在支持范围内", { data: { messageType } });
  const payload = validateJsonObject(value.payload ?? {}); const idempotencyKey = validateSafeValue(String(value.idempotencyKey ?? ""), "idempotencyKey");
  const sourceObjectType = value.sourceObjectType == null ? null : validateSafeValue(String(value.sourceObjectType), "sourceObjectType"); const sourceObjectId = value.sourceObjectId == null ? null : validateSafeValue(String(value.sourceObjectId), "sourceObjectId"); const traceId = value.traceId == null ? null : validateSafeValue(String(value.traceId), "traceId");
  return { sender, receiver, projectId, taskId, messageType, payload, idempotencyKey, sourceObjectType, sourceObjectId, traceId };
}

/** 为合法创建请求物化新的结构化消息。 */
export function materializeMessage(input: CreateMessageInput): StructuredMessage { return { ...input, messageId: newObjectId("message"), createdAt: utcNow(), status: "pending", handledAt: null, handledBy: null, responseObjectType: null, responseObjectId: null, version: 1 }; }
