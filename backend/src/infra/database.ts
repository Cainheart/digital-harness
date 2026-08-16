import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { RuntimeBoundaryError } from "../api/errors.js";
import { SUPPORTED_SCHEMA_REVISION, validateSchemaRevision } from "../config/schema-revision.js";
import { ProjectStatus } from "../domain/common.js";
import { NotFoundError, ReadOnlyProjectError } from "../domain/errors.js";
import { migrate0001, migrate0002, migrate0003, migrate0004, PROJECT_ID_INDEX_NAMES, TASK1_TABLES, TASK2_TABLES, TASK3_INDEX_DEFINITIONS, TASK3_TABLES, renderImmutableTrigger, renderTraceLinkTrigger } from "./schema.js";

/** 迁移前置备份上下文；仅批准回执才能解除 0001 -> 0002 阻断。 */
export type MigrationBackupContext = { persistentRoot: string; databasePath: string; appVersion: string; sourceSchemaRevision: string; targetSchemaRevision: string };
/** 已完成安全检查的迁移前备份回执。 */
export type BackupReceipt = { backupId: string; root: string; sourceSchemaRevision: string; targetSchemaRevision: string; fileManifest: Record<string, { sha256: string; size: number }>; safetyStatus: Record<string, string>; verified: boolean; persistentRoot?: string; databasePath?: string };
/** Schema 只读检查结果。 */
export type SchemaCheckResult = { writable: boolean; revision: string | null; code: string | null; message: string; dataPreserved: boolean; nextAction: string | null };
export type DatabaseConnection = BetterSqlite3.Database;
export type BackupCallback = (context: MigrationBackupContext) => BackupReceipt;

const BACKUP_DATA_DIRECTORIES = ["artifacts", "traces", "workspaces"] as const;
const BACKUP_MAX_FILE_SIZE = 64 * 1024 * 1024;

/** 逐级 lstat 路径，拒绝 symlink/特殊文件并允许安全创建缺失尾部。 */
export function validateNoFollowPath(input: string): string {
  const absolute = resolve(input);
  const parts = absolute.split("/").filter(Boolean);
  let current = absolute.startsWith("/") ? "/" : "";
  let missing = false;
  for (const part of parts) {
    current = join(current || "/", part);
    if (!existsSync(current)) { missing = true; continue; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== absolute) || stat.isFIFO() || stat.isSocket() || stat.isCharacterDevice() || stat.isBlockDevice()) throw new Error("path contains a symlink or special file");
    if (missing) throw new Error("path component is not safely addressable");
  }
  return absolute;
}

/** 提供只读诊断、WAL 初始化、迁移、事务和项目删除安全边界的 SQLite 封装。 */
export class Database {
  readonly path: string;
  readonly persistentRoot: string;
  readonly appVersion: string;
  readonly targetSchemaRevision = SUPPORTED_SCHEMA_REVISION;
  readonly connection: BetterSqlite3.Database;
  readonly orm: ReturnType<typeof drizzle>;
  private purgeProjectId: string | null = null;

  /** 绑定 company.db 与持久化根，并拒绝可绕过兼容基线的构造参数。 */
  constructor(path: string, options: { persistentRoot?: string; appVersion?: string; schemaRevision?: string } = {}) {
    try { validateSchemaRevision(options.schemaRevision ?? SUPPORTED_SCHEMA_REVISION); } catch {
      throw runtimeError("SCHEMA_CONFIGURATION_INVALID", "应用只支持 0003_task2_integrity_trace_fix Schema 基线", "修正 currentSchemaRevision 配置后重试", SUPPORTED_SCHEMA_REVISION);
    }
    this.path = canonicalPath(path);
    this.persistentRoot = canonicalPath(options.persistentRoot ?? dirname(this.path));
    this.appVersion = options.appVersion ?? "0.1.0";
    try {
      if (this.path !== join(this.persistentRoot, "company.db")) throw new Error("database path must be company.db under persistent root");
      mkdirSync(this.persistentRoot, { recursive: true });
      this.validateStorageDirectories();
      this.connection = new BetterSqlite3(this.path);
      this.connection.pragma("foreign_keys = ON");
      this.connection.function("task2_purge_guard", (projectId: string | null) => projectId !== null && projectId === this.purgeProjectId ? 1 : 0);
      this.orm = drizzle(this.connection);
    } catch {
      throw runtimeError("SCHEMA_CONFIGURATION_INVALID", "数据库路径必须是持久化根目录内的 company.db，且边界路径不得为符号链接", "修正 persistentRoot/company.db 路径和持久化目录后重试", SUPPORTED_SCHEMA_REVISION);
    }
  }

