import BetterSqlite3 from "better-sqlite3";
import { CommandResult } from "../../domain/commands.js";
import { IdempotencyKeyReusedError } from "../../domain/errors.js";
import { jsonText } from "./common.js";

/** 记录命令请求指纹和原始响应，保证重复提交不产生第二次副作用。 */
export type IdempotencyRecord = {
  id: string;
  projectId: string | null;
  idempotencyKey: string;
  commandId: string;
  aggregateType: string;
  aggregateId: string;
  requestHash: string;
  commandResult: CommandResult;
  eventId: string | null;
  createdAt: string;
};
/** SQLite 幂等记录仓储。 */
export class SqliteIdempotencyRepository {
  /** 读取幂等键对应的历史结果。 */
  get(
    connection: BetterSqlite3.Database,
    key: string,
  ): IdempotencyRecord | null {
    const row = connection
      .prepare("SELECT * FROM idempotency_records WHERE idempotency_key=?")
      .get(key) as IdempotencyRow | undefined;
    return row ? fromRow(row) : null;
  }
  /** 保存幂等结果。 */
  save(
    connection: BetterSqlite3.Database,
    record: IdempotencyRecord,
  ): IdempotencyRecord {
    connection
      .prepare(
        "INSERT INTO idempotency_records (id,project_id,idempotency_key,command_id,aggregate_type,aggregate_id,request_hash,response_json,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        record.id,
        record.projectId,
        record.idempotencyKey,
        record.commandId,
        record.aggregateType,
        record.aggregateId,
        record.requestHash,
        jsonText(record.commandResult),
        record.eventId,
        record.createdAt,
      );
    return record;
  }
  /** 验证请求指纹并返回原始命令结果。 */
  assertReusable(
    existing: IdempotencyRecord,
    requestHash: string,
    traceId: string,
  ): CommandResult {
    if (existing.requestHash !== requestHash)
      throw new IdempotencyKeyReusedError(undefined, {
        traceId,
        data: { idempotencyKey: existing.idempotencyKey },
      });
    return existing.commandResult;
  }
}
type IdempotencyRow = {
  id: string;
  project_id: string | null;
  idempotency_key: string;
  command_id: string;
  aggregate_type: string;
  aggregate_id: string;
  request_hash: string;
  response_json: string;
  event_id: string | null;
  created_at: string;
};
function fromRow(row: IdempotencyRow): IdempotencyRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    commandId: row.command_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    requestHash: row.request_hash,
    commandResult: JSON.parse(row.response_json) as CommandResult,
    eventId: row.event_id,
    createdAt: row.created_at,
  };
}
