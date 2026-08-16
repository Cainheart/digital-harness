import { RuntimeBoundaryError } from "../../api/errors.js";
import { Database } from "../../infra/database.js";
import { CheckView } from "../models.js";

/** 检查数据库 Schema 兼容性和 SQLite WAL 持久化能力。 */
export class PersistenceReadinessChecker {
  readonly name = "persistence";
  constructor(private readonly database: Database) {}
  /** 执行数据库版本与 journal mode 检查，不修改业务数据。 */
  async check(): Promise<CheckView> { try { const schema = this.database.checkSchema(); const details = { journalMode: schema.writable ? this.database.journalMode() : "blocked-read-only", schemaRevision: schema.revision, persistentRoot: "configured" }; return schema.writable ? { status: "ready", message: "持久化根目录和数据库可用", schemaRevision: schema.revision ?? undefined, details } : { status: "blocked", message: schema.message, code: schema.code ?? undefined, impact: "业务数据无法安全持久化", dataPreserved: schema.dataPreserved, schemaRevision: schema.revision ?? undefined, nextAction: schema.nextAction ?? "检查 SQLite 数据库和持久化根目录", details }; } catch (error) { const message = error instanceof RuntimeBoundaryError ? error.message : "持久化数据库当前不可用"; return { status: "blocked", message, code: error instanceof RuntimeBoundaryError ? error.code : "PERSISTENCE_UNAVAILABLE", impact: "业务数据无法安全持久化", dataPreserved: true, nextAction: "检查 SQLite 数据库和持久化根目录", details: { persistentRoot: "configured" } }; } }
}
