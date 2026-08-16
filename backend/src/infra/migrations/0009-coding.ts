import type BetterSqlite3 from "better-sqlite3";
import { migrateCodingSchema } from "../schema.js";

/** Task 7 NativeCodingHarness 会话、执行证据和 Review 交接 Schema revision。 */
export const revision = "0009_task7_coding" as const;

/** 创建或升级 Task 7 的编码执行持久化合同。 */
export function up(database: BetterSqlite3.Database): void {
  migrateCodingSchema(database);
}
