import { createHash } from "node:crypto";
import {
  assertSafeData,
  Actor,
  newObjectId,
  validateJsonObject,
  validateSafeValue,
} from "./common.js";

/** 统一所有写命令的幂等、版本和操作者信封。 */
export type CommandEnvelope = {
  commandId: string;
  idempotencyKey: string;
  aggregateId: string;
  expectedVersion: number;
  actor: Actor;
  payload: Record<string, unknown>;
};
/** 返回一次已提交命令的稳定结果，供幂等重放。 */
export type CommandResult = {
  aggregateId: string;
  version: number;
  eventId: string;
  allowedActions: string[];
  traceId: string;
};

/** 校验并规范化命令信封，拒绝把信封字段伪装成业务 payload。 */
export function parseCommand(input: Record<string, unknown>): CommandEnvelope {
  const commandId = validateSafeValue(
    String(input.commandId ?? ""),
    "commandId",
  );
  const idempotencyKey = validateSafeValue(
    String(input.idempotencyKey ?? ""),
    "idempotencyKey",
  );
  const aggregateId = validateSafeValue(
    String(input.aggregateId ?? ""),
    "aggregateId",
  );
  if (
    !Number.isInteger(input.expectedVersion) ||
    Number(input.expectedVersion) < 0
  )
    throw new Error("expectedVersion must be a non-negative integer");
  const actor = input.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor))
    throw new Error("actor must be an object");
  const actorValue = {
    type: validateSafeValue(
      String((actor as Record<string, unknown>).type ?? ""),
      "actor.type",
    ),
    id: validateSafeValue(
      String((actor as Record<string, unknown>).id ?? ""),
      "actor.id",
    ),
  };
  const payload = validateJsonObject(input.payload);
  const reserved = new Set([
    "commandId",
    "command_id",
    "idempotencyKey",
    "idempotency_key",
    "aggregateId",
    "aggregate_id",
    "expectedVersion",
    "expected_version",
    "actor",
    "payload",
  ]);
  if (Object.keys(payload).some((key) => reserved.has(key)))
    throw new Error("payload contains reserved command envelope fields");
  assertSafeData(payload);
  return {
    commandId,
    idempotencyKey,
    aggregateId,
    expectedVersion: Number(input.expectedVersion),
    actor: actorValue,
    payload,
  };
}

/** 用排序键 JSON 和 SHA-256 生成稳定的命令请求指纹。 */
export function canonicalRequestHash(command: CommandEnvelope): string {
  const canonical = JSON.stringify(sortKeys(command));
  return createHash("sha256").update(canonical).digest("hex");
}
/** 为测试和调用方提供一份不含随机内容的合法命令 ID 生成器。 */
export function newCommandId(): string {
  return newObjectId("command");
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  return value;
}
