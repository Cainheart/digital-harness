import { randomBytes } from "node:crypto";

/** 项目主状态；值保持概要设计和现有数据库的中文合同。 */
export const ProjectStatus = {
  PREPARING: "准备中",
  RUNNING: "运行中",
  WAITING_BOSS: "等待 Boss",
  PAUSED: "已暂停",
  BLOCKED: "已阻塞",
  CLOSING: "结项中",
  COMPLETED: "已结项",
  TERMINATED: "已终止",
} as const;
export type ProjectStatus = typeof ProjectStatus[keyof typeof ProjectStatus];

/** 任务主状态；值保持概要设计和现有数据库的中文合同。 */
export const TaskStatus = {
  PENDING: "待处理",
  RUNNING: "进行中",
  WAITING_REVIEW: "等待 Review",
  WAITING_APPROVAL: "等待审批",
  BLOCKED: "阻塞",
  REWORK: "返工",
  COMPLETED: "已完成",
  TERMINATED: "已终止",
} as const;
export type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];

/** 记录领域事实的责任角色和操作者，不携带凭据或自由文本。 */
export type Actor = { type: string; id: string };

/** 校验不可见字符、路径分隔符和空白，避免 ID 进入日志或路径边界。 */
export function validateSafeValue(value: string, fieldName: string): string {
  if (typeof value !== "string" || !value || !value.trim()) throw new Error(`${fieldName} must be non-empty`);
  if (/^[^\x00-\x1f\x7f\s/\\]+$/.test(value) === false) throw new Error(`${fieldName} contains unsafe characters`);
  return value;
}

/** 创建带类型前缀、不可猜测且按时间大致有序的对象 ID。 */
export function newObjectId(kind: string): string {
  if (!/^[a-z](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(kind)) throw new Error("invalid object kind");
  const millis = Date.now().toString().padStart(13, "0");
  return `${kind}_${millis}${randomBytes(12).toString("base64url")}`;
}

/** 返回所有持久化时间使用的 UTC ISO-8601 字符串。 */
export function utcNow(): string { return new Date().toISOString(); }

/** 描述稳定游标分页结果，避免把 cursor 当成 offset。 */
export type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

/** 对 JSON 对象做深度可序列化和敏感字段边界检查。 */
export function validateJsonObject(value: unknown, key?: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("value must be a JSON object");
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("value must be JSON serializable");
  if (key && /api[_ -]?key|authorization|bearer|cookie|secret|password|prompt|access[_ -]?token|refresh[_ -]?token|tokens?/i.test(key)) {
    throw new Error("sensitive fields are not allowed in domain summaries");
  }
  assertSafeData(value);
  return value as Record<string, unknown>;
}

/** 递归拒绝凭据、提示词和令牌，防止它们进入领域事件或命令摘要。 */
export function assertSafeData(value: unknown, key?: string): void {
  if (key && /api[_ -]?key|authorization|bearer|cookie|secret|password|prompt|access[_ -]?token|refresh[_ -]?token|tokens?/i.test(key)) {
    throw new Error("sensitive fields are not allowed in domain summaries");
  }
  if (typeof value === "string" && /(?:api[_ -]?key|authorization|bearer|cookie|secret|password|system\s+prompt|prompt|access[_ -]?token|refresh[_ -]?token|tokens?)\s*[:=]|\bbearer\s+\S+|\bsk-[A-Za-z0-9][A-Za-z0-9_-]*/i.test(value)) {
    throw new Error("summary contains a credential or prompt value");
  }
  if (Array.isArray(value)) value.forEach((item) => assertSafeData(item));
  else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => assertSafeData(item, name));
}

/** 统一把带时区时间规范化为 UTC，拒绝无时区的本地时间。 */
export function normalizeUtc(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(value)) throw new Error("datetime must include a timezone offset");
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("invalid datetime");
  return date.toISOString();
}
