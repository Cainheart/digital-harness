import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CredentialAdapter } from "../../infra/keychain.js";
import type {
  FrozenModelConfig,
  StoredModelConfig,
} from "../../domain/model-config.js";
import type { TraceContext } from "../../observability/trace.js";
import {
  createModelGatewayError,
  ModelGatewayError,
  normalizeModelError,
} from "./errors.js";
import type {
  ConnectionCheckResult,
  ModelAdapter,
  ModelFetch,
  ModelUsage,
  StructuredModelRequest,
  StructuredModelResponse,
} from "./model-adapter.js";
import { normalizeUsage } from "./usage.js";

/** 兼容 OpenAI Chat Completions 协议的供应商适配器共享实现。 */
export abstract class OpenAiCompatibleAdapter implements ModelAdapter {
  abstract readonly provider: "openai" | "deepseek";

  /** 绑定凭据适配器、供应商端点和可注入 HTTP 客户端。 */
  constructor(
    private readonly credentials: CredentialAdapter,
    private readonly endpoint: string,
    private readonly fetchImpl: ModelFetch = defaultModelFetch(),
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /** 发起结构化模型调用，并只对明确可重试错误执行有限重试。 */
  async complete(
    request: StructuredModelRequest,
    config: FrozenModelConfig,
    _trace: TraceContext,
  ): Promise<StructuredModelResponse> {
    if (!config.secretRef) {
      throw createModelGatewayError("CREDENTIAL_UNAVAILABLE", {
        retryable: false,
      });
    }
    const lease = await this.readCredential(config.secretRef);
    // 修改日期：2026-08-16
    // 修改原因：外部边界的重试参数可能来自持久化或调用方，必须限制次数，避免无限重试放大供应商故障。
    const maxAttempts = boundedInteger(config.maxAttempts, 1, 3, 1);
    let attempt = 0;
    while (attempt < maxAttempts) {
      try {
        const result = await this.requestOnce(
          request,
          config,
          lease.secret,
        );
        return { ...result, retryCount: attempt };
      } catch (error) {
        const normalized = normalizeModelError(error);
        attempt += 1;
        if (!normalized.retryable || attempt >= maxAttempts) {
          throw new ModelGatewayError(
            normalized.code,
            normalized.message,
            normalized.retryable,
            normalized.timedOut,
            normalized.redactionReason,
            attempt - 1,
          );
        }
        await backoff(attempt);
      }
    }
    throw createModelGatewayError("UNKNOWN_PROVIDER_ERROR", {
      retryable: false,
    });
  }

  /** 通过最小结构化请求验证供应商、模型和凭据可用性。 */
  async checkConnection(
    config: StoredModelConfig,
    trace: TraceContext,
  ): Promise<ConnectionCheckResult> {
    if (!config.secretRef || config.provider === "unconfigured") {
      return {
        status: "unavailable",
        errorCode: "CREDENTIAL_UNAVAILABLE",
        message: "模型凭据不可用",
      };
    }
    const frozen: FrozenModelConfig = {
      domain: config.domain,
      provider: this.provider,
      modelName: config.modelName,
      configVersion: config.configVersion,
      secretRef: config.secretRef,
      timeoutMs: this.defaultTimeoutMs,
      maxAttempts: 1,
    };
    try {
      await this.complete(
        {
          messages: [
            {
              role: "user",
              content: 'Return exactly {"ok":true} as JSON.',
            },
          ],
          outputSchema: Type.Object({ ok: Type.Boolean() }),
          maxOutputTokens: 16,
        },
        frozen,
        trace,
      );
      return { status: "ready", errorCode: null, message: "模型连接可用" };
    } catch (error) {
      const normalized = normalizeModelError(error);
      return {
        status: "unavailable",
        errorCode: normalized.code,
        message: normalized.message,
      };
    }
  }

  /** 在真实外部调用边界读取短时凭据，避免数据库或业务层持有明文。 */
  private async readCredential(secretRef: string) {
    try {
      const lease = await this.credentials.read(secretRef);
      // 修改日期：2026-08-16
      // 修改原因：空 SecretLease 不能被当作可用凭据发给供应商，必须在授权边界明确阻断。
      if (!lease.secret.trim()) {
        throw new Error("credential lease is empty");
      }
      return lease;
    } catch (_error) {
      throw createModelGatewayError("CREDENTIAL_UNAVAILABLE", {
        retryable: false,
      });
    }
  }

  /** 执行一次供应商 HTTP 请求并将响应转换为统一结构化结果。 */
  private async requestOnce(
    request: StructuredModelRequest,
    config: FrozenModelConfig,
    secret: string,
  ): Promise<Omit<StructuredModelResponse, "retryCount">> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      // 修改日期：2026-08-16
      // 修改原因：调用方或历史配置的超时值必须限制在有限范围内，避免立即超时或超长占用 Worker。
      boundedInteger(config.timeoutMs, 1, 300_000, this.defaultTimeoutMs),
    );
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.modelName,
          messages: request.messages,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxOutputTokens ?? 2_048,
          response_format: { type: "json_object" },
        }),
      });
      const text = await response.text();
      if (secret && text.includes(secret)) {
        throw createModelGatewayError("REDACTION_FAILED", {
          retryable: false,
          redactionReason: "provider response echoed the credential",
        });
      }
      if (!response.ok) {
        throw classifyHttpFailure(response.status);
      }
      return this.parseResponse(text, request);
    } catch (error) {
      if (error instanceof ModelGatewayError) {
        throw error;
      }
      throw normalizeModelError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 校验供应商 JSON、结构化输出 Schema 和 Token 字段边界。 */
  private parseResponse(
    text: string,
    request: StructuredModelRequest,
  ): Omit<StructuredModelResponse, "retryCount"> {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      throw createModelGatewayError("UNKNOWN_PROVIDER_ERROR", {
        retryable: false,
      });
    }
    if (!payload || typeof payload !== "object") {
      throw createModelGatewayError("UNKNOWN_PROVIDER_ERROR", {
        retryable: false,
      });
    }
    const record = payload as Record<string, unknown>;
    const choices = record.choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : null;
    const message =
      firstChoice && typeof firstChoice === "object"
        ? (firstChoice as Record<string, unknown>).message
        : null;
    const content =
      message && typeof message === "object"
        ? (message as Record<string, unknown>).content
        : null;
    if (typeof content !== "string") {
      throw createModelGatewayError("INVALID_STRUCTURED_OUTPUT", {
        retryable: false,
      });
    }
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch (_error) {
      throw createModelGatewayError("INVALID_STRUCTURED_OUTPUT", {
        retryable: false,
      });
    }
    if (!Value.Check(request.outputSchema, output)) {
      throw createModelGatewayError("INVALID_STRUCTURED_OUTPUT", {
        retryable: false,
      });
    }
    const usage = parseUsage(record.usage);
    const finishReason =
      firstChoice && typeof firstChoice === "object" &&
      typeof (firstChoice as Record<string, unknown>).finish_reason === "string"
        ? ((firstChoice as Record<string, unknown>).finish_reason as string)
        : null;
    const providerRequestId =
      typeof record.id === "string" ? record.id : null;
    return {
      output: output as Record<string, unknown>,
      usage,
      finishReason,
      providerRequestId,
    };
  }
}

