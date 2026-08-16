import type { TSchema } from "@sinclair/typebox";
import type { TraceContext } from "../../observability/trace.js";
import type {
  FrozenModelConfig,
  ModelProvider,
  StoredModelConfig,
} from "../../domain/model-config.js";
import type { ModelGatewayError } from "./errors.js";

/** 发送给供应商的结构化模型消息；完整内容只存在调用边界内。 */
export type StructuredModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
/** 统一模型请求；outputSchema 用于验证返回的 JSON 结构。 */
export type StructuredModelRequest = {
  messages: StructuredModelMessage[];
  outputSchema: TSchema;
  temperature?: number;
  maxOutputTokens?: number;
};
/** 供应商返回的统一 Token 用量。 */
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
/** 供应商返回的统一结构化模型结果。 */
export type StructuredModelResponse<T = Record<string, unknown>> = {
  output: T;
  usage: ModelUsage;
  finishReason: string | null;
  providerRequestId: string | null;
  retryCount: number;
};
/** 连接检测结果；不携带供应商原始错误正文。 */
export type ConnectionCheckResult = {
  status: "ready" | "unavailable";
  errorCode: ModelGatewayError["code"] | null;
  message: string;
};

/** 可替换的 OpenAI-compatible 模型适配器统一接口。 */
export interface ModelAdapter {
  readonly provider: ModelProvider;
  /** 使用冻结配置完成一次结构化模型调用。 */
  complete(
    request: StructuredModelRequest,
    config: FrozenModelConfig,
    trace: TraceContext,
  ): Promise<StructuredModelResponse>;
  /** 对当前配置和凭据执行连接检测。 */
  checkConnection(
    config: StoredModelConfig,
    trace: TraceContext,
  ): Promise<ConnectionCheckResult>;
}

/** 供应商适配器依赖的可注入 fetch 类型，便于模拟服务集成测试。 */
export type ModelFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
