/** Task 5 统一模型网关错误分类；调用方不能依赖供应商特有错误文本。 */
export const MODEL_ERROR_CODES = [
  "CREDENTIAL_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "INVALID_STRUCTURED_OUTPUT",
  "REDACTION_FAILED",
  "UNKNOWN_PROVIDER_ERROR",
] as const;
/** 模型网关归一化错误码。 */
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

/** 表示不包含供应商原文或凭据的模型调用失败。 */
export class ModelGatewayError extends Error {
  /** 统一保存错误码、是否可重试和安全的用户消息。 */
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly timedOut = false,
    readonly redactionReason: string | null = null,
    readonly retryCount = 0,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/** 将模型错误映射为用户可见但不含原始响应的安全摘要。 */
export function modelErrorMessage(code: ModelErrorCode): string {
  const messages: Record<ModelErrorCode, string> = {
    CREDENTIAL_UNAVAILABLE: "模型凭据不可用",
    AUTHENTICATION_FAILED: "模型供应商鉴权失败",
    RATE_LIMITED: "模型供应商触发限流",
    TIMEOUT: "模型调用超时",
    PROVIDER_UNAVAILABLE: "模型供应商暂时不可用",
    INVALID_STRUCTURED_OUTPUT: "模型返回的结构化结果不符合约定",
    REDACTION_FAILED: "模型结果未通过脱敏安全检查",
    UNKNOWN_PROVIDER_ERROR: "模型供应商返回了无法归类的错误",
  };
  return messages[code];
}

/** 按错误码创建统一错误，避免每个供应商重复维护错误文案。 */
export function createModelGatewayError(
  code: ModelErrorCode,
  options: {
    retryable?: boolean;
    timedOut?: boolean;
    redactionReason?: string | null;
    retryCount?: number;
  } = {},
): ModelGatewayError {
  const defaultRetryable =
    code === "RATE_LIMITED" ||
    code === "TIMEOUT" ||
    code === "PROVIDER_UNAVAILABLE";
  return new ModelGatewayError(
    code,
    modelErrorMessage(code),
    options.retryable ?? defaultRetryable,
    options.timedOut ?? code === "TIMEOUT",
    options.redactionReason ?? null,
    options.retryCount ?? 0,
  );
}

/** 把未知异常归一化，禁止把供应商原始响应和错误正文写入业务数据。 */
export function normalizeModelError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return createModelGatewayError("TIMEOUT", { timedOut: true });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return createModelGatewayError("TIMEOUT", { timedOut: true });
  }
  if (error instanceof TypeError) {
    return createModelGatewayError("PROVIDER_UNAVAILABLE");
  }
  return createModelGatewayError("UNKNOWN_PROVIDER_ERROR", {
    retryable: false,
  });
}
