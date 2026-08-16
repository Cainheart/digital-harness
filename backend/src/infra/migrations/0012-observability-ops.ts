import type BetterSqlite3 from "better-sqlite3";
import { migrateTask10Schema } from "../schema.js";

/** Task 10 评分卡历史快照和发布门禁的 Schema revision。 */
export const revision = "0012_task10_observability_ops" as const;

/** 创建可回看的评分卡快照，不修改上游领域事实。 */
export function up(database: BetterSqlite3.Database): void {
  migrateTask10Schema(database);
}
