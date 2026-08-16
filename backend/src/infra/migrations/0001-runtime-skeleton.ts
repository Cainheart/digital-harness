import type BetterSqlite3 from "better-sqlite3";
import { migrateRuntimeSchema } from "../schema.js";

/** Drizzle migration journal 的 Task 1 运行骨架 revision。 */
export const revision = "0001_runtime_skeleton" as const;
/** 创建运行状态、事件、租约和凭据引用表。 */
export function up(database: BetterSqlite3.Database): void {
  migrateRuntimeSchema(database);
}
