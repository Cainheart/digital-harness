import { createHash } from "node:crypto";
import {
  ModelConfigUpdate,
  ModelDomain,
  ModelProvider,
  StoredModelConfig,
  isModelDomain,
  isModelProvider,
  toModelConfigView,
  validateModelName,
} from "../domain/model-config.js";
import {
  IdempotencyKeyReusedError,
  InvalidArgumentError,
  ModelConfigurationBlockedError,
  VersionConflictError,
} from "../domain/errors.js";
import { ModelGateway, freezeModelConfig } from "../gateway/model/gateway.js";
import { ModelGatewayError, normalizeModelError } from "../gateway/model/errors.js";
import type { CredentialAdapter } from "../infra/keychain.js";
import {
  ModelConfigChange,
  ModelConfigRepository,
} from "../infra/repositories/model-config.js";
import { Database } from "../infra/database.js";
import { redactJson } from "../security/redaction.js";
import { newObjectId, utcNow, validateSafeValue } from "../domain/common.js";
import type { TraceContext } from "../observability/trace.js";
import type { ConnectionCheckResult } from "../gateway/model/model-adapter.js";

/** 模型设置接口返回的连接检测结果，不包含 secretRef 和供应商原文。 */
export type ModelConnectionView = {
  domain: ModelDomain;
  provider: string;
  modelName: string;
  configVersion: number;
  credentialStatus: "configured" | "missing";
  connectionStatus: "ready" | "unavailable";
  errorCode: string | null;
  message: string;
  traceId: string;
  updatedAt: string;
};
/** 删除凭据请求的并发和幂等边界。 */
export type CredentialDeletionInput = {
  expectedConfigVersion?: number;
  idempotencyKey?: string;
};

/** 管理五领域模型配置、Keychain 引用、版本审计和连接检测。 */
export class ModelSettingsService {
  private readonly repository = new ModelConfigRepository();

  /** 注入数据库、OS Keychain 适配器和无业务状态推进权限的模型网关。 */
  constructor(
    private readonly database: Database,
    private readonly credentials: CredentialAdapter,
    private readonly gateway: ModelGateway,
  ) {}

  /** 返回五类领域的脱敏模型设置，固定不返回 secretRef。 */
  list(): { items: ReturnType<typeof toModelConfigView>[] } {
    return {
      items: this.repository
        .list(this.database.connection)
        .map(toModelConfigView),
    };
  }

  /** 按 expectedConfigVersion 原子更新领域配置并记录前后版本审计。 */
  async update(
    rawDomain: string,
    rawInput: Record<string, unknown>,
    traceId: string,
  ): Promise<ReturnType<typeof toModelConfigView>> {
    const domain = parseDomain(rawDomain, traceId);
    const input = parseUpdate(rawInput, traceId);
    const current = this.repository.get(this.database.connection, domain);
    const expectedVersion = input.expectedConfigVersion ?? current.configVersion;
    const requestHash = updateRequestHash(domain, input, expectedVersion);
    const existing = this.repository.getChangeByIdempotencyKey(
      this.database.connection,
      input.idempotencyKey,
    );
    // 修改日期：2026-08-16
    // 修改原因：幂等重放必须先返回原结果，不能被当前版本已前进的并发检查错误拦截。
    if (existing) {
      return this.replayOrReject(existing, requestHash, domain, traceId);
    }
    assertExpectedVersion(expectedVersion, current.configVersion, traceId);

    const secretRef = await this.prepareSecretRef(current, input, traceId);
    try {
      const now = utcNow();
      this.database.transaction((connection) => {
        const latest = this.repository.get(connection, domain);
        assertExpectedVersion(expectedVersion, latest.configVersion, traceId);
        this.repository.update(connection, {
          domain,
          provider: input.provider,
          modelName: input.modelName,
          configVersion: latest.configVersion + 1,
          secretRef,
          credentialStatus: "configured",
          connectionStatus: "unknown",
          lastErrorCode: null,
          lastErrorAt: null,
          updatedAt: now,
          expectedConfigVersion: expectedVersion,
        });
        this.repository.saveChange(connection, {
          id: newObjectId("model_config_change"),
          domain,
          previousConfig: auditConfig(latest),
          nextConfig: auditConfig({
            ...latest,
            provider: input.provider,
            modelName: input.modelName,
            configVersion: latest.configVersion + 1,
            secretRef,
            credentialStatus: "configured",
            connectionStatus: "unknown",
            lastErrorCode: null,
            lastErrorAt: null,
            updatedAt: now,
          }),
          expectedConfigVersion: expectedVersion,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          traceId,
          createdAt: now,
        });
        appendRuntimeEvent(connection, "ModelConfigChanged", traceId, {
          domain,
          previousConfigVersion: latest.configVersion,
          configVersion: latest.configVersion + 1,
          provider: input.provider,
          modelName: input.modelName,
        });
      });
    } catch (error) {
      if (input.credential !== undefined && secretRef) {
        await this.cleanupOrphanedSecret(secretRef);
      }
      throw error;
    }
    return toModelConfigView(this.repository.get(this.database.connection, domain));
  }

