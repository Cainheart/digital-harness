import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { SUPPORTED_SCHEMA_REVISION } from "../config/schema-revision.js";
import type { Database } from "../infra/database.js";
import { validateNoFollowPath } from "../infra/database.js";
import {
  BackupService,
  parseManifest,
  resolveSafePath,
  type BackupVerification,
} from "./backup.js";

/** 恢复校验报告；凭据永远不从备份包复制，只返回需要重新绑定的引用数。 */
export type RestoreReport = {
  restoreId: string;
  status: "VALID" | "APPLIED" | "FAILED";
  targetRoot: string;
  backupId: string;
  validatedAt: string;
  copiedFiles: string[];
  skippedItems: string[];
  failures: string[];
  manualActions: string[];
  rebindRequired: boolean;
};

/** 在空目标环境中执行 manifest、Schema、外键、事件和证据关联校验。 */
export class RestoreService {
  /** 绑定源数据库，仅用于记录当前恢复操作的审计上下文。 */
  constructor(
    private readonly database: Database,
    private readonly appVersion: string,
  ) {}

  /** 恢复前 dry-run；校验失败时绝不创建目标业务数据库。 */
  validate(backupPath: string, targetRoot: string): RestoreReport {
    const verification = this.verifyBackup(backupPath);
    const failures = [...verification.failures];
    const target = resolveSafePath(targetRoot);
    try {
      validateNoFollowPath(target);
      if (existsSync(target) && readdirSync(target).length > 0) {
        failures.push("目标持久化根目录不是空目录，恢复不会覆盖既有数据");
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "目标目录不可安全使用");
    }
    const consistency = validateBackupDatabase(backupPath);
    failures.push(...consistency);
    return {
      restoreId: `restore-${Date.now().toString(36)}`,
      status: failures.length === 0 ? "VALID" : "FAILED",
      targetRoot: target,
      backupId: verification.manifest.backup_id,
      validatedAt: new Date().toISOString(),
      copiedFiles: [],
      skippedItems: ["OS Keychain 凭据原文未进入恢复流程"],
      failures,
      manualActions: ["在目标环境重新绑定 secretRef 对应的 OS Keychain 凭据并完成连接测试"],
      rebindRequired: true,
    };
  }

