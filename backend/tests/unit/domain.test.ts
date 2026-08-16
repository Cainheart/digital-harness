import { describe, expect, it } from "vitest";
import { canonicalRequestHash, parseCommand } from "../../src/domain/commands.js";
import { ProjectStatus, TaskStatus, newObjectId } from "../../src/domain/common.js";
import { parseArtifactRef, parseProject, parseTask, parseTraceLink } from "../../src/domain/entities.js";
import { InvalidArgumentError, Task2DomainError, VersionConflictError } from "../../src/domain/errors.js";
import { parseEventDraft } from "../../src/domain/events.js";

describe("Task 2 TypeScript domain contracts", () => {
  it("keeps frozen project/task statuses and safe ids", () => {
    expect(ProjectStatus.PREPARING).toBe("准备中");
    expect(TaskStatus.WAITING_REVIEW).toBe("等待 Review");
    expect(newObjectId("project")).toMatch(/^project_\d{13}/);
    expect(() => newObjectId("../project")).toThrow();
  });

  it("rejects missing fields, unsafe paths and unsupported trace types", () => {
    expect(() => parseProject({})).toThrow(/id is required/);
    expect(() => parseArtifactRef({ artifactId: "artifact_1", sha256: "a".repeat(64), mediaType: "text/plain", size: 1, createdAt: "2026-08-16T00:00:00Z", relativePath: "../escape" })).toThrow();
    expect(() => parseTraceLink({ id: "link_1", projectId: "project_1", sourceType: "unsupported", sourceId: "x", targetType: "task", targetId: "task_1", relation: "covers", traceId: "tr_1", createdAt: "2026-08-16T00:00:00Z" })).toThrow(/unsupported/);
  });

  it("validates command envelopes and canonicalizes request hashes", () => {
    const first = parseCommand({ commandId: "cmd_1", idempotencyKey: "key_1", aggregateId: "project_1", expectedVersion: 0, actor: { type: "boss", id: "boss-local" }, payload: { name: "demo", constraints: {} } });
    const second = parseCommand({ payload: { constraints: {}, name: "demo" }, actor: { id: "boss-local", type: "boss" }, expectedVersion: 0, aggregateId: "project_1", idempotencyKey: "key_1", commandId: "cmd_1" });
    expect(canonicalRequestHash(first)).toBe(canonicalRequestHash(second));
    expect(() => parseCommand({ ...first, payload: { commandId: "spoof" } })).toThrow(/reserved/);
  });

  it("requires attempt and redaction context for call/security events", () => {
    expect(() => parseEventDraft({ eventType: "ModelCallFailed", aggregateType: "attempt", aggregateId: "attempt_1", payload: {}, actor: { type: "worker", id: "worker_1" } })).toThrow(/attemptId/);
    expect(parseEventDraft({ eventType: "ModelCallFailed", aggregateType: "attempt", aggregateId: "attempt_1", payload: {}, actor: { type: "worker", id: "worker_1" }, attemptId: "attempt_1", rejectionReason: "provider unavailable", redactionReason: "summary only" }).eventCategory).toBe("ordinary");
  });

  it("serializes stable domain errors without secrets", () => {
    const error = new InvalidArgumentError("apiKey=sk-test-secret", { data: { token: "secret-value" } });
    expect(error).toBeInstanceOf(Task2DomainError);
    expect(error.message).not.toContain("sk-test-secret");
    expect(new VersionConflictError().toPayload().code).toBe("VERSION_CONFLICT");
  });

  it("accepts complete project and task values", () => {
    const project = parseProject({ id: "project_1", name: "Demo", businessGoal: "Goal", targetUsers: "Users", priority: "P0", deadline: null, constraints: {}, stage: "立项", status: "准备中", createdAt: "2026-08-16T00:00:00Z", endedAt: null, version: 1, readOnly: false });
    const task = parseTask({ id: "task_1", projectId: project.id, title: "Task", ownerRole: "developer", specialistTag: "backend", assignmentReason: "reason", priority: "P1", dependencies: ["foundation"], expectedDeliverables: ["source"], status: "待处理", createdAt: "2026-08-16T00:00:00Z", startedAt: null, endedAt: null, version: 1 });
    expect(task.projectId).toBe(project.id);
  });
});
