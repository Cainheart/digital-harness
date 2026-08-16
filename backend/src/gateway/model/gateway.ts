import type { TraceContext } from "../../observability/trace.js";
import {
  FrozenModelConfig,
  ModelProvider,
  StoredModelConfig,
} from "../../domain/model-config.js";
import { summarizeModelInput, summarizeModelOutput } from "../../observability/redaction.js";
import type {
  ConnectionCheckResult,
  ModelAdapter,
  StructuredModelRequest,
  StructuredModelResponse,
} from "./model-adapter.js";
import { createModelGatewayError, normalizeModelError } from "./errors.js";
import {
  CallHandle,
  ModelCallRecorder,
  ModelCallResult,
  ModelCallStart,
} from "../../observability/model-call-recorder.js";

/** 只按 provider 选择适配器，不提供隐式供应商切换或静默降级。 */
export class ModelAdapterRegistry {
  private readonly adapters: ReadonlyMap<ModelProvider, ModelAdapter>;

  /** 注册 OpenAI/DeepSeek 等明确供应商适配器，并拒绝重复覆盖。 */
  constructor(adapters: ModelAdapter[]) {
    const entries = new Map<ModelProvider, ModelAdapter>();
    for (const adapter of adapters) {
      if (entries.has(adapter.provider)) {
        throw new Error(`duplicate model adapter: ${adapter.provider}`);
      }
      entries.set(adapter.provider, adapter);
    }
    this.adapters = entries;
  }

  /** 按供应商读取适配器，未知供应商直接归一化为不可用错误。 */
  get(provider: ModelProvider): ModelAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw createModelGatewayError("PROVIDER_UNAVAILABLE", {
        retryable: false,
      });
    }
    return adapter;
  }
}

/** 统一模型调用编排；负责脱敏摘要、调用记录和失败归一化。 */
export class ModelGateway {
  /** 注入无业务状态推进权限的适配器注册表和调用记录器。 */
  constructor(
    private readonly registry: ModelAdapterRegistry,
    private readonly recorder: ModelCallRecorder,
  ) {}

  /** 以冻结配置发起结构化调用，不直接推进任务或项目状态。 */
  async complete(
    request: StructuredModelRequest,
    config: FrozenModelConfig,
    context: {
      projectId: string;
      taskId: string | null;
      attemptId: string;
      role: string;
      trace: TraceContext;
      artifactRef?: string | null;
    },
  ): Promise<StructuredModelResponse> {
    const inputSummary = summarizeModelInput(request);
    const start: ModelCallStart = {
      projectId: context.projectId,
      taskId: context.taskId,
      attemptId: context.attemptId,
      domain: config.domain,
      role: context.role,
      provider: config.provider,
      modelName: config.modelName,
      configVersion: config.configVersion,
      timeoutMs: config.timeoutMs,
      trace: context.trace,
      inputSummary,
      artifactRef: context.artifactRef,
    };
    const handle = await this.recorder.started(start);
    let response: StructuredModelResponse;
    let outputSummary: ReturnType<typeof summarizeModelOutput>;
    try {
      response = await this.registry
        .get(config.provider)
        .complete(request, config, context.trace);
      outputSummary = summarizeModelOutput(response.output);
    } catch (error) {
      const gatewayError = normalizeModelError(error);
      await this.recorder.failed(handle, {
        error: gatewayError,
        retryCount: gatewayError.retryCount,
      });
      throw gatewayError;
    }
    const result: ModelCallResult = {
      outputSummary,
      usage: response.usage,
      retryCount: response.retryCount,
      artifactRef: context.artifactRef,
    };
    // 修改日期：2026-08-16
    // 修改原因：调用成功后 recorder 写入失败应保留为观测基础设施错误，不能被误归一化为供应商失败。
    await this.recorder.finished(handle, result);
    return response;
  }

  /** 对指定领域的冻结配置执行连接检测并返回安全状态。 */
  async checkConnection(
    config: StoredModelConfig,
    trace: TraceContext,
  ): Promise<ConnectionCheckResult> {
    if (config.provider === "unconfigured") {
      return {
        status: "unavailable",
        errorCode: "CREDENTIAL_UNAVAILABLE",
        message: "模型配置尚未完成",
      };
    }
    return this.registry.get(config.provider).checkConnection(config, trace);
  }
}

/** 从持久化模型配置生成 Attempt 可携带的不可变快照。 */
export function freezeModelConfig(
  config: StoredModelConfig,
  options: { timeoutMs?: number; maxAttempts?: number } = {},
): FrozenModelConfig {
  if (
    config.provider === "unconfigured" ||
    config.credentialStatus !== "configured" ||
    !config.secretRef
  ) {
    throw createModelGatewayError("CREDENTIAL_UNAVAILABLE", {
      retryable: false,
    });
  }
  // 修改日期：2026-08-16
  // 修改原因：冻结配置的超时和重试策略进入 Attempt 历史后不可变，非法值必须在创建边界拒绝。
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 2;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 3
  ) {
    throw createModelGatewayError("UNKNOWN_PROVIDER_ERROR", {
      retryable: false,
    });
  }
  return Object.freeze({
    domain: config.domain,
    provider: config.provider,
    modelName: config.modelName,
    configVersion: config.configVersion,
    secretRef: config.secretRef,
    timeoutMs,
    maxAttempts,
  });
}
