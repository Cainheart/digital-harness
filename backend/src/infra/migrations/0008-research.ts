import type BetterSqlite3 from "better-sqlite3";
import { migrateResearchSchema } from "../schema.js";

/** Task 6 真实调研、来源治理和 PM 交付物 Schema revision。 */
export const revision = "0008_task6_research" as const;

/** 创建或升级 Task 6 的来源、结论、指标、PRD 和安全事件表。 */
export function up(database: BetterSqlite3.Database): void {
  migrateResearchSchema(database);
}
