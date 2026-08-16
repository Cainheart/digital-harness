import { redact } from "../security/redaction.js";

/** 递归脱敏领域错误数据，保留可用于恢复的非敏感诊断字段。 */
function redactData(value: unknown, key?: string): unknown {
  if (key && /api[_ -]?key|authorization|bearer|cookie|secret|password|token|prompt/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactData(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactData(item, name)]));
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return "[REDACTED]";
}

/** Task 2 领域边界错误的稳定基类和统一 JSON 载荷转换器。 */
export class Task2DomainError extends Error {
  readonly code: string;
  readonly impact: string;
  readonly paused: boolean;
  readonly dataPreserved: boolean;
  readonly nextAction: string;
  readonly traceId: string;
  readonly statusCode: number;
  readonly data: unknown;

  /** 保存稳定错误语义，并在保存前清除敏感输入。 */
  constructor(message = "领域操作被拒绝", options: DomainErrorOptions = {}, defaults: DomainErrorDefaults = {}) {
    const safeMessage = redact(message);
    super(safeMessage);
    this.name = new.target.name;
    this.code = defaults.code ?? "DOMAIN_ERROR";
    this.impact = redact(options.impact ?? defaults.impact ?? "操作未完成");
    this.paused = options.paused ?? false;
    this.dataPreserved = options.dataPreserved ?? true;
    this.nextAction = redact(options.nextAction ?? defaults.nextAction ?? "检查请求和关联对象后重试");
    this.traceId = redact(options.traceId ?? "trace_unknown") || "trace_unknown";
    this.statusCode = options.statusCode ?? defaults.statusCode ?? 400;
    this.data = redactData(options.data ?? {});
  }

  /** 生成不包含凭据原文的统一错误响应。 */
  toPayload(): Record<string, unknown> {
    return { code: this.code, message: this.message, impact: this.impact, paused: this.paused, dataPreserved: this.dataPreserved, nextAction: this.nextAction, traceId: this.traceId, statusCode: this.statusCode, data: this.data };
  }
  /** 兼容 API 层统一异常序列化的别名。 */
  payload(): Record<string, unknown> { return this.toPayload(); }
}

type DomainErrorOptions = { impact?: string; paused?: boolean; dataPreserved?: boolean; nextAction?: string; traceId?: string; statusCode?: number; data?: unknown };
type DomainErrorDefaults = { code?: string; statusCode?: number; impact?: string; nextAction?: string };

/** 使用固定错误码表示请求参数或领域 JSON 合同无效。 */
export class InvalidArgumentError extends Task2DomainError { constructor(message = "请求参数无效", options?: DomainErrorOptions) { super(message, options, { code: "INVALID_ARGUMENT", statusCode: 400 }); } }
/** 使用固定错误码表示 expectedVersion 已落后。 */
export class VersionConflictError extends Task2DomainError { constructor(message = "对象版本冲突，未覆盖最新事实", options?: DomainErrorOptions) { super(message, options, { code: "VERSION_CONFLICT", statusCode: 409 }); } }
/** 使用固定错误码表示幂等键被不同请求复用。 */
export class IdempotencyKeyReusedError extends Task2DomainError { constructor(message = "幂等键已被其他请求使用", options?: DomainErrorOptions) { super(message, options, { code: "IDEMPOTENCY_KEY_REUSED", statusCode: 409 }); } }
/** 使用固定错误码表示对象或证据不存在。 */
export class NotFoundError extends Task2DomainError { constructor(message = "请求对象不存在", options?: DomainErrorOptions) { super(message, options, { code: "NOT_FOUND", statusCode: 404 }); } }
/** 使用固定错误码表示历史项目只读。 */
export class ReadOnlyProjectError extends Task2DomainError { constructor(message = "历史项目处于只读状态，操作被策略拒绝", options?: DomainErrorOptions) { super(message, options, { code: "READ_ONLY_PROJECT", statusCode: 409 }); } }
/** 使用固定错误码表示内容寻址校验失败。 */
export class ArtifactIntegrityError extends Task2DomainError { constructor(message = "Artifact 完整性校验失败", options?: DomainErrorOptions) { super(message, options, { code: "ARTIFACT_INTEGRITY_FAILED", statusCode: 422 }); } }
/** 使用固定错误码表示 Artifact 超出边界。 */
export class ArtifactTooLargeError extends Task2DomainError { constructor(message = "Artifact 超过大小限制", options?: DomainErrorOptions) { super(message, options, { code: "ARTIFACT_TOO_LARGE", statusCode: 413 }); } }
/** 使用固定错误码表示追踪关系端点或项目范围无效。 */
export class TraceLinkInvalidError extends Task2DomainError { constructor(message = "TraceLink 关系无效", options?: DomainErrorOptions) { super(message, options, { code: "TRACE_LINK_INVALID", statusCode: 422 }); } }
/** 使用固定错误码表示质量门禁缺少证据。 */
export class EvidenceIncompleteError extends Task2DomainError { constructor(message = "证据不完整，无法通过质量门禁", options?: DomainErrorOptions) { super(message, options, { code: "EVIDENCE_INCOMPLETE", statusCode: 422 }); } }
