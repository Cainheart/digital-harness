import type BetterSqlite3 from "better-sqlite3";
import { migrateModelGatewaySchema } from "../schema.js";

/** Task 5 模型配置、凭据引用、调用观测和配置审计 Schema revision。 */
export const revision = "0007_task5_model_gateway" as const;

/** 为已有 Task 4 数据库补齐模型网关持久化合同。 */
export function up(database: BetterSqlite3.Database): void {
  migrateModelGatewaySchema(database);
}
