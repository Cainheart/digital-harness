import type BetterSqlite3 from "better-sqlite3";
import { migrateQualityFlowSchema } from "../schema.js";

/** Task 8 需求拆解、Review、测试、缺陷、NPI 和回归 Schema revision。 */
export const revision = "0010_task8_quality_flow" as const;

/** 执行 Task 8 质量闭环迁移并保留既有 Task 2/7 数据。 */
export function up(database: BetterSqlite3.Database): void {
  migrateQualityFlowSchema(database);
}
