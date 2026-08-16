import type BetterSqlite3 from "better-sqlite3";
import { migrateArchiveConsoleSchema } from "../schema.js";

/** Task 9 历史查询、只读复盘和删除二次确认 Schema revision。 */
export const revision = "0011_task9_archive_console" as const;

/** 创建可恢复的历史删除确认记录，不修改既有项目事实。 */
export function up(database: BetterSqlite3.Database): void {
  migrateArchiveConsoleSchema(database);
}
