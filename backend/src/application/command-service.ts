import BetterSqlite3 from "better-sqlite3";
import {
  canonicalRequestHash,
  CommandEnvelope,
  CommandResult,
} from "../domain/commands.js";
import { newObjectId, utcNow } from "../domain/common.js";
import { DomainEventDraft } from "../domain/events.js";
import {
  InvalidArgumentError,
  VersionConflictError,
} from "../domain/errors.js";
import { OutboxRepository } from "../infra/outbox.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import {
  SqliteIdempotencyRepository,
  IdempotencyRecord,
} from "../infra/repositories/idempotency.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import { ensureProjectWritable } from "../infra/repositories/common.js";
import { Database } from "../infra/database.js";

/** Task 2 命令级事务协调器，不包含 API 或工作流状态机。 */
export class CommandService {
  private readonly projectTaskRepository: ProjectTaskRepository;
  private readonly eventStore: SqliteEventStore;
  private readonly idempotencyRepository: SqliteIdempotencyRepository;
  /** 注入低层仓储；服务本身不创建 API 或推进业务工作流。 */
  constructor(
    private readonly database: Database,
    dependencies: {
      projectTaskRepository?: ProjectTaskRepository;
      eventStore?: SqliteEventStore;
      idempotencyRepository?: SqliteIdempotencyRepository;
    } = {},
  ) {
    this.projectTaskRepository =
      dependencies.projectTaskRepository ?? new ProjectTaskRepository();
    this.eventStore =
      dependencies.eventStore ?? new SqliteEventStore(new OutboxRepository());
    this.idempotencyRepository =
      dependencies.idempotencyRepository ?? new SqliteIdempotencyRepository();
  }
  /** 在一个 SQLite 事务内固定幂等、版本、状态、事件、元数据和响应提交顺序。 */
  execute<T = unknown>(
    command: CommandEnvelope,
    options: {
      aggregateType: "project" | "task";
      stateWriter: (connection: BetterSqlite3.Database) => T;
      eventDrafts?:
        | DomainEventDraft[]
        | ((
            connection: BetterSqlite3.Database,
            state: T,
          ) => DomainEventDraft[]);
      events?:
        | DomainEventDraft[]
        | ((
            connection: BetterSqlite3.Database,
            state: T,
          ) => DomainEventDraft[]);
      metadataWriter?: (
        connection: BetterSqlite3.Database,
        state: T,
        appended: ReturnType<SqliteEventStore["append"]>,
      ) => void;
      traceArtifactWriter?: (
        connection: BetterSqlite3.Database,
        state: T,
        appended: ReturnType<SqliteEventStore["append"]>,
      ) => void;
      resultFactory?: (
        state: T,
        appended: ReturnType<SqliteEventStore["append"]>,
      ) => CommandResult;
    },
  ): CommandResult {
    if (options.eventDrafts && options.events)
      throw new InvalidArgumentError("provide eventDrafts or events, not both");
    const draftsSource = options.eventDrafts ?? options.events;
    if (!draftsSource)
      throw new InvalidArgumentError("eventDrafts are required");
    if (options.metadataWriter && options.traceArtifactWriter)
      throw new InvalidArgumentError(
        "provide metadataWriter or traceArtifactWriter, not both",
      );
    const requestHash = canonicalRequestHash(command);
    return this.database.transaction((connection) => {
      const existing = this.idempotencyRepository.get(
        connection,
        command.idempotencyKey,
      );
      if (existing)
        return this.idempotencyRepository.assertReusable(
          existing,
          requestHash,
          `trace_${command.commandId}`,
        );
      this.checkExpectedVersion(connection, command, options.aggregateType);
      const state = options.stateWriter(connection);
      const drafts =
        typeof draftsSource === "function"
          ? draftsSource(connection, state)
          : draftsSource;
      const appended = this.eventStore.append(
        connection,
        options.aggregateType,
        command.aggregateId,
        command.expectedVersion,
        drafts,
      );
      const callback = options.metadataWriter ?? options.traceArtifactWriter;
      if (callback) callback(connection, state, appended);
      const result = options.resultFactory?.(state, appended) ?? {
        aggregateId: command.aggregateId,
        version: appended.aggregateVersion,
        eventId: appended.events.at(-1)?.eventId ?? "",
        allowedActions: [],
        traceId: `trace_${command.commandId}`,
      };
      const projectId = this.projectIdAfterWrite(
        connection,
        options.aggregateType,
        command.aggregateId,
      );
      this.idempotencyRepository.save(connection, {
        id: newObjectId("idempotency"),
        projectId,
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        aggregateType: options.aggregateType,
        aggregateId: command.aggregateId,
        requestHash,
        commandResult: result,
        eventId: result.eventId,
        createdAt: utcNow(),
      });
      return result;
    });
  }
  private checkExpectedVersion(
    connection: BetterSqlite3.Database,
    command: CommandEnvelope,
    aggregateType: "project" | "task",
  ): void {
    if (aggregateType === "project") {
      const current = this.projectTaskRepository.findProject(
        connection,
        command.aggregateId,
      );
      if (!current) {
        if (command.expectedVersion !== 0)
          throw new VersionConflictError(undefined, {
            data: {
              aggregateType,
              aggregateId: command.aggregateId,
              expectedVersion: command.expectedVersion,
              actualVersion: 0,
            },
          });
        return;
      }
      this.checkCurrent(connection, current.id, current.version, command);
    } else {
      const current = this.projectTaskRepository.findTask(
        connection,
        command.aggregateId,
      );
      if (!current) {
        if (command.expectedVersion !== 0)
          throw new VersionConflictError(undefined, {
            data: {
              aggregateType,
              aggregateId: command.aggregateId,
              expectedVersion: command.expectedVersion,
              actualVersion: 0,
            },
          });
        return;
      }
      this.checkCurrent(
        connection,
        current.projectId,
        current.version,
        command,
      );
    }
  }
  private checkCurrent(
    connection: BetterSqlite3.Database,
    projectId: string,
    version: number,
    command: CommandEnvelope,
  ): void {
    ensureProjectWritable(connection, projectId);
    if (version !== command.expectedVersion)
      throw new VersionConflictError(undefined, {
        data: {
          aggregateId: command.aggregateId,
          expectedVersion: command.expectedVersion,
          actualVersion: version,
        },
      });
  }
  private projectIdAfterWrite(
    connection: BetterSqlite3.Database,
    aggregateType: string,
    aggregateId: string,
  ): string | null {
    if (aggregateType === "project") return aggregateId;
    const row = connection
      .prepare("SELECT project_id FROM tasks WHERE id=?")
      .get(aggregateId) as { project_id: string } | undefined;
    return row?.project_id ?? null;
  }
}

export { IdempotencyRecord };
