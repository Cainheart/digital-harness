import type BetterSqlite3 from "better-sqlite3";
import { migrate0004 } from "../schema.js";

/** Drizzle migration journal 的 Task 3 组织、消息和策略 revision。 */
export const revision = "0004_task3_organization_policy" as const;
/** 创建组织、岗位版本、结构化消息和策略审计表。 */
export function up(database: BetterSqlite3.Database): void { migrate0004(database); }
