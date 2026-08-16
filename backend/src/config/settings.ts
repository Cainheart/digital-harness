import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  SUPPORTED_SCHEMA_REVISION,
  validateSchemaRevision,
} from "./schema-revision.js";

/** 读取并验证本地控制面的运行配置；控制面始终只绑定回环地址。 */
export class Settings {
  readonly persistentRoot: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly appVersion: string;
  readonly currentSchemaRevision: typeof SUPPORTED_SCHEMA_REVISION;
  readonly artifactMaxSizeBytes: number;
  readonly allowRealExecution: boolean;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly modelSecretRef: string;

  /** 从显式配置和 DIGITAL_HARNESS_* 环境变量构造不可变设置。 */
  constructor(input: Partial<SettingsInput> & { persistentRoot: string }) {
    if (!input.persistentRoot.trim()) {
      throw new Error("persistentRoot must be non-empty");
    }

    const host = input.host ?? process.env.DIGITAL_HARNESS_HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1") {
      throw new Error("控制面只允许绑定 127.0.0.1");
    }
    const revision =
      input.currentSchemaRevision ??
      process.env.DIGITAL_HARNESS_CURRENT_SCHEMA_REVISION ??
      SUPPORTED_SCHEMA_REVISION;
    const validatedRevision = validateSchemaRevision(revision);
    this.persistentRoot = canonicalPath(input.persistentRoot);
    this.host = "127.0.0.1";
    const port = input.port ?? Number(process.env.DIGITAL_HARNESS_PORT ?? 8765);
    validatePort(port);
    this.port = port;
    this.appVersion =
      input.appVersion ?? process.env.DIGITAL_HARNESS_APP_VERSION ?? "0.1.0";
    this.currentSchemaRevision = validatedRevision;
    const artifactMaxSizeBytes =
      input.artifactMaxSizeBytes ??
      Number(
        process.env.DIGITAL_HARNESS_ARTIFACT_MAX_SIZE_BYTES ?? 64 * 1024 * 1024,
      );
    validatePositiveInteger(artifactMaxSizeBytes, "artifactMaxSizeBytes");
    this.artifactMaxSizeBytes = artifactMaxSizeBytes;
    this.allowRealExecution =
      input.allowRealExecution ??
      process.env.DIGITAL_HARNESS_ALLOW_REAL_EXECUTION === "true";
    this.modelProvider =
      input.modelProvider ??
      process.env.DIGITAL_HARNESS_MODEL_PROVIDER ??
      "unconfigured";
    this.modelName =
      input.modelName ??
      process.env.DIGITAL_HARNESS_MODEL_NAME ??
      "unconfigured";
    this.modelSecretRef =
      input.modelSecretRef ??
      process.env.DIGITAL_HARNESS_MODEL_SECRET_REF ??
      "keychain://unconfigured";
  }

  /** 返回业务数据库路径。 */
  get databasePath(): string {
    return join(this.persistentRoot, "company.db");
  }
  /** 返回 Artifact Store 路径。 */
  get artifactPath(): string {
    return join(this.persistentRoot, "artifacts");
  }
  /** 返回追踪和运行证据路径。 */
  get tracePath(): string {
    return join(this.persistentRoot, "traces");
  }
  /** 返回工作区路径。 */
  get workspacePath(): string {
    return join(this.persistentRoot, "workspaces");
  }
  /** 返回备份路径。 */
  get backupPath(): string {
    return join(this.persistentRoot, "backups");
  }
}

export type SettingsInput = {
  persistentRoot: string;
  host?: string;
  port?: number;
  appVersion?: string;
  currentSchemaRevision?: string;
  artifactMaxSizeBytes?: number;
  allowRealExecution?: boolean;
  modelProvider?: string;
  modelName?: string;
  modelSecretRef?: string;
};

/** 检查监听端口，避免运行时才由 Node.js 抛出难以定位的端口错误。 */
function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
}

/** 检查受资源限制保护的正整数配置。 */
function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

/**
 * 修改日期：2026-08-16
 * 修改原因：macOS 的 /tmp、/var 可能是系统路径别名；先解析已有父目录，避免安全校验把合法持久化根误判为 symlink。
 */
function canonicalPath(input: string): string {
  const candidate = resolve(input);
  try {
    return realpathSync(candidate);
  } catch (_error) {
    return join(realpathSync(dirname(candidate)), basename(candidate));
  }
}
