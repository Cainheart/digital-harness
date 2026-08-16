import type BetterSqlite3 from "better-sqlite3";
import { migrateWorkflowHardeningSchema } from "../schema.js";

/** Task 4 租约期限与风险响应链路加固的 Schema revision。 */
export const revision = "0006_task4_workflow_hardening" as const;

/** 为已有工作流表补齐 Grant 原始期限和风险响应任务字段。 */
export function up(database: BetterSqlite3.Database): void {
  migrateWorkflowHardeningSchema(database);
}