  /** 对当前领域配置执行真实连接检测，并持久化 ready/unavailable 状态。 */
  async testConnection(
    rawDomain: string,
    trace: TraceContext,
  ): Promise<ModelConnectionView> {
    const domain = parseDomain(rawDomain, trace.traceId);
    const current = this.repository.get(this.database.connection, domain);
    let result: ConnectionCheckResult;
    try {
      result = await this.gateway.checkConnection(current, trace);
    } catch (error) {
      const normalized = normalizeModelError(error);
      result = {
        status: "unavailable",
        errorCode: normalized.code,
        message: normalized.message,
      };
    }
    const updatedAt = utcNow();
    this.database.transaction((connection) => {
      this.repository.updateConnectionStatus(connection, {
        domain,
        configVersion: current.configVersion,
        connectionStatus: result.status,
        lastErrorCode: result.errorCode,
        lastErrorAt: result.errorCode ? updatedAt : null,
        updatedAt,
      });
      appendRuntimeEvent(connection, "ModelConnectionTested", trace.traceId, {
        domain,
        configVersion: current.configVersion,
        status: result.status,
        errorCode: result.errorCode,
      });
    });
    const saved = this.repository.get(this.database.connection, domain);
    return {
      ...toModelConfigView(saved),
      connectionStatus: result.status,
      errorCode: result.errorCode,
      message: result.message,
      traceId: trace.traceId,
      updatedAt,
    };
  }

  /** 删除领域凭据并生成新配置版本；删除后任务只能得到可解释阻塞。 */
  async deleteCredential(
    rawDomain: string,
    input: CredentialDeletionInput,
    traceId: string,
  ): Promise<ReturnType<typeof toModelConfigView>> {
    const domain = parseDomain(rawDomain, traceId);
    const current = this.repository.get(this.database.connection, domain);
    const expectedVersion = input.expectedConfigVersion ?? current.configVersion;
    const idempotencyKey = input.idempotencyKey
      ? parseIdempotencyKey(input.idempotencyKey, traceId)
      : `delete-${domain}-${expectedVersion}`;
    const requestHash = createHash("sha256")
      .update(`${domain}|delete|${expectedVersion}`)
      .digest("hex");
    const existing = this.repository.getChangeByIdempotencyKey(
      this.database.connection,
      idempotencyKey,
    );
    if (existing) {
      return this.replayOrReject(existing, requestHash, domain, traceId);
    }
    assertExpectedVersion(expectedVersion, current.configVersion, traceId);
    if (current.credentialStatus === "missing") {
      return toModelConfigView(current);
    }
    const now = utcNow();
    this.database.transaction((connection) => {
      const latest = this.repository.get(connection, domain);
      assertExpectedVersion(expectedVersion, latest.configVersion, traceId);
      this.repository.update(connection, {
        domain,
        provider: latest.provider,
        modelName: latest.modelName,
        configVersion: latest.configVersion + 1,
        secretRef: null,
        credentialStatus: "missing",
        connectionStatus: "blocked",
        lastErrorCode: "CREDENTIAL_UNAVAILABLE",
        lastErrorAt: now,
        updatedAt: now,
        expectedConfigVersion: expectedVersion,
      });
      this.repository.saveChange(connection, {
        id: newObjectId("model_config_change"),
        domain,
        previousConfig: auditConfig(latest),
        nextConfig: auditConfig({
          ...latest,
          configVersion: latest.configVersion + 1,
          secretRef: null,
          credentialStatus: "missing",
          connectionStatus: "blocked",
          lastErrorCode: "CREDENTIAL_UNAVAILABLE",
          lastErrorAt: now,
          updatedAt: now,
        }),
        expectedConfigVersion: expectedVersion,
        idempotencyKey,
        requestHash,
        traceId,
        createdAt: now,
      });
      appendRuntimeEvent(connection, "ModelCredentialDeleted", traceId, {
        domain,
        configVersion: latest.configVersion + 1,
      });
    });
    if (current.secretRef) {
      try {
        await this.credentials.delete(current.secretRef);
      } catch (_error) {
        throw new ModelConfigurationBlockedError("凭据已从配置中解绑，但 Keychain 清理未完成", {
          traceId,
          paused: true,
          nextAction: "检查本机 Keychain 权限后重新执行凭据清理",
        });
      }
    }
    return toModelConfigView(this.repository.get(this.database.connection, domain));
  }

  /** 在 Attempt 创建边界读取当前配置并冻结 provider/model/version/secretRef。 */
  freeze(
    rawDomain: string,
    options: { timeoutMs?: number; maxAttempts?: number } = {},
  ) {
    const domain = parseDomain(rawDomain, "trace_model_freeze");
    return freezeModelConfig(this.repository.get(this.database.connection, domain), options);
  }

  /** 对相同幂等键返回原配置，对不同请求复用幂等键时阻止覆盖。 */
  private replayOrReject(
    existing: ModelConfigChange,
    requestHash: string,
    domain: ModelDomain,
    traceId: string,
  ): ReturnType<typeof toModelConfigView> {
    if (existing.domain !== domain || existing.requestHash !== requestHash) {
      throw new IdempotencyKeyReusedError(undefined, { traceId });
    }
    return toModelConfigView(this.repository.get(this.database.connection, domain));
  }