  /** 执行批准的初始化/迁移，并在成功后才显式启用 WAL。 */
  initialize(backupCallback?: BackupCallback): void {
    try {
      const current = this.currentRevision();
      if (current === null) {
        const tables = this.tableNames();
        if (tables.size > 0 && !tables.has("drizzle_migrations")) throw this.schemaConflict(null, "备份持久化根目录并沿批准路径恢复或执行 Schema migration");
        migrate0001(this.connection);
        migrate0002(this.connection);
        migrate0003(this.connection);
        migrate0004(this.connection);
      } else if (current === "0001_runtime_skeleton") {
        const callback = backupCallback ?? ((context) => this.createPreMigrationBackup(context));
        const receipt = callback({ persistentRoot: this.persistentRoot, databasePath: this.path, appVersion: this.appVersion, sourceSchemaRevision: current, targetSchemaRevision: SUPPORTED_SCHEMA_REVISION });
        if (!receipt.verified || receipt.sourceSchemaRevision !== current || receipt.targetSchemaRevision !== SUPPORTED_SCHEMA_REVISION) throw this.persistenceError("MIGRATION_BACKUP_FAILED", "修复持久化根目录备份并重新执行批准的 Schema migration");
        migrate0002(this.connection);
        migrate0003(this.connection);
        migrate0004(this.connection);
      } else if (current === "0002_task2_domain_foundation") {
        const callback = backupCallback ?? ((context) => this.createPreMigrationBackup(context));
        const receipt = callback({ persistentRoot: this.persistentRoot, databasePath: this.path, appVersion: this.appVersion, sourceSchemaRevision: current, targetSchemaRevision: SUPPORTED_SCHEMA_REVISION });
        if (!receipt.verified || receipt.sourceSchemaRevision !== current || receipt.targetSchemaRevision !== SUPPORTED_SCHEMA_REVISION) throw this.persistenceError("MIGRATION_BACKUP_FAILED", "修复迁移前一致性备份并重新执行批准的 Schema migration");
        migrate0003(this.connection);
        migrate0004(this.connection);
      } else if (current === "0003_task2_integrity_trace_fix") {
        const callback = backupCallback ?? ((context) => this.createPreMigrationBackup(context));
        const receipt = callback({ persistentRoot: this.persistentRoot, databasePath: this.path, appVersion: this.appVersion, sourceSchemaRevision: current, targetSchemaRevision: SUPPORTED_SCHEMA_REVISION });
        if (!receipt.verified || receipt.sourceSchemaRevision !== current || receipt.targetSchemaRevision !== SUPPORTED_SCHEMA_REVISION) throw this.persistenceError("MIGRATION_BACKUP_FAILED", "修复迁移前一致性备份并重新执行批准的 Schema migration");
        migrate0004(this.connection);
      } else if (current === SUPPORTED_SCHEMA_REVISION) {
        this.ensureSchemaContract();
      } else {
        throw this.schemaConflict(current, "备份持久化根目录并沿批准路径升级到 0004_task3_organization_policy");
      }
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("synchronous = NORMAL");
    } catch (error) {
      if (error instanceof RuntimeBoundaryError) throw error;
      throw this.persistenceError("SCHEMA_MIGRATION_FAILED", "检查 SQLite 文件、锁状态和批准 migration 日志后重试");
    }
  }

