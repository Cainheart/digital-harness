import { describe, expect, it } from "vitest";
import { newObjectId, utcNow } from "../../src/domain/common.js";
import { DomainEventDraft } from "../../src/domain/events.js";
import { Database } from "../../src/infra/database.js";
import { EvidenceRepository } from "../../src/infra/repositories/evidence.js";
import { ExecutionRepository } from "../../src/infra/repositories/execution.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import { SqliteEventStore } from "../../src/infra/repositories/events.js";
import { ProjectDeletionRepository } from "../../src/infra/repositories/deletion.js";
import {
  createTestApp,
  makeProject,
  makeTask,
  useTestRoot,
} from "../helpers.js";

describe("Task 2 complete entity round trips", () => {
  it("persists and reloads approval, review, test, defect, execution and notification facts", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const project = makeProject();
    const task = makeTask(project.id);
    const artifact = {
      id: newObjectId("artifact"),
      projectId: project.id,
      taskId: task.id,
      name: "report",
      artifactType: "report",
      ownerRole: "developer",
      status: "created",
      createdAt: utcNow(),
      createdBy: "developer",
      contentRef: null,
      upstreamLinks: [],
      downstreamLinks: [],
      version: 1,
    };
    const projects = new ProjectTaskRepository();
    const evidence = new EvidenceRepository();
    const execution = new ExecutionRepository();
    app.runtime.database.transaction((connection) => {
      projects.createProject(connection, project);
      projects.createTask(connection, task);
      evidence.createArtifact(connection, artifact);
    });
    const reference = await app.runtime.artifactStore.put(
      Buffer.from("entity evidence"),
      "text/plain",
      { projectId: project.id, artifactId: artifact.id },
    );
    const version = {
      id: newObjectId("artifact_version"),
      artifactId: artifact.id,
      projectId: project.id,
      taskId: task.id,
      version: 1,
      parentVersionId: null,
      changeReason: "initial",
      contentRef: {
        artifactId: artifact.id,
        sha256: reference.sha256,
        mediaType: reference.mediaType,
        size: reference.sizeBytes,
        createdAt: reference.createdAt,
        relativePath: reference.relativePath,
        storeRef: reference.storeRef,
      },
      storeRef: reference.storeRef,
      createdAt: utcNow(),
      createdBy: "developer",
      integrityStatus: "unknown" as const,
    };
    const eventDraft: DomainEventDraft = {
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
      traceId: "tr_entities",
      occurredAt: utcNow(),
      attemptId: null,
      rejectionReason: null,
      redactionReason: null,
      eventCategory: "ordinary",
    };
    let eventId = "";
    app.runtime.database.transaction((connection) => {
      evidence.createArtifactVersion(connection, version);
      eventId =
        new SqliteEventStore().append(connection, "project", project.id, 0, [
          eventDraft,
        ]).events[0]?.eventId ?? "";
    });
    const approval = {
      id: newObjectId("approval"),
      projectId: project.id,
      taskId: task.id,
      approvalType: "release",
      subjectType: "artifact_version",
      subjectId: version.id,
      artifactVersionId: version.id,
      evidenceVersionId: version.id,
      decision: "approve",
      direction: "forward",
      bossId: "boss-local",
      status: "approved",
      responseTaskId: task.id,
      createdAt: utcNow(),
      decidedAt: utcNow(),
      version: 1,
    };
    const review = {
      id: newObjectId("review"),
      projectId: project.id,
      taskId: task.id,
      artifactVersionId: version.id,
      reviewerRole: "reviewer",
      reviewerId: "reviewer-1",
      decision: "approved",
      comments: "looks good",
      evidenceVersionId: version.id,
      reworkTaskId: null,
      createdAt: utcNow(),
      decidedAt: utcNow(),
      version: 1,
    };
    const testCase = {
      id: newObjectId("test_case"),
      projectId: project.id,
      taskId: task.id,
      acceptanceCriteria: ["works"],
      preconditions: "workspace ready",
      steps: ["run command"],
      expectedResult: "success",
      testType: "integration",
      ownerRole: "qa",
      createdAt: utcNow(),
      version: 1,
    };
    app.runtime.database.transaction((connection) => {
      evidence.createApproval(connection, approval);
      evidence.createReview(connection, review);
      evidence.createTestCase(connection, testCase);
    });
    const testRun = {
      id: newObjectId("test_run"),
      projectId: project.id,
      taskId: task.id,
      testCaseId: testCase.id,
      baselineVersionId: version.id,
      commandOrSteps: "npm test",
      environment: { node: "22" },
      startedAt: utcNow(),
      endedAt: utcNow(),
      actualResult: "success",
      exitCode: 0,
      status: "passed",
      evidenceVersionId: version.id,
      traceId: "tr_test_run",
    };
    app.runtime.database.transaction((connection) =>
      evidence.createTestRun(connection, testRun),
    );
    const defect = {
      id: newObjectId("defect"),
      projectId: project.id,
      taskId: task.id,
      sourceTestRunId: testRun.id,
      reproduction: "none",
      severity: "low",
      actualResult: "n/a",
      expectedResult: "success",
      evidenceVersionId: version.id,
      npiOwnerRole: "developer",
      status: "resolved",
      fixedVersionId: version.id,
      regressionTestRunId: testRun.id,
      createdAt: utcNow(),
      resolvedAt: utcNow(),
      version: 1,
    };
    app.runtime.database.transaction((connection) =>
      evidence.createDefect(connection, defect),
    );
    const attempt = {
      id: newObjectId("execution_attempt"),
      projectId: project.id,
      taskId: task.id,
      role: "developer",
      modelConfigVersion: "model-v1",
      workspaceRef: "workspace://local",
      workerLeaseId: null,
      status: "completed",
      startedAt: utcNow(),
      endedAt: utcNow(),
      retryOfAttemptId: null,
      retryCount: 0,
      traceId: "tr_attempt",
      version: 1,
    };
    const modelCall = {
      id: newObjectId("model_call"),
      projectId: project.id,
      taskId: task.id,
      executionAttemptId: attempt.id,
      role: "developer",
      provider: "test",
      model: "test-model",
      startedAt: utcNow(),
      endedAt: utcNow(),
      durationMs: 10,
      summary: "safe summary",
      errorCode: null,
      inputTokens: 1,
      outputTokens: 2,
      costMicros: 3,
      traceId: "tr_model",
      version: 1,
    };
    const toolCall = {
      id: newObjectId("tool_call"),
      projectId: project.id,
      taskId: task.id,
      executionAttemptId: attempt.id,
      role: "developer",
      toolName: "test",
      startedAt: utcNow(),
      endedAt: utcNow(),
      durationMs: 5,
      summary: "safe summary",
      errorCode: null,
      traceId: "tr_tool",
      version: 1,
    };
    app.runtime.database.transaction((connection) => {
      execution.createAttempt(connection, attempt);
      execution.createModelCall(connection, modelCall);
      execution.createToolCall(connection, toolCall);
    });
    const notification = {
      id: newObjectId("notification"),
      projectId: project.id,
      eventId,
      notificationType: "approval",
      severity: "info",
      subjectType: "project",
      subjectId: project.id,
      unread: true,
      pending: true,
      handledBy: null,
      action: null,
      createdAt: utcNow(),
      readAt: null,
      handledAt: null,
      version: 1,
    };
    app.runtime.database.transaction((connection) =>
      execution.createNotification(connection, notification),
    );

    expect(
      evidence.getApproval(app.runtime.database.connection, approval.id)
        .decision,
    ).toBe("approve");
    expect(
      evidence.getReview(app.runtime.database.connection, review.id).reviewerId,
    ).toBe("reviewer-1");
    expect(
      evidence.getTestCase(app.runtime.database.connection, testCase.id)
        .acceptanceCriteria,
    ).toEqual(["works"]);
    expect(
      evidence.getTestRun(app.runtime.database.connection, testRun.id)
        .environment,
    ).toEqual({ node: "22" });
    expect(
      evidence.getDefect(app.runtime.database.connection, defect.id)
        .sourceTestRunId,
    ).toBe(testRun.id);
    expect(
      execution.getAttempt(app.runtime.database.connection, attempt.id).status,
    ).toBe("completed");
    expect(
      execution.getModelCall(app.runtime.database.connection, modelCall.id)
        .costMicros,
    ).toBe(3);
    expect(
      execution.getToolCall(app.runtime.database.connection, toolCall.id)
        .toolName,
    ).toBe("test");
    expect(
      execution.getNotification(
        app.runtime.database.connection,
        notification.id,
      ).eventId,
    ).toBe(eventId);
    await app.close();
  });

  it("deletes historical project data, files and keeps the minimum deletion audit", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const project = makeProject();
    const projects = new ProjectTaskRepository();
    const evidence = new EvidenceRepository();
    const artifact = {
      id: newObjectId("artifact"),
      projectId: project.id,
      taskId: null,
      name: "archive",
      artifactType: "report",
      ownerRole: "developer",
      status: "created",
      createdAt: utcNow(),
      createdBy: "developer",
      contentRef: null,
      upstreamLinks: [],
      downstreamLinks: [],
      version: 1,
    };
    app.runtime.database.transaction((connection) => {
      projects.createProject(connection, project);
      evidence.createArtifact(connection, artifact);
    });
    await app.runtime.artifactStore.put(
      Buffer.from("historical evidence"),
      "text/plain",
      { projectId: project.id, artifactId: artifact.id },
    );
    const deletion = new ProjectDeletionRepository(
      app.runtime.database,
      app.runtime.artifactStore,
    );
    const report = deletion.deleteHistoricalProject(project.id, "boss-local");
    expect(report.failedPaths).toEqual([]);
    expect(deletion.projectExists(project.id)).toBe(false);
    expect(app.runtime.artifactStore.projectFileCount(project.id)).toBe(0);
    expect(deletion.deletionAudit(project.id)).toMatchObject({
      projectId: project.id,
      actorId: "boss-local",
    });
    await app.close();
  });
});
