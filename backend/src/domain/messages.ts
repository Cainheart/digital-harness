import {
  newObjectId,
  utcNow,
  validateJsonObject,
  validateSafeValue,
} from "./common.js";
import { InvalidMessageError } from "./errors.js";
import { canonicalRoleId } from "./organization/definitions.js";

/** Task 3 冻结的最小结构化业务消息类型。 */
export type MessageType =
  | "task_assignment"
  | "feasibility_opinion"
  | "approval_direction"
  | "review_feedback"
  | "defect_handoff"
  | "regression_request"
  | "risk_escalation"
  | "coordination_item";
/** 消息处理状态；acknowledge 只推进状态，不覆盖原始 payload。 */
export type MessageStatus = "pending" | "acknowledged" | "handled" | "rejected";
/** 结构化消息中的岗位/员工端点。 */
export type MessageEndpoint = { roleId: string; instanceId: string };
/** 可追溯的消息创建请求，不允许把自由对话当作业务事实。 */
// 修改日期：2026-08-16
// 修改原因：Boss 方向交接需要显式绑定响应任务；响应对象类型和 ID 必须成对出现，避免只凭 payload 猜测后续责任对象。
export type CreateMessageInput = {
  sender: MessageEndpoint;
  receiver: MessageEndpoint;
  projectId: string;
  taskId: string;
  messageType: MessageType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  sourceObjectType?: string | null;
  sourceObjectId?: string | null;
  responseObjectType?: string | null;
  responseObjectId?: string | null;
  traceId?: string | null;
};
/** 持久化结构化消息及原始对象、响应对象关联。 */
export type StructuredMessage = CreateMessageInput & {
  messageId: string;
  createdAt: string;
  status: MessageStatus;
  handledAt: string | null;
  handledBy: string | null;
  responseObjectType: string | null;
  responseObjectId: string | null;
  version: number;
};
/** 允许进入业务流的消息类型集合。 */
export const MESSAGE_TYPES: readonly MessageType[] = [
  "task_assignment",
  "feasibility_opinion",
  "approval_direction",
  "review_feedback",
  "defect_handoff",
  "regression_request",
  "risk_escalation",
  "coordination_item",
];

/** 解析创建请求并拒绝缺少接收方、任务或追踪字段的消息。 */
export function parseCreateMessage(input: unknown): CreateMessageInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InvalidMessageError("消息请求必须是对象");
  const value = input as Record<string, unknown>;
  const endpoint = (candidate: unknown, name: string): MessageEndpoint => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new InvalidMessageError(`${name} 不能为空`);
    const item = candidate as Record<string, unknown>;
    return {
      roleId: canonicalRoleId(
        requiredSafeString(item.roleId, `${name}.roleId`),
      ),
      instanceId: requiredSafeString(item.instanceId, `${name}.instanceId`),
    };
  };
  const sender = endpoint(value.sender, "sender");
  const receiver = endpoint(value.receiver, "receiver");
  const projectId = requiredSafeString(value.projectId, "projectId");
  const taskId = requiredSafeString(value.taskId, "taskId");
  const messageType = requiredString(
    value.messageType,
    "messageType",
  ) as MessageType;
  if (!MESSAGE_TYPES.includes(messageType))
    throw new InvalidMessageError("messageType 不在支持范围内", {
      data: { messageType },
    });
  const payload = validateJsonObject(value.payload ?? {});
  const idempotencyKey = requiredSafeString(
    value.idempotencyKey,
    "idempotencyKey",
  );
  const sourceObjectType =
    value.sourceObjectType == null
      ? null
      : requiredSafeString(value.sourceObjectType, "sourceObjectType");
  const sourceObjectId =
    value.sourceObjectId == null
      ? null
      : requiredSafeString(value.sourceObjectId, "sourceObjectId");
  const responseObjectType =
    value.responseObjectType == null
      ? null
      : requiredSafeString(value.responseObjectType, "responseObjectType");
  const responseObjectId =
    value.responseObjectId == null
      ? null
      : requiredSafeString(value.responseObjectId, "responseObjectId");
  if ((sourceObjectType === null) !== (sourceObjectId === null))
    throw new InvalidMessageError(
      "sourceObjectType 和 sourceObjectId 必须同时提供",
    );
  if ((responseObjectType === null) !== (responseObjectId === null))
    throw new InvalidMessageError(
      "responseObjectType 和 responseObjectId 必须同时提供",
    );
  const traceId =
    value.traceId == null ? null : requiredSafeString(value.traceId, "traceId");
  return {
    sender,
    receiver,
    projectId,
    taskId,
    messageType,
    payload,
    idempotencyKey,
    sourceObjectType,
    sourceObjectId,
    responseObjectType,
    responseObjectId,
    traceId,
  };
}

/** 校验结构化消息中的非空字符串字段，不把数字或对象隐式转换为文本。 */
function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidMessageError(`${fieldName} 必须是非空字符串`);
  }

  return value;
}

/** 校验可进入消息标识和 SQL 查询参数的安全字符串。 */
function requiredSafeString(value: unknown, fieldName: string): string {
  return validateSafeValue(requiredString(value, fieldName), fieldName);
}

/** 为合法创建请求物化新的结构化消息。 */
export function materializeMessage(
  input: CreateMessageInput,
): StructuredMessage {
  return {
    ...input,
    messageId: newObjectId("message"),
    createdAt: utcNow(),
    status: "pending",
    handledAt: null,
    handledBy: null,
    responseObjectType: input.responseObjectType ?? null,
    responseObjectId: input.responseObjectId ?? null,
    version: 1,
  };
}
