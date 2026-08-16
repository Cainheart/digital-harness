import type BetterSqlite3 from "better-sqlite3";
import {
  ModelConnectionStatus,
  ModelDomain,
  ModelProvider,
  StoredModelConfig,
} from "../../domain/model-config.js";
import { NotFoundError } from "../../domain/errors.js";

/** 保存五领域模型配置和不可变配置变更审计的 SQLite 仓储。 */
export class ModelConfigRepository {
  /** 按固定领域顺序读取全部模型配置，不返回凭据原文。 */
  list(connection: BetterSqlite3.Database): StoredModelConfig[] {
    const rows = connection
      .prepare("SELECT * FROM model_configs ORDER BY rowid")
      .all() as ModelConfigRow[];
    return rows.map(modelConfigFromRow);
  }

  /** 读取单领域配置；配置行由 Task 5 migration 预置。 */
  get(
    connection: BetterSqlite3.Database,
    domain: ModelDomain,
  ): StoredModelConfig {
    const row = connection
      .prepare("SELECT * FROM model_configs WHERE domain=?")
      .get(domain) as ModelConfigRow | undefined;
    if (!row) throw new NotFoundError("模型领域配置不存在");
    return modelConfigFromRow(row);
  }

  /** 以 expectedConfigVersion 条件更新配置，避免并发覆盖新版本。 */
  update(
    connection: BetterSqlite3.Database,
    input: {
      domain: ModelDomain;
      provider: ModelProvider | "unconfigured";
      modelName: string;
      configVersion: number;
      secretRef: string | null;
      credentialStatus: "configured" | "missing";
      connectionStatus: ModelConnectionStatus;
      lastErrorCode: string | null;
      lastErrorAt: string | null;
      updatedAt: string;
      expectedConfigVersion: number;
    },
  ): void {
    const result = connection
      .prepare(
        `UPDATE model_configs
         SET provider=?,model_name=?,config_version=?,secret_ref=?,credential_status=?,
             connection_status=?,last_error_code=?,last_error_at=?,updated_at=?
         WHERE domain=? AND config_version=?`,
      )
      .run(
        input.provider,
        input.modelName,
        input.configVersion,
        input.secretRef,
        input.credentialStatus,
        input.connectionStatus,
        input.lastErrorCode,
        input.lastErrorAt,
        input.updatedAt,
        input.domain,
        input.expectedConfigVersion,
      );
    if (result.changes !== 1) {
      throw new Error("model config version changed during update");
    }
  }

  /** 只更新连接状态和最后错误，不增加模型配置版本。 */
  updateConnectionStatus(
    connection: BetterSqlite3.Database,
    input: {
      domain: ModelDomain;
      configVersion: number;
      connectionStatus: ModelConnectionStatus;
      lastErrorCode: string | null;
      lastErrorAt: string | null;
      updatedAt: string;
    },
  ): void {
    const result = connection
      .prepare(
        `UPDATE model_configs
         SET connection_status=?,last_error_code=?,last_error_at=?,updated_at=?
         WHERE domain=? AND config_version=?`,
      )
      .run(
        input.connectionStatus,
        input.lastErrorCode,
        input.lastErrorAt,
        input.updatedAt,
        input.domain,
        input.configVersion,
      );
    if (result.changes !== 1) {
      throw new Error("model config version changed during connection update");
    }
  }

  /** 保存不含 secretRef 的前后版本审计和幂等键。 */
  saveChange(
    connection: BetterSqlite3.Database,
    change: {
      id: string;
      domain: ModelDomain;
      previousConfig: Record<string, unknown>;
      nextConfig: Record<string, unknown>;
      expectedConfigVersion: number;
      idempotencyKey: string;
      requestHash: string;
      traceId: string;
      createdAt: string;
    },
  ): void {
    connection
      .prepare(
        `INSERT INTO model_config_changes
         (id,domain,previous_config_json,next_config_json,expected_config_version,
          idempotency_key,request_hash,trace_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        change.id,
        change.domain,
        JSON.stringify(change.previousConfig),
        JSON.stringify(change.nextConfig),
        change.expectedConfigVersion,
        change.idempotencyKey,
        change.requestHash,
        change.traceId,
        change.createdAt,
      );
  }

  /** 读取幂等键已经保存的请求指纹和脱敏响应内容。 */
  getChangeByIdempotencyKey(
    connection: BetterSqlite3.Database,
    idempotencyKey: string,
  ): ModelConfigChange | null {
    const row = connection
      .prepare("SELECT * FROM model_config_changes WHERE idempotency_key=?")
      .get(idempotencyKey) as ModelConfigChangeRow | undefined;
    return row ? modelConfigChangeFromRow(row) : null;
  }
}

/** 模型配置变更的可审计安全摘要。 */
export type ModelConfigChange = {
  id: string;
  domain: ModelDomain;
  previousConfig: Record<string, unknown>;
  nextConfig: Record<string, unknown>;
  expectedConfigVersion: number;
  idempotencyKey: string;
  requestHash: string;
  traceId: string;
  createdAt: string;
};

type ModelConfigRow = {
  domain: string;
  provider: string;
  model_name: string;
  config_version: number;
  secret_ref: string | null;
  credential_status: "configured" | "missing";
  connection_status: ModelConnectionStatus;
  last_error_code: string | null;
  last_error_at: string | null;
  updated_at: string;
};
type ModelConfigChangeRow = {
  id: string;
  domain: ModelDomain;
  previous_config_json: string;
  next_config_json: string;
  expected_config_version: number;
  idempotency_key: string;
  request_hash: string;
  trace_id: string;
  created_at: string;
};

/** 将 SQLite 配置行转换为应用内部模型，不把未知供应商默认为可调用。 */
function modelConfigFromRow(row: ModelConfigRow): StoredModelConfig {
  return {
    domain: row.domain as ModelDomain,
    provider: row.provider as ModelProvider | "unconfigured",
    modelName: row.model_name,
    configVersion: Number(row.config_version),
    secretRef: row.secret_ref,
    credentialStatus: row.credential_status,
    connectionStatus: row.connection_status,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    updatedAt: row.updated_at,
  };
}

/** 将配置变更行转换为安全 JSON 对象，供幂等和审计查询使用。 */
function modelConfigChangeFromRow(
  row: ModelConfigChangeRow,
): ModelConfigChange {
  return {
    id: row.id,
    domain: row.domain,
    previousConfig: JSON.parse(row.previous_config_json) as Record<string, unknown>,
    nextConfig: JSON.parse(row.next_config_json) as Record<string, unknown>,
    expectedConfigVersion: row.expected_config_version,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}
