import { describe, expect, it } from "vitest";
import { newObjectId, utcNow } from "../../src/domain/common.js";
import { parseCommand } from "../../src/domain/commands.js";
import { DomainEventDraft } from "../../src/domain/events.js";
import { Database } from "../../src/infra/database.js";
import { SqliteEventStore } from "../../src/infra/repositories/events.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import { Task2CommandService } from "../../src/application/task2.js";
import { createTestApp, makeProject, useTestRoot } from "../helpers.js";

function draft(aggregateId: string, eventType = "ProjectCreated"): DomainEventDraft { return { eventType, aggregateType: "project", aggregateId, payload: { projectId: aggregateId }, inputSummary: "", outputSummary: "committed", result: "success", failure: null, retryCount: 0, durationMs: 0, actor: { type: "boss", id: "boss-local" }, traceId: "tr_test", occurredAt: utcNow(), attemptId: null, rejectionReason: null, redactionReason: null, eventCategory: "ordinary" }; }

describe("Task 2 events, outbox and command idempotency", () => {
  it("appends immutable events and an outbox message in one transaction", () => {
    const rootPath = useTestRoot(); const database = new Database(`${rootPath}/company.db`, { persistentRoot: rootPath }); database.initialize(); const project = makeProject(); const repository = new ProjectTaskRepository(); database.transaction((connection) => repository.createProject(connection, project)); const events = new SqliteEventStore(); const result = database.transaction((connection) => events.append(connection, "project", project.id, 0, [draft(project.id)])); expect(result.aggregateVersion).toBe(1); expect((database.connection.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get() as { count: number }).count).toBe(1); expect(() => database.connection.prepare("UPDATE domain_events SET result='changed' WHERE event_id=?").run(result.events[0].eventId)).toThrow(); database.close();
  });

  it("returns the exact prior response for the same idempotency key", async () => {
    const rootPath = useTestRoot(); const app = await createTestApp(rootPath); const project = makeProject(); const repository = new ProjectTaskRepository(); const service = new Task2CommandService(app.runtime.database); const command = parseCommand({ commandId: "cmd_1", idempotencyKey: "start_1", aggregateId: project.id, expectedVersion: 0, actor: { type: "boss", id: "boss-local" }, payload: { action: "start" } }); const options = { aggregateType: "project" as const, stateWriter: (connection: Parameters<typeof repository.createProject>[0]) => { repository.createProject(connection, project); return project; }, eventDrafts: [draft(project.id, "ProjectStarted")] }; const first = service.execute(command, options); const second = service.execute(command, options); expect(second).toEqual(first); expect((app.runtime.database.connection.prepare("SELECT COUNT(*) AS count FROM domain_events").get() as { count: number }).count).toBe(1); await app.close();
  });

  it("persists call-event context fields instead of losing them on reload", () => {
    const rootPath = useTestRoot();
    const database = new Database(`${rootPath}/company.db`, { persistentRoot: rootPath });
    database.initialize();
    const project = makeProject();
    const repository = new ProjectTaskRepository();
    database.transaction((connection) => repository.createProject(connection, project));
    const event = { ...draft(project.id, "ModelCallRejected"), aggregateType: "project", attemptId: "attempt_1", rejectionReason: "policy denied", redactionReason: "secret removed", eventCategory: "security" as const };
    const store = new SqliteEventStore();
    const appended = database.transaction((connection) => store.append(connection, "project", project.id, 0, [event]));
    const loaded = store.listForAggregate(database.connection, "project", project.id)[0];
    expect(loaded?.eventId).toBe(appended.events[0]?.eventId);
    expect(loaded?.attemptId).toBe("attempt_1");
    expect(loaded?.rejectionReason).toBe("policy denied");
    expect(loaded?.redactionReason).toBe("secret removed");
    expect(loaded?.eventCategory).toBe("security");
    database.close();
  });

  it("rolls back state when event append fails and rejects stale versions", async () => {
    const rootPath = useTestRoot();
    const app = await createTestApp(rootPath);
    const project = makeProject();
    const repository = new ProjectTaskRepository();
    const service = new Task2CommandService(app.runtime.database);
    const invalidCommand = parseCommand({ commandId: "cmd_rollback", idempotencyKey: "rollback_1", aggregateId: project.id, expectedVersion: 0, actor: { type: "boss", id: "boss-local" }, payload: { action: "create" } });
    expect(() => service.execute(invalidCommand, { aggregateType: "project", stateWriter: (connection) => { repository.createProject(connection, project); return project; }, eventDrafts: [] })).toThrow();
    expect(repository.findProject(app.runtime.database.connection, project.id)).toBeNull();

    app.runtime.database.transaction((connection) => repository.createProject(connection, project));
    const first = app.runtime.database.transaction((connection) => new SqliteEventStore().append(connection, "project", project.id, 0, [draft(project.id)]));
    const staleCommand = parseCommand({ commandId: "cmd_stale", idempotencyKey: "stale_1", aggregateId: project.id, expectedVersion: 0, actor: { type: "boss", id: "boss-local" }, payload: { action: "update" } });
    expect(first.aggregateVersion).toBe(1);
    expect(() => service.execute(staleCommand, { aggregateType: "project", stateWriter: () => project, eventDrafts: [draft(project.id, "ProjectUpdated")] })).toThrow(/VERSION_CONFLICT|版本冲突/);
    await app.close();
  });
});