  /** 保存新凭据到 OS Keychain，数据库只接收不可逆推的引用。 */
  private async prepareSecretRef(
    current: StoredModelConfig,
    input: ModelConfigUpdate,
    traceId: string,
  ): Promise<string> {
    if (input.credential !== undefined) {
      try {
        return await this.credentials.save(input.provider, input.credential);
      } catch (_error) {
        throw new ModelConfigurationBlockedError("模型凭据无法保存到本机 Keychain", {
          traceId,
          paused: true,
          nextAction: "检查本机凭据存储权限后重试",
        });
      }
    }
    if (
      current.credentialStatus === "configured" &&
      current.secretRef &&
      current.provider === input.provider
    ) {
      return current.secretRef;
    }
    throw new ModelConfigurationBlockedError("更换模型供应商时必须提供新凭据", {
      traceId,
      paused: true,
    });
  }

  /** 清理更新失败时产生的孤立 Keychain 引用，避免留下可用的未绑定凭据。 */
  private async cleanupOrphanedSecret(secretRef: string): Promise<void> {
    await this.credentials.delete(secretRef);
  }
}

/** 严格解析领域并阻止设置页越过五领域边界。 */
function parseDomain(rawDomain: string, traceId: string): ModelDomain {
  if (!isModelDomain(rawDomain)) {
    throw new InvalidArgumentError("domain 不属于五类模型领域", {
      traceId,
      data: { domain: rawDomain },
    });
  }
  return rawDomain;
}

/** 解析并校验模型设置请求，credential 不写入任何异常或审计数据。 */
function parseUpdate(
  input: Record<string, unknown>,
  traceId: string,
): ModelConfigUpdate {
  const provider = input.provider;
  if (typeof provider !== "string" || !isModelProvider(provider)) {
    throw new InvalidArgumentError("provider 只能是 openai 或 deepseek", {
      traceId,
    });
  }
  let modelName: string;
  try {
    modelName = validateModelName(input.modelName);
  } catch (_error) {
    throw new InvalidArgumentError("modelName 不符合模型名称边界", { traceId });
  }
  const credential = input.credential;
  if (
    credential !== undefined &&
    (typeof credential !== "string" || !credential.trim() || credential.length > 4096)
  ) {
    throw new InvalidArgumentError("credential 必须是非空且不超过 4096 字符的请求字段", {
      traceId,
    });
  }
  const expectedConfigVersion = input.expectedConfigVersion;
  if (
    expectedConfigVersion !== undefined &&
    (typeof expectedConfigVersion !== "number" ||
      !Number.isSafeInteger(expectedConfigVersion) ||
      expectedConfigVersion < 0)
  ) {
    throw new InvalidArgumentError("expectedConfigVersion 必须是非负整数", {
      traceId,
    });
  }
  return {
    provider,
    modelName,
    credential,
    expectedConfigVersion: expectedConfigVersion as number | undefined,
    idempotencyKey: parseIdempotencyKey(input.idempotencyKey, traceId),
  };
}

/** 校验配置变更幂等键，阻止空值、超长值和控制字符进入数据库。 */
function parseIdempotencyKey(value: unknown, traceId: string): string {
  if (typeof value !== "string" || value.length > 200) {
    throw new InvalidArgumentError("idempotencyKey 必须是非空安全字符串", {
      traceId,
    });
  }
  try {
    return validateSafeValue(value, "idempotencyKey");
  } catch (_error) {
    throw new InvalidArgumentError("idempotencyKey 必须是非空安全字符串", {
      traceId,
    });
  }
}

/** 把并发版本检查统一转换为可解释的 409 错误。 */
function assertExpectedVersion(
  expected: number,
  actual: number,
  traceId: string,
): void {
  if (expected !== actual) {
    throw new VersionConflictError(undefined, {
      traceId,
      data: { expectedConfigVersion: expected, actualConfigVersion: actual },
    });
  }
}

/** 生成不含 credential/secretRef 的幂等请求指纹。 */
function updateRequestHash(
  domain: ModelDomain,
  input: ModelConfigUpdate,
  expectedVersion: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        domain,
        provider: input.provider,
        modelName: input.modelName,
        expectedVersion,
        credentialPresent: input.credential !== undefined,
        credentialFingerprint:
          input.credential === undefined
            ? null
            : createHash("sha256").update(input.credential).digest("hex"),
      }),
    )
    .digest("hex");
}

/** 生成配置变更审计快照，明确排除 secretRef 和 credential。 */
function auditConfig(config: StoredModelConfig): Record<string, unknown> {
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

/** 在模型设置事务中追加脱敏运行事件，保证配置和审计不会跨事务分裂。 */
function appendRuntimeEvent(
  connection: import("better-sqlite3").Database,
  eventType: string,
  traceId: string,
  payload: Record<string, unknown>,
): void {
  connection
    .prepare(
      "INSERT INTO runtime_events (event_type,trace_id,payload,occurred_at) VALUES (?,?,?,?)",
    )
    .run(eventType, traceId, redactJson(payload), utcNow());
}