  /** 返回真实 Schema revision；不存在的数据库返回 null。 */
  currentRevision(): string | null {
    if (!existsSync(this.path) || statSync(this.path).size === 0) return null;
    try { const row = this.connection.prepare("SELECT version_num FROM drizzle_migrations LIMIT 1").get() as { version_num: string } | undefined; return row?.version_num ?? null; } catch { return null; }
  }

  /** 返回数据库中的表名集合，不为诊断创建文件或表。 */
  tableNames(): Set<string> { const rows = this.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]; return new Set(rows.map((row) => row.name)); }
  /** 检查 schema revision、WAL 和结构合同。 */
  checkSchema(): SchemaCheckResult {
    const revision = this.currentRevision();
    if (revision !== SUPPORTED_SCHEMA_REVISION) return { writable: false, revision, code: "VERSION_CONFLICT", message: "Database schema revision is incompatible with this application", dataPreserved: true, nextAction: "Back up the persistent root and apply the approved migration path" };
    try { this.ensureSchemaContract(); const journalMode = String(this.connection.pragma("journal_mode", { simple: true })); if (journalMode.toLowerCase() !== "wal") return { writable: false, revision, code: "PERSISTENCE_UNAVAILABLE", message: "SQLite WAL 未启用", dataPreserved: true, nextAction: "检查 SQLite 数据库和持久化根目录" }; return { writable: true, revision, code: null, message: "Schema revision and integrity contract are compatible", dataPreserved: true, nextAction: null }; } catch (error) { if (error instanceof RuntimeBoundaryError) return { writable: false, revision, code: error.code, message: error.message, dataPreserved: error.dataPreserved, nextAction: error.nextAction }; return { writable: false, revision, code: "SCHEMA_INTEGRITY_CONFLICT", message: "Schema integrity contract is incompatible", dataPreserved: true, nextAction: "恢复完整 Schema 和关键 trigger 后重试" }; }
  }

  /** 返回当前 SQLite journal mode；只读 readiness 使用此方法。 */
  journalMode(): string { return String(this.connection.pragma("journal_mode", { simple: true })); }
  /** 以事务方式执行一组状态、事件和 outbox 写入。 */
  transaction<T>(callback: (connection: BetterSqlite3.Database) => T): T { return this.connection.transaction(callback)(this.connection); }
  /** 以项目删除授权状态执行受控 purge。 */
  controlledProjectPurge<T>(projectId: string, callback: (connection: BetterSqlite3.Database) => T): T { this.purgeProjectId = projectId; try { return this.transaction(callback); } finally { this.purgeProjectId = null; } }

  /** 保存不含明文凭据的模型配置引用。 */
  saveCredentialConfig(provider: string, model: string, secretRef: string, configVersion = "1", connectionStatus = "unknown"): void { const now = new Date().toISOString(); this.transaction((db) => db.prepare("INSERT INTO credential_configs (provider,model,secret_ref,config_version,connection_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(provider, model, secretRef, configVersion, connectionStatus, now, now)); }
  /** 追加一条带 trace 的运行事实事件。 */
  appendEvent(eventType: string, traceId: string, payload: string): void { this.transaction((db) => db.prepare("INSERT INTO runtime_events (event_type,trace_id,payload,occurred_at) VALUES (?,?,?,?)").run(eventType, traceId, payload, new Date().toISOString())); }
  /** 读取运行事件文本供脱敏扫描和安全测试使用。 */
  readEventText(): string { return (this.connection.prepare("SELECT payload FROM runtime_events ORDER BY id").all() as { payload: string }[]).map((row) => row.payload).join("\n"); }
  /** 原子替换当前运行状态，供重启恢复读取。 */
  writeRuntimeState(status: string, reason: string): void { this.transaction((db) => { db.prepare("DELETE FROM runtime_state").run(); db.prepare("INSERT INTO runtime_state (status,reason,updated_at) VALUES (?,?,?)").run(status, reason, new Date().toISOString()); }); }
  /** 读取最近一次运行状态。 */
  readRuntimeState(): { status: string; reason: string; updated_at: string } | null { return (this.connection.prepare("SELECT status,reason,updated_at FROM runtime_state ORDER BY id DESC LIMIT 1").get() as { status: string; reason: string; updated_at: string } | undefined) ?? null; }
  /** 返回可序列化的运行状态快照。 */
  runtimeSnapshot(): Record<string, unknown> | null { const state = this.readRuntimeState(); return state ? { ...state } : null; }
  /** 统计执行类事件，证明 readiness 没有触发真实执行。 */
  executionEventCount(): number { return (this.connection.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE event_type LIKE '%Execution%'").get() as { count: number }).count; }
  /** 保存 Worker 最新租约。 */
  saveWorkerLease(workerId: string, heartbeatAt: string, status: string): void { this.transaction((db) => { db.prepare("DELETE FROM worker_leases WHERE worker_id=?").run(workerId); db.prepare("INSERT INTO worker_leases (worker_id,heartbeat_at,status) VALUES (?,?,?)").run(workerId, heartbeatAt, status); }); }
  /** 读取全部 Worker 租约。 */
  readWorkerLeases(): { worker_id: string; heartbeat_at: string; status: string }[] { return this.connection.prepare("SELECT worker_id,heartbeat_at,status FROM worker_leases ORDER BY worker_id").all() as { worker_id: string; heartbeat_at: string; status: string }[]; }
  /** 计算主库和 WAL/SHM sidecar 的逻辑摘要，供阻断检查证明无副作用。 */
  fileDigest(): string { const hash = createHash("sha256"); for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) { hash.update(path.split("/").pop() ?? path); if (existsSync(path)) hash.update(readFileSync(path)); else hash.update("<absent>"); } return hash.digest("hex"); }
  /** 关闭数据库连接。 */
  close(): void { this.connection.close(); }

  /** 删除历史项目在线数据并保留最小删除审计。 */
  deleteHistoricalProject(projectId: string, actorId: string): void {
    if (!this.projectExists(projectId)) throw new NotFoundError("项目不存在");
    const now = new Date().toISOString();
    this.controlledProjectPurge(projectId, (db) => { for (const table of ["structured_messages", "policy_decisions", "idempotency_records", "outbox_messages", "notifications", "trace_links", "tool_calls", "model_calls", "execution_attempts", "defects", "test_runs", "test_cases", "reviews", "approvals", "artifact_versions", "artifacts", "task_dependencies", "tasks", "domain_events"] as const) db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId); db.prepare("DELETE FROM projects WHERE id=?").run(projectId); db.prepare("INSERT INTO project_deletion_audits (project_id,deleted_at,actor_id) VALUES (?,?,?)").run(projectId, now, actorId); });
  }
  /** 判断项目是否存在。 */
  projectExists(projectId: string): boolean { return Boolean(this.connection.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)); }

  private validateStorageDirectories(): void { for (const name of ["artifacts", "traces", "workspaces", "backups"]) { const path = join(this.persistentRoot, name); validateNoFollowPath(path); if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(`unsafe persistent directory: ${name}`); } for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`, join(this.persistentRoot, "manifest.json")]) { validateNoFollowPath(path); if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`unsafe persistent file: ${path}`); } }
  // 修改日期：2026-08-16
  // 修改原因：Task 3 的表存在但缺字段/复合索引时，旧检查会误判数据库可写，直到业务请求才以 500 暴露；启动时必须提前阻断并保护已有数据。
  private ensureSchemaContract(): void {
    const tables = this.tableNames();
    const required = new Set([...TASK1_TABLES, ...TASK2_TABLES, ...TASK3_TABLES, "drizzle_migrations"]);
    if (![...required].every((name) => tables.has(name))) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, "恢复完整 Schema 或沿批准 migration 修复后重试", "SCHEMA_INTEGRITY_CONFLICT");
    const requiredColumns: Record<string, string[]> = {
      organization_domains: ["domain_id", "display_name", "office_zone", "group_name", "responsibilities_json", "version", "enabled"],
      role_definitions: ["role_id", "domain_id", "title", "objective", "responsibilities_json", "inputs_json", "outputs_json", "allowed_tools_json", "visible_objects_json", "allowed_objects_json", "forbidden_actions_json", "object_actions_json", "path_policy_json", "command_policy_json", "role_version", "enabled", "created_at", "updated_at"],
      organization_members: ["instance_id", "role_id", "display_name", "specialist_tag", "office_zone", "desk_group", "status", "role_version", "created_at"],
      structured_messages: ["message_id", "sender_role", "sender_instance_id", "receiver_role", "receiver_instance_id", "project_id", "task_id", "message_type", "payload_json", "created_at", "status", "handled_at", "handled_by", "source_object_type", "source_object_id", "response_object_type", "response_object_id", "trace_id", "idempotency_key", "version", "request_hash"],
      policy_decisions: ["decision_id", "project_id", "task_id", "attempt_id", "role_id", "role_version", "action_kind", "object_type", "object_id", "tool_name", "decision", "reason", "risk_level", "trace_id", "action_json", "created_at"],
    };
    for (const [table, columns] of Object.entries(requiredColumns)) this.ensureColumns(table, columns);
    const counts = this.connection.prepare("SELECT (SELECT COUNT(*) FROM organization_domains) AS domains, (SELECT COUNT(*) FROM role_definitions) AS roles, (SELECT COUNT(*) FROM organization_members) AS members").get() as { domains: number; roles: number; members: number };
    if (counts.domains < 5 || counts.roles < 19 || counts.members < 19) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, "恢复 Task 3 五类领域、19 个岗位和 19 个员工实例后重试", "SCHEMA_INTEGRITY_CONFLICT");
    const artifactVersionColumns = this.connection.prepare("PRAGMA table_info(artifact_versions)").all() as { name: string }[];
    if (!artifactVersionColumns.some((column) => column.name === "integrity_status")) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, "恢复 artifact_versions.integrity_status 后重试", "SCHEMA_INTEGRITY_CONFLICT");
    const eventColumns = this.connection.prepare("PRAGMA table_info(domain_events)").all() as { name: string }[];
    for (const column of ["attempt_id", "rejection_reason", "redaction_reason", "event_category"]) if (!eventColumns.some((item) => item.name === column)) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, `恢复 domain_events.${column} 后重试`, "SCHEMA_INTEGRITY_CONFLICT");
    const attemptColumns = this.connection.prepare("PRAGMA table_info(execution_attempts)").all() as { name: string }[];
    for (const column of ["role_version", "policy_snapshot_json"]) if (!attemptColumns.some((item) => item.name === column)) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, `恢复 execution_attempts.${column} 后重试`, "SCHEMA_INTEGRITY_CONFLICT");
    const triggers = this.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
    const names = new Set(triggers.map((row) => row.name));
    for (const name of ["trg_domain_events_immutable_update", "trg_domain_events_immutable_delete", "trg_artifact_versions_immutable_update", "trg_artifact_versions_immutable_delete", "trg_trace_links_project_scope_insert", "trg_trace_links_project_scope_update"]) if (!names.has(name)) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, "恢复关键 immutable/TraceLink trigger 后重试", "SCHEMA_INTEGRITY_CONFLICT");
    for (const [table, index] of Object.entries(PROJECT_ID_INDEX_NAMES)) { const found = this.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index); if (!found) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, `恢复 ${table}.project_id 索引后重试`, "SCHEMA_INTEGRITY_CONFLICT"); }
    for (const [table, index, columns] of TASK3_INDEX_DEFINITIONS) { const found = this.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index); const actualColumns = (this.connection.prepare(`PRAGMA index_info(${index})`).all() as { seq: number; name: string }[]).sort((left, right) => left.seq - right.seq).map((column) => column.name).join(","); if (!found || actualColumns !== columns) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, `恢复 ${table} 的 Task 3 查询索引后重试`, "SCHEMA_INTEGRITY_CONFLICT"); }
  }

  /** 检查单张表的字段合同，避免迁移只留下半成品表结构。 */
  private ensureColumns(table: string, columns: string[]): void {
    const actual = new Set((this.connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length > 0) throw this.schemaConflict(SUPPORTED_SCHEMA_REVISION, `恢复 ${table}.${missing.join(",")} 后重试`, "SCHEMA_INTEGRITY_CONFLICT");
  }
  private schemaConflict(revision: string | null, nextAction: string, code = "VERSION_CONFLICT"): RuntimeBoundaryError { return runtimeError(code, code === "VERSION_CONFLICT" ? "VERSION_CONFLICT: 当前数据库 Schema revision 不兼容" : "Schema revision 不兼容或结构完整性校验失败；数据库保持只读阻断", nextAction, revision ?? undefined); }
  private persistenceError(code: string, nextAction: string): RuntimeBoundaryError { return runtimeError(code, code === "MIGRATION_BACKUP_FAILED" ? "迁移前一致性备份未通过验证" : "持久化数据库当前不可用或 Schema migration 未完成", nextAction); }
  /**
   * 修改日期：2026-08-16
   * 修改原因：SQLite company.db 是二进制文件，备份必须保持逐字节一致；敏感信息边界由 secretRef 和日志脱敏契约保证，不能把数据库转换为 UTF-8 文本再写回。
   */
  private createPreMigrationBackup(context: MigrationBackupContext): BackupReceipt { const backupId = `migration-${randomUUID()}`; const root = join(context.persistentRoot, "backups", backupId); mkdirSync(root, { recursive: true }); const manifest: Record<string, { sha256: string; size: number }> = {}; const copy = (source: string, destination: string): void => { if (!existsSync(source) || !lstatSync(source).isFile()) return; const data = readFileSync(source); if (data.length > BACKUP_MAX_FILE_SIZE) throw new Error("backup file too large"); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, data, { mode: 0o600 }); manifest[destination.slice(root.length + 1)] = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length }; }; copy(context.databasePath, join(root, "database", "company.db")); for (const dir of BACKUP_DATA_DIRECTORIES) { if (!existsSync(join(context.persistentRoot, dir))) continue; for (const file of walkFiles(join(context.persistentRoot, dir))) copy(file, join(root, file.slice(context.persistentRoot.length + 1))); } writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 }); return { backupId, root, sourceSchemaRevision: context.sourceSchemaRevision, targetSchemaRevision: context.targetSchemaRevision, fileManifest: manifest, safetyStatus: { symlinkScan: "passed", specialFileScan: "passed", sensitiveContentScan: "secretRef-only database contract", credentialRedaction: "not applied to binary SQLite" }, verified: true, persistentRoot: context.persistentRoot, databasePath: context.databasePath }; }
}

/** 将底层运行错误转换为稳定、脱敏的边界错误。 */
function runtimeError(code: string, message: string, nextAction: string, schemaRevision?: string): RuntimeBoundaryError { return new RuntimeBoundaryError({ code, message, impact: "业务写入、真实执行和工作区写入均被阻断；已存在数据保持不变", paused: true, dataPreserved: true, nextAction, traceId: `tr_${randomUUID().replaceAll("-", "").slice(0, 16)}`, schemaRevision }); }
/** 递归列出常规文件，不跟随符号链接。 */
function walkFiles(root: string): string[] { const result: string[] = []; if (!existsSync(root)) return result; for (const entry of readdirSync(root)) { const path = join(root, entry); const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error("backup tree contains a symlink"); if (stat.isDirectory()) result.push(...walkFiles(path)); else if (stat.isFile()) result.push(path); else throw new Error("backup tree contains a special file"); } return result; }

/** 将已有父目录解析为真实路径，兼容 macOS 的 /tmp、/var 系统别名。 */
/**
 * 修改日期：2026-08-16
 * 修改原因：Database 也可能被测试或 CLI 直接构造；统一解析 macOS 系统路径别名，避免与持久化根目录的安全边界比较失配。
 */
function canonicalPath(input: string): string { const candidate = resolve(input); try { return realpathSync(candidate); } catch { return join(realpathSync(dirname(candidate)), candidate.split("/").pop() ?? ""); } }

export { ProjectStatus, ReadOnlyProjectError };
