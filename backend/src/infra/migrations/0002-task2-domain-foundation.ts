import type BetterSqlite3 from "better-sqlite3";
import { migrate0002 } from "../schema.js";

/** Drizzle migration journal 的 Task 2 领域基础 revision。 */
export const revision = "0002_task2_domain_foundation" as const;
/** 创建领域表、事件、Outbox、证据约束和 TraceLink 隔离 trigger。 */
export function up(database: BetterSqlite3.Database): void { migrate0002(database); }
