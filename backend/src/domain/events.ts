import {
  Actor,
  assertSafeData,
  normalizeUtc,
  utcNow,
  validateJsonObject,
  validateSafeValue,
} from "./common.js";
import { newObjectId } from "./common.js";

/** 调用/安全事件的正式类型集合；这类事件必须携带 attempt、actor 和脱敏原因。 */
const CONTEXT_EVENT_TYPES = new Set([
  "InvocationStarted",
  "InvocationCompleted",
  "InvocationFinished",
  "InvocationFailed",
  "InvocationRejected",
  "InvocationSecurity",
  "InvocationPolicy",
  "ModelCallStarted",
  "ModelCallCompleted",
  "ModelCallFinished",
  "ModelCallFailed",
  "ModelCallRejected",
  "ToolCallStarted",
  "ToolCallCompleted",
  "ToolCallFinished",
  "ToolCallFailed",
  "ToolCallRejected",
]);
/** 待提交的追加领域事实。 */
export type DomainEventDraft = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  payload: Record<string, unknown>;
  inputSummary: string | Record<string, unknown>;
  outputSummary: string | Record<string, unknown>;
  result: string;
  failure: string | null;
  retryCount: number;
  durationMs: number;
  actor: Actor;
  traceId: string;
  occurredAt: string;
  attemptId: string | null;
  rejectionReason: string | null;
  redactionReason: string | null;
  eventCategory: "ordinary" | "call" | "security";
};
/** 已定位到聚合版本的不可变领域事实。 */
export type DomainEvent = DomainEventDraft & {
  eventId: string;
  aggregateVersion: number;
  globalSequence: number;
};
/** 描述一批追加事件的聚合版本结果。 */
export type AppendResult = {
  aggregateType: string;
  aggregateId: string;
  expectedVersion: number;
  aggregateVersion: number;
  events: DomainEvent[];
};

/** 校验领域事件，防止敏感内容和上下文事件缺少追溯字段。 */
export function parseEventDraft(
  input: Partial<DomainEventDraft> & Record<string, unknown>,
): DomainEventDraft {
  const eventType = validateSafeValue(
    String(input.eventType ?? ""),
    "eventType",
  );
  const category = (input.eventCategory ??
    "ordinary") as DomainEventDraft["eventCategory"];
  if (!["ordinary", "call", "security"].includes(category))
    throw new Error("invalid eventCategory");
  const attemptId =
    input.attemptId == null
      ? null
      : validateSafeValue(String(input.attemptId), "attemptId");
  const actorInput = input.actor;
  if (!actorInput || typeof actorInput !== "object")
    throw new Error("actor is required");
  const actor = {
    type: validateSafeValue(String((actorInput as Actor).type), "actor.type"),
    id: validateSafeValue(String((actorInput as Actor).id), "actor.id"),
  };
  const rejectionReason =
    input.rejectionReason == null ? null : String(input.rejectionReason);
  const redactionReason =
    input.redactionReason == null ? null : String(input.redactionReason);
  assertSafeData(failureSummary(input.failure));
  assertSafeData(rejectionReason ?? "");
  assertSafeData(redactionReason ?? "");
  if (
    (category !== "ordinary" || CONTEXT_EVENT_TYPES.has(eventType)) &&
    (!attemptId || !rejectionReason?.trim() || !redactionReason?.trim())
  )
    throw new Error(
      "context event requires: attemptId, actor, rejectionReason, redactionReason",
    );
  const payload = validateJsonObject(input.payload ?? {});
  assertSafeData(payload);
  assertSafeData(input.inputSummary ?? "");
  assertSafeData(input.outputSummary ?? "");
  return {
    eventType,
    aggregateType: validateSafeValue(
      String(input.aggregateType ?? ""),
      "aggregateType",
    ),
    aggregateId: validateSafeValue(
      String(input.aggregateId ?? ""),
      "aggregateId",
    ),
    aggregateVersion: nonNegative(
      input.aggregateVersion ?? input.expectedVersion ?? 0,
      "aggregateVersion",
    ),
    payload,
    inputSummary: (input.inputSummary ??
      "") as DomainEventDraft["inputSummary"],
    outputSummary: (input.outputSummary ??
      "") as DomainEventDraft["outputSummary"],
    result: validateSafeValue(String(input.result ?? "success"), "result"),
    failure: failureSummary(input.failure),
    retryCount: nonNegative(input.retryCount ?? 0, "retryCount"),
    durationMs: nonNegative(input.durationMs ?? 0, "durationMs"),
    actor,
    traceId: validateSafeValue(
      String(input.traceId ?? "trace_unknown"),
      "traceId",
    ),
    occurredAt: input.occurredAt
      ? normalizeUtc(String(input.occurredAt))
      : utcNow(),
    attemptId,
    rejectionReason,
    redactionReason,
    eventCategory: category,
  };
}

/** 确认事件的版本数量与聚合最终版本一致。 */
export function validateAppendResult(result: AppendResult): AppendResult {
  if (result.aggregateVersion !== result.expectedVersion + result.events.length)
    throw new Error(
      "aggregateVersion must equal expectedVersion plus event count",
    );
  return result;
}
/** 把待提交事件物化为带全局序号的不可变事件。 */
export function materializeEvent(
  draft: DomainEventDraft,
  aggregateVersion: number,
  globalSequence: number,
): DomainEvent {
  return {
    ...draft,
    aggregateVersion,
    globalSequence,
    eventId: newObjectId("event"),
  };
}
function nonNegative(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

/** 规范化可选失败摘要，避免 undefined 或非字符串值进入事件事实。 */
function failureSummary(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("failure must be a string or null");
  }

  return value;
}
