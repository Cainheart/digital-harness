import type BetterSqlite3 from "better-sqlite3";
import { migrateIntegritySchema } from "../schema.js";

/** Drizzle migration journal 的 Task 2 完整性和 TraceLink 修复 revision。 */
export const revision = "0003_task2_integrity_trace_fix" as const;
/** 增加 Artifact 完整性状态并重建完整 TraceLink 项目隔离约束。 */
export function up(database: BetterSqlite3.Database): void {
  migrateIntegritySchema(database);
}
