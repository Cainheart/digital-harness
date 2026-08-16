import { describe, expect, it } from "vitest";
import { newObjectId, utcNow } from "../../src/domain/common.js";
import { ExecutionRepository } from "../../src/infra/repositories/execution.js";
import { createTestApp, useTestRoot } from "../helpers.js";

/** 创建可供 Task 10 观测、评分和运维接口共同使用的已启动项目。 */
async function createStartedProject(app: Awaited<ReturnType<typeof createTestApp>>) {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      commandId: "task10-create-command",
      idempotencyKey: "task10-create-project",
      expectedVersion: 0,
      actor: { type: "boss", id: "boss-local" },
      name: "Task 10 验收项目",
      businessGoal: "验证真实状态、执行证据、评分卡和恢复链路",
      targetUsers: "项目负责人",
      priority: "P1",
      deadline: null,
      constraints: {},
    },
  });
  expect(created.statusCode).toBe(201);
  const project = created.json().project as { id: string; version: number };
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/start`,
    payload: {
      commandId: "task10-start-command",
      idempotencyKey: "task10-start-project",
      expectedVersion: project.version,
      actor: { type: "boss", id: "boss-local" },
      payload: {},
    },
  });
  expect(started.statusCode).toBe(200);
  const dashboard = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}/dashboard`,
  });
  expect(dashboard.statusCode).toBe(200);
  return {
    projectId: project.id,
    taskId: dashboard.json().tasks[0].id as string,
  };
}

/** 追加真实 Attempt、模型账本和工具账本，避免用前端假数据测试控制台。 */
function seedExecutionEvidence(
  app: Awaited<ReturnType<typeof createTestApp>>,
  projectId: string,
  taskId: string,
): string {
  const repository = new ExecutionRepository();
  const attemptId = newObjectId("attempt");
  const traceId = `trace-${attemptId}`;
  const startedAt = utcNow();
  const endedAt = new Date(Date.parse(startedAt) + 1_500).toISOString();
  app.runtime.database.transaction((connection) => {
    repository.createAttempt(connection, {
      id: attemptId,
      projectId,
      taskId,
      role: "developer",
      modelConfigVersion: "1",
      workspaceRef: null,
      workerLeaseId: null,
      status: "completed",
      startedAt,
      endedAt,
      retryOfAttemptId: null,
      retryCount: 1,
      traceId,
      version: 1,
      modelProvider: "test-provider",
      modelName: "test-model",
      modelSecretRef: "secretRef://test-only",
    });
    repository.createModelCall(connection, {
      id: newObjectId("model-call"),
      projectId,
      taskId,
      executionAttemptId: attemptId,
      role: "developer",
      provider: "test-provider",
      model: "test-model",
      startedAt,
      endedAt,
      durationMs: 1_500,
      summary: "脱敏模型调用摘要",
      errorCode: null,
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 12,
      traceId,
      version: 1,
      inputSummary: "脱敏输入摘要",
      outputSummary: "脱敏输出摘要",
      redactionStatus: "passed",
      finalStatus: "finished",
      totalTokens: 15,
    });
    repository.createToolCall(connection, {
      id: newObjectId("tool-call"),
      projectId,
      taskId,
      executionAttemptId: attemptId,
      role: "developer",
      toolName: "sandbox.command",
      startedAt,
      endedAt,
      durationMs: 1_000,
      summary: "命令摘要",
      errorCode: null,
      traceId,
      version: 1,
    });
  });
  return attemptId;
}

describe("Task 10 observability and operations", () => {
  it("projects office state and reconnectable committed events", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createStartedProject(app);

    const office = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/office`,
    });
    expect(office.statusCode).toBe(200);
    expect(office.json().rooms.map((room: { roomId: string }) => room.roomId)).toEqual([
      "boss",
      "product",
      "research",
      "development",
      "npi",
      "review",
      "testing",
      "project-management",
      "archive",
    ]);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/office/events?limit=2`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain("event: office_event");
    await app.close();
  });

  it("aggregates real execution evidence without exposing secret references", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId, taskId } = await createStartedProject(app);
    const attemptId = seedExecutionEvidence(app, projectId, taskId);

    const page = await app.inject({
      method: "GET",
      url: `/api/v1/executions/runs?projectId=${projectId}&page=1&pageSize=10`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().items[0]).toMatchObject({ executionId: attemptId, retryCount: 1 });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/executions/${attemptId}?projectId=${projectId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      executionId: attemptId,
      modelUsage: [{ totalTokens: 15, estimatedCostMicros: 12 }],
      toolCalls: [{ toolName: "sandbox.command" }],
    });
    expect(JSON.stringify(detail.json())).not.toContain("secretRef://test-only");
    await app.close();
  });

  it("keeps scorecard evidence insufficient until Boss recalculates a snapshot", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createStartedProject(app);

    const initial = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/scorecard`,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      scorecardVersion: 0,
      overallScore: null,
      releaseStatus: "DATA_INSUFFICIENT",
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/scorecard/recalculate`,
      payload: { actor: { type: "developer", id: "developer-1" } },
    });
    expect(denied.statusCode).toBe(403);

    const recalculated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/scorecard/recalculate`,
      payload: { actor: { type: "boss", id: "boss-local" } },
    });
    expect(recalculated.statusCode).toBe(200);
    expect(recalculated.json()).toMatchObject({
      scorecardVersion: 1,
      releaseStatus: "DATA_INSUFFICIENT",
      hardGates: expect.arrayContaining([
        expect.objectContaining({ gateId: "requirements-covered" }),
      ]),
    });

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/scorecard/history?limit=10`,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(1);
    await app.close();
  });

  it("creates, verifies, validates and applies a local backup without overwriting", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const { projectId } = await createStartedProject(app);
    const backupPath = `${root}/backup-output`;
    const restorePath = `${root}/restore-target`;

    const manifest = app.runtime.backup.create(backupPath, [projectId]);
    expect(manifest.schema_version).toBe("0012_task10_observability_ops");
    expect(manifest.file_checksums["database/company.db"]).toBeTruthy();
    const verification = app.runtime.backup.verify(backupPath);
    expect(verification).toMatchObject({ valid: true, backupId: manifest.backup_id });

    const validation = app.runtime.restore.validate(backupPath, restorePath);
    expect(validation.status).toBe("VALID");
    const applied = app.runtime.restore.apply(backupPath, restorePath, "CHG-TASK10-001");
    expect(applied.status).toBe("APPLIED");
    expect(applied.rebindRequired).toBe(true);
    expect(applied.manualActions.join(" ")).toContain("secretRef");
    await app.close();
  });
});
