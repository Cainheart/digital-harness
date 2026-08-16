import type BetterSqlite3 from "better-sqlite3";
import { migrateWorkflowSchema } from "../schema.js";

/** Task 4 工作流控制、暂停恢复、风险和调度租约 revision。 */
export const revision = "0005_task4_workflow" as const;

/** 创建并校验 Task 4 的持久化事实表。 */
export function up(database: BetterSqlite3.Database): void {
  migrateWorkflowSchema(database);
}