  /** 在明确 changeTicket 和空目标环境下复制恢复数据，并生成恢复报告。 */
  apply(backupPath: string, targetRoot: string, changeTicket: string): RestoreReport {
    if (!changeTicket.trim()) throw new Error("生产恢复必须提供 changeTicket");
    const validation = this.validate(backupPath, targetRoot);
    if (validation.status !== "VALID") return validation;
    const source = resolveSafePath(backupPath);
    const target = resolveSafePath(targetRoot);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const copiedFiles: string[] = [];
    const manifest = validationManifest(source);
    for (const file of Object.keys(manifest.file_checksums)) {
      const sourcePath = join(source, file);
      const targetFile = targetFilePath(target, file);
      mkdirSync(dirname(targetFile), { recursive: true, mode: 0o700 });
      writeFileSync(targetFile, readFileSync(sourcePath), { mode: 0o600 });
      copiedFiles.push(file);
    }
    for (const directory of ["artifacts", "traces", "workspaces"]) {
      const path = join(target, directory);
      if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    writeFileSync(
      join(target, "manifest.json"),
      `${JSON.stringify({
        appVersion: this.appVersion,
        schemaRevision: SUPPORTED_SCHEMA_REVISION,
        directories: ["artifacts", "traces", "workspaces", "backups"],
        generatedAt: new Date().toISOString(),
        restoredFrom: manifest.backup_id,
        changeTicket,
      }, null, 2)}\n`,
      { mode: 0o600, encoding: "utf8" },
    );
    const report: RestoreReport = {
      ...validation,
      status: "APPLIED",
      copiedFiles,
      manualActions: [
        "在目标环境重新绑定 secretRef 对应的 OS Keychain 凭据并完成连接测试",
        "恢复后保持只读检查窗口，确认人工审批、暂停和阻塞门禁未被越过",
      ],
    };
    writeFileSync(join(target, "restore-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      encoding: "utf8",
    });
    return report;
  }

  private verifyBackup(backupPath: string): BackupVerification {
    const service = new BackupService(this.database, this.appVersion, this.database.persistentRoot);
    return service.verify(backupPath);
  }
}

/** 读取已校验备份的 manifest，恢复阶段不接受未解析的 JSON。 */
function validationManifest(backupPath: string) {
  return parseManifest(
    JSON.parse(readFileSync(join(resolveSafePath(backupPath), "manifest.json"), "utf8")),
  );
}

/** 将 manifest 文件映射到空目标根，并阻断数据库外的路径。 */
function targetFilePath(targetRoot: string, relativePath: string): string {
  if (relativePath === "database/company.db") return join(targetRoot, "company.db");
  const allowedDirectory =
    relativePath.startsWith("artifacts/") ||
    relativePath.startsWith("traces/") ||
    relativePath.startsWith("workspaces/");
  if (!allowedDirectory) {
    throw new Error(`不允许恢复的文件路径：${relativePath}`);
  }
  const destination = resolve(targetRoot, relativePath);
  if (!destination.startsWith(`${resolve(targetRoot)}${sep}`)) {
    throw new Error("恢复路径越界");
  }
  validateNoFollowPath(destination);
  return destination;
}

/** 校验恢复数据库的 Schema、外键、事件序列、产物和 TraceLink 关联。 */
function validateBackupDatabase(backupPath: string): string[] {
  const failures: string[] = [];
  const databasePath = join(resolveSafePath(backupPath), "database", "company.db");
  if (!existsSync(databasePath)) return ["备份中缺少 database/company.db"];
  let connection: BetterSqlite3.Database | null = null;
  try {
    connection = new BetterSqlite3(databasePath, { readonly: true });
    connection.pragma("foreign_keys = ON");
    const revision = connection
      .prepare("SELECT version_num FROM drizzle_migrations LIMIT 1")
      .get() as { version_num: string } | undefined;
    if (revision?.version_num !== SUPPORTED_SCHEMA_REVISION) failures.push("备份数据库 Schema revision 不兼容");
    const foreignKeys = connection.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    if (foreignKeys.length > 0) failures.push(`存在 ${foreignKeys.length} 条外键完整性错误`);
    const events = connection
      .prepare("SELECT global_sequence FROM domain_events ORDER BY global_sequence ASC")
      .all() as Array<{ global_sequence: number }>;
    for (let index = 1; index < events.length; index += 1) {
      if (events[index].global_sequence !== events[index - 1].global_sequence + 1) {
        failures.push("事件全局序列存在断裂");
        break;
      }
    }
    const artifacts = connection
      .prepare("SELECT relative_path FROM artifact_versions")
      .all() as Array<{ relative_path: string }>;
    for (const artifact of artifacts) {
      if (!artifact.relative_path || artifact.relative_path.includes("..")) {
        failures.push("Artifact relative_path 不安全");
        break;
      }
      if (
        !existsSync(
          join(resolveSafePath(backupPath), "artifacts", artifact.relative_path),
        )
      ) {
        failures.push(`Artifact 文件缺失：${artifact.relative_path}`);
        break;
      }
    }
    const links = connection
      .prepare(
        "SELECT source_type,source_id,target_type,target_id FROM trace_links",
      )
      .all() as Array<{
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
    }>;
    for (const link of links) {
      if (
        !traceEndpointExists(connection, link.source_type, link.source_id) ||
        !traceEndpointExists(connection, link.target_type, link.target_id)
      ) {
        failures.push(
          `TraceLink 两端不存在：${link.source_type}:${link.source_id} -> ${link.target_type}:${link.target_id}`,
        );
        break;
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "无法读取备份数据库");
  } finally {
    connection?.close();
  }
  return failures;
}

/** 检查 TraceLink 两端是否仍属于恢复数据库中的结构化对象。 */
function traceEndpointExists(
  connection: BetterSqlite3.Database,
  type: string,
  id: string,
): boolean {
  const tables: Record<string, string> = {
    approval: "approvals",
    artifact: "artifacts",
    artifact_version: "artifact_versions",
    defect: "defects",
    domain_event: "domain_events",
    execution_attempt: "execution_attempts",
    fix_request: "defect_fix_requests",
    model_call: "model_calls",
    npi_analysis: "npi_analyses",
    notification: "notifications",
    pm_peer_review: "pm_peer_reviews",
    prd_version: "prd_versions",
    project: "projects",
    product_success_metric: "product_success_metrics",
    quality_review: "quality_reviews",
    research_conclusion: "research_conclusions",
    research_conflict: "research_conflicts",
    research_grant: "research_grants",
    research_report: "research_reports",
    research_run: "research_runs",
    research_security_event: "research_security_events",
    research_source: "research_sources",
    research_source_validation: "research_source_validations",
    regression_request: "regression_requests",
    regression_result: "regression_results",
    review: "reviews",
    task: "tasks",
    test_case: "test_cases",
    test_run: "test_runs",
    tool_call: "tool_calls",
  };
  const table = tables[type];
  if (!table) {
    // requirement、acceptance_criterion、evidence 当前是 TraceLink 合同中的虚拟业务节点，
    // 其具体事实由上游需求/质量模块维护，SQLite trigger 不对它们执行表级存在性检查。
    return ["acceptance_criterion", "evidence", "requirement"].includes(type);
  }
  return Boolean(connection.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id));
}
