import { Database } from "../infra/database.js";
import { redactJson } from "./redaction.js";

/** 将运行和安全事件脱敏后写入持久化运行事件表。 */
export class AuditWriter {
  /** 绑定唯一持久化事件入口，拒绝绕过脱敏直接写安全事件。 */
  constructor(private readonly database: Database) {}
  /** 序列化并脱敏事件元数据，再追加到数据库。 */
  async write(input: {
    traceId: string;
    eventType: string;
    result: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const payload = redactJson({
      result: input.result,
      metadata: input.metadata ?? {},
    });
    this.database.appendEvent(input.eventType, input.traceId, payload);
  }
}
