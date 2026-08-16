import {
  ORGANIZATION_DOMAIN_IDS,
  OrganizationDomainId,
} from "./organization/definitions.js";

/** 模型配置允许的五类领域；与组织领域保持同一组稳定标识。 */
export const MODEL_DOMAINS = ORGANIZATION_DOMAIN_IDS;
/** 模型配置所属领域类型。 */
export type ModelDomain = OrganizationDomainId;
/** V1 支持的模型供应商；未知供应商默认拒绝。 */
export const MODEL_PROVIDERS = ["openai", "deepseek"] as const;
/** V1 模型供应商类型。 */
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
/** 模型配置的连接状态。 */
export type ModelConnectionStatus =
  | "unknown"
  | "ready"
  | "unavailable"
  | "blocked";
/** 模型配置凭据状态。 */
export type CredentialStatus = "configured" | "missing";

/** 数据库中保存的模型配置；secretRef 只在 sidecar 内部使用。 */
export type StoredModelConfig = {
  domain: ModelDomain;
  provider: ModelProvider | "unconfigured";
  modelName: string;
  configVersion: number;
  secretRef: string | null;
  credentialStatus: CredentialStatus;
  connectionStatus: ModelConnectionStatus;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
};
/** 设置页和 API 可返回的脱敏模型配置；不包含 secretRef 或 credential。 */
export type ModelConfigView = Omit<
  StoredModelConfig,
  "secretRef" | "lastErrorCode" | "lastErrorAt"
> & {
  credentialStatus: CredentialStatus;
};
/** 运行中的 Attempt 使用的不可变模型配置快照。 */
export type FrozenModelConfig = {
  domain: ModelDomain;
  provider: ModelProvider;
  modelName: string;
  configVersion: number;
  secretRef: string;
  timeoutMs: number;
  maxAttempts: number;
};
/** 保存领域模型配置时的输入；credential 只允许在请求体内短暂存在。 */
export type ModelConfigUpdate = {
  provider: ModelProvider;
  modelName: string;
  credential?: string;
  expectedConfigVersion?: number;
  idempotencyKey: string;
};

/** 判断字符串是否属于五类模型领域。 */
export function isModelDomain(value: string): value is ModelDomain {
  return (MODEL_DOMAINS as readonly string[]).includes(value);
}

/** 判断字符串是否属于 V1 支持的模型供应商。 */
export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** 校验模型名长度和字符边界，允许供应商兼容模型名中的斜线。 */
export function validateModelName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("modelName must be a non-empty string");
  }
  const normalized = value.trim();
  if (normalized.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    throw new Error("modelName contains unsupported characters or is too long");
  }
  return normalized;
}

/** 将内部配置转换为不含引用和错误细节的用户可见视图。 */
export function toModelConfigView(config: StoredModelConfig): ModelConfigView {
  return {
    domain: config.domain,
    provider: config.provider,
    modelName: config.modelName,
    configVersion: config.configVersion,
    credentialStatus: config.credentialStatus,
    connectionStatus: config.connectionStatus,
    updatedAt: config.updatedAt,
  };
}
