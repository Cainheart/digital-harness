import { describe, expect, it } from "vitest";
import { newObjectId, utcNow } from "../../src/domain/common.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import { SqliteEventStore } from "../../src/infra/repositories/events.js";
import { createTestApp, makeProject, useTestRoot } from "../helpers.js";
import { DomainEventDraft } from "../../src/domain/events.js";

describe("Fastify readiness and committed event stream", () => {
  it("only streams committed domain events and supports Last-Event-ID", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const project = makeProject();
    const repository = new ProjectTaskRepository();
    app.runtime.database.transaction((connection) =>
      repository.createProject(connection, project),
    );
    const event: DomainEventDraft = {
      eventType: "ProjectCreated",
      aggregateType: "project",
      aggregateId: project.id,
      payload: { projectId: project.id },
      inputSummary: "",
      outputSummary: "created",
      result: "success",
      failure: null,
      retryCount: 0,
      durationMs: 0,
      actor: { type: "boss", id: "boss-local" },
      traceId: "tr_api",
      occurredAt: utcNow(),
      attemptId: null,
      rejectionReason: null,
      redactionReason: null,
      eventCategory: "ordinary",
    };
    const result = app.runtime.database.transaction((connection) =>
      new SqliteEventStore().append(connection, "project", project.id, 0, [
        event,
      ]),
    );
    const response = await app.inject({ method: "GET", url: "/api/v1/events" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain(result.events[0].eventId);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: { "last-event-id": result.events[0].eventId },
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain("no committed events");
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/events?limit=0",
    });
    expect(invalid.statusCode).toBe(400);
    const malformedAcknowledgement = await app.inject({
      method: "POST",
      url: "/api/v1/messages/message_1/acknowledge",
      payload: { handledBy: { object: true } },
    });
    expect(malformedAcknowledgement.statusCode).toBe(400);
    const malformedPolicyRequest = await app.inject({
      method: "POST",
      url: "/api/v1/policy/authorize-action",
      payload: { roleId: { object: true }, action: {}, grant: {} },
    });
    expect(malformedPolicyRequest.statusCode).toBe(400);
    await app.close();
  });
});