/** 将 OpenAI-compatible usage 字段转换为受约束的内部 Token 结构。 */
function parseUsage(value: unknown): ModelUsage {
  if (!value || typeof value !== "object") {
    return normalizeUsage({});
  }
  const usage = value as Record<string, unknown>;
  return normalizeUsage({
    inputTokens: integerOrUndefined(usage.prompt_tokens),
    outputTokens: integerOrUndefined(usage.completion_tokens),
    totalTokens: integerOrUndefined(usage.total_tokens),
  });
}

/** 只接受供应商返回的有限整数 Token 字段，其他值交给统一错误处理。 */
function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** 将来自配置或边界调用方的整数参数限制在有限安全区间内。 */
function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fallback;
  }
  return value;
}

/** 按 HTTP 状态映射供应商错误，不保留原始响应正文。 */
function classifyHttpFailure(status: number): ModelGatewayError {
  if (status === 401 || status === 403) {
    return createModelGatewayError("AUTHENTICATION_FAILED", {
      retryable: false,
    });
  }
  if (status === 408 || status === 504) {
    return createModelGatewayError("TIMEOUT", { timedOut: true });
  }
  if (status === 429) {
    return createModelGatewayError("RATE_LIMITED");
  }
  if (status >= 500) {
    return createModelGatewayError("PROVIDER_UNAVAILABLE");
  }
  return createModelGatewayError("UNKNOWN_PROVIDER_ERROR", {
    retryable: false,
  });
}

/** 使用有限指数退避控制自动重试，避免外部服务异常时无限重试。 */
async function backoff(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/** 提供全局 fetch 的明确失败边界，避免运行时没有网络实现时静默放行。 */
function defaultModelFetch(): ModelFetch {
  if (typeof globalThis.fetch !== "function") {
    return async () => {
      throw createModelGatewayError("PROVIDER_UNAVAILABLE", {
        retryable: false,
      });
    };
  }
  return globalThis.fetch.bind(globalThis);
}
