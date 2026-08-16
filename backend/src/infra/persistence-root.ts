import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RuntimeBoundaryError } from "../api/errors.js";
import {
  SUPPORTED_SCHEMA_REVISION,
  validateSchemaRevision,
} from "../config/schema-revision.js";
import { BackupCallback, Database, validateNoFollowPath } from "./database.js";

/** 初始化并维护业务数据、证据、工作区和备份的持久化根目录。 */
export class PersistenceRoot {
  static readonly DATA_DIRECTORIES = [
    "artifacts",
    "traces",
    "workspaces",
    "backups",
  ] as const;
  readonly root: string;
  readonly appVersion: string;
  readonly schemaRevision: typeof SUPPORTED_SCHEMA_REVISION;

  /** 绑定持久化根目录及其应用和 Schema 版本信息。 */
  constructor(
    root: string,
    options: { appVersion: string; schemaRevision: string },
  ) {
    this.root = canonicalPath(root);
    try {
      this.schemaRevision = validateSchemaRevision(options.schemaRevision);
    } catch (_error) {
      throw new RuntimeBoundaryError({
        code: "SCHEMA_CONFIGURATION_INVALID",
        message: `持久化根目录只接受 ${SUPPORTED_SCHEMA_REVISION} Schema 基线`,
        impact: "manifest 未写入，业务写入和真实执行保持阻断",
        paused: true,
        dataPreserved: true,
        nextAction: "修正 currentSchemaRevision 配置后重试",
        traceId: "tr_persistence_root_schema",
        schemaRevision: SUPPORTED_SCHEMA_REVISION,
      });
    }
    this.appVersion = options.appVersion;
  }

  /** 返回持久化根目录下的业务数据库路径。 */
  get databasePath(): string {
    return join(this.root, "company.db");
  }
  /** 返回版本清单路径。 */
  get manifestPath(): string {
    return join(this.root, "manifest.json");
  }

  /** 创建数据目录，并按需要原子写入当前版本清单。 */
  initialize(updateManifest?: boolean): Record<string, unknown> | null {
    this.ensureLayout();
    if (updateManifest === false) return null;
    if (updateManifest === undefined && existsSync(this.manifestPath)) {
      try {
        const value = JSON.parse(
          readFileSync(this.manifestPath, "utf8"),
        ) as unknown;
        if (!isManifest(value)) {
          throw new Error("manifest shape is invalid");
        }
        return value;
      } catch (_error) {
        throw new RuntimeBoundaryError({
          code: "PERSISTENCE_UNAVAILABLE",
          message: "版本清单不可解析，未继续使用该持久化根目录",
          impact: "业务写入、真实执行和工作区写入均被阻断",
          paused: true,
          dataPreserved: true,
          nextAction: "备份并修复 manifest.json 后重试",
          traceId: "tr_persistence_manifest",
          schemaRevision: this.schemaRevision,
        });
      }
    }
    const manifest = {
      appVersion: this.appVersion,
      schemaRevision: this.schemaRevision,
      directories: [...PersistenceRoot.DATA_DIRECTORIES],
      generatedAt: new Date().toISOString(),
    };
    this.writeManifestAtomically(manifest);
    return manifest;
  }

  /** 只创建持久化根目录及数据子目录，不改写既有业务文件。 */
  ensureLayout(): void {
    try {
      validateNoFollowPath(this.root);
      mkdirSync(this.root, { recursive: true });
      for (const directory of PersistenceRoot.DATA_DIRECTORIES) {
        const path = join(this.root, directory);
        validateNoFollowPath(path);
        if (existsSync(path) && !lstatSync(path).isDirectory())
          throw new Error(`unsafe directory ${directory}`);
        mkdirSync(path, { recursive: true });
      }
      for (const path of [
        this.databasePath,
        `${this.databasePath}-wal`,
        `${this.databasePath}-shm`,
        this.manifestPath,
      ]) {
        validateNoFollowPath(path);
        if (existsSync(path) && !lstatSync(path).isFile())
          throw new Error(`unsafe persistent file ${path}`);
      }
    } catch (_error) {
      throw new RuntimeBoundaryError({
        code: "PERSISTENCE_UNAVAILABLE",
        message: "持久化根目录或数据子目录不可安全使用",
        impact: "业务写入、真实执行和工作区写入均被阻断",
        paused: true,
        dataPreserved: true,
        nextAction: "修正持久化根目录权限、目录类型和符号链接后重试",
        traceId: "tr_persistence_root_layout",
        schemaRevision: this.schemaRevision,
      });
    }
  }

  /** 先读取真实 revision，再在初始化/迁移成功后提交 manifest 基线。 */
  initializeDatabase(
    database: Database,
    backupCallback?: BackupCallback,
  ): void {
    this.ensureLayout();
    const previous = database.currentRevision();
    database.initialize(backupCallback);
    // 修改日期：2026-08-16
    // 修改原因：迁移成功后 manifest 必须反映当前 revision；即使数据库已是最新版本，缺失 manifest 也不能被当作可恢复状态。
    if (
      previous !== database.targetSchemaRevision ||
      !existsSync(this.manifestPath)
    ) {
      this.initialize(true);
    } else {
      this.initialize();
    }
  }

  /** 通过同目录临时文件和 rename 原子替换 manifest。 */
  private writeManifestAtomically(manifest: Record<string, unknown>): void {
    const temporaryPath = join(this.root, `.manifest-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const descriptor = openSync(temporaryPath, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.manifestPath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}

/**
 * 修改日期：2026-08-16
 * 修改原因：持久化根目录需要与 Database 使用相同的真实路径基线，否则 macOS 系统路径别名会触发错误的边界阻断。
 */
function canonicalPath(input: string): string {
  const candidate = resolve(input);
  try {
    return realpathSync(candidate);
  } catch (_error) {
    return join(realpathSync(dirname(candidate)), basename(candidate));
  }
}

/** 校验版本清单的最小结构，避免把任意 JSON 当作已完成初始化的证据。 */
function isManifest(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.appVersion !== "string" ||
    !manifest.appVersion.trim() ||
    typeof manifest.schemaRevision !== "string" ||
    !Array.isArray(manifest.directories) ||
    typeof manifest.generatedAt !== "string"
  ) {
    return false;
  }

  try {
    validateSchemaRevision(manifest.schemaRevision);
  } catch (_error) {
    return false;
  }

  return manifest.directories.every(
    (directory) => typeof directory === "string" && directory.trim().length > 0,
  );
}
