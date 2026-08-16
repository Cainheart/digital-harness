import { describe, expect, it } from "vitest";
import { ProjectStatus, utcNow } from "../../src/domain/common.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import { createTestApp, makeProject, useTestRoot } from "../helpers.js";

function bossCommand(
  expectedVersion: number,
  idempotencyKey: string,
  payload: Record<string, unknown> = {},
) {
  return {
    commandId: `${idempotencyKey}-command`,
    idempotencyKey,
    expectedVersion,
    actor: { type: "boss", id: "boss-local" },
    payload,
  };
}

async function createAndStart(app: Awaited<ReturnType<typeof createTestApp>>) {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      commandId: "task9-create-command",
      idempotencyKey: "task9-create-project",
      expectedVersion: 0,
      actor: { type: "boss", id: "boss-local" },
      name: "Task 9 控制台项目",
      businessGoal: "验证 Boss 控制台查询和命令边界",
      targetUsers: "业务负责人",
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
    payload: bossCommand(project.version, "task9-start-project"),
  });
  expect(started.statusCode).toBe(200);
  const dashboard = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}/dashboard`,
  });
  return {
    projectId: project.id,
    taskId: dashboard.json().tasks[0].id as string,
  };
}

describe("Task 9 Boss console", () => {
  it("returns persistent dashboard projections and project-scoped read queries", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId, taskId } = await createAndStart(app);

    const dashboard = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/dashboard`,
    });
    expect(dashboard.statusCode).toBe(200);
    const view = dashboard.json();
    expect(view.phases).toHaveLength(14);
    expect(view.employees.length).toBeGreaterThan(0);
    expect(view.modelSummary).toMatchObject({
      callCount: 0,
      durationMs: 0,
      errors: 0,
      totalTokens: 0,
      costMicros: 0,
    });
    expect(view.allowedActions).toContain("pause");
    expect(view.nextAction).toBeTruthy();

    const task = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/tasks/${taskId}`,
    });
    expect(task.statusCode).toBe(200);
    expect(task.json()).toMatchObject({ id: taskId, projectId });

    const taskPage = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/tasks`,
    });
    expect(taskPage.statusCode).toBe(200);
    expect(taskPage.json().items[0].task.id).toBe(taskId);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?limit=20`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().items.length).toBeGreaterThan(0);
    expect(events.json().items[0].payload.projectId).toBe(projectId);

    await app.close();
  });

  it("keeps approval notifications pending until the approval command closes them", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "prd_submitted" },
    });
    const approvalRequest = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "pm_review_completed" },
    });
    const approvalId = approvalRequest.json().waitingFor as string;
    const notifications = await app.inject({
      method: "GET",
      url: `/api/v1/notifications?projectId=${projectId}`,
    });
    const approvalNotification = notifications
      .json()
      .items.find(
        (item: { subjectId: string }) => item.subjectId === approvalId,
      ) as { id: string; version: number; pending: boolean };
    expect(approvalNotification.pending).toBe(true);

    const acknowledgement = bossCommand(
      approvalNotification.version,
      "task9-acknowledge-approval",
    );
    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${approvalNotification.id}/acknowledge`,
      payload: acknowledgement,
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().version).toBe(approvalNotification.version + 1);
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${approvalNotification.id}/acknowledge`,
      payload: acknowledgement,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(acknowledged.json());

    const afterRead = await app.inject({
      method: "GET",
      url: `/api/v1/notifications?projectId=${projectId}`,
    });
    const afterReadItem = afterRead
      .json()
      .items.find(
        (item: { id: string }) => item.id === approvalNotification.id,
      );
    expect(afterReadItem).toMatchObject({ unread: false, pending: true });

    const rejectedWithoutOpinion = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: bossCommand(1, "task9-reject-without-opinion", {
        decision: "rejected",
      }),
    });
    expect(rejectedWithoutOpinion.statusCode).toBe(400);
    await app.close();
  });

  it("lists only final projects and enforces Boss two-step archive deletion", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject({
      name: "Task 9 历史项目",
      stage: "结项检查/历史归档",
      status: ProjectStatus.COMPLETED,
      endedAt: utcNow(),
      readOnly: true,
    });
    const repository = new ProjectTaskRepository();
    app.runtime.database.transaction((connection) =>
      repository.createProject(connection, project),
    );

    const archive = await app.inject({
      method: "GET",
      url: "/api/v1/archive?status=已结项",
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().items).toHaveLength(1);
    expect(archive.json().items[0]).toMatchObject({
      id: project.id,
      finalStatus: ProjectStatus.COMPLETED,
      version: 1,
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/archive/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().readOnly).toBe(true);
    expect(detail.json().dashboard.project.id).toBe(project.id);

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/v1/archive/${project.id}/delete/preview`,
      payload: {
        actor: { type: "boss", id: "boss-local" },
        expectedVersion: 1,
      },
    });
    expect(missingKey.statusCode).toBe(400);

    const nonBoss = await app.inject({
      method: "POST",
      url: `/api/v1/archive/${project.id}/delete/preview`,
      payload: {
        idempotencyKey: "task9-archive-preview-non-boss",
        expectedVersion: 1,
        actor: { type: "developer", id: "developer-1" },
      },
    });
    expect(nonBoss.statusCode).toBe(403);

    const preview = await app.inject({
      method: "POST",
      url: `/api/v1/archive/${project.id}/delete/preview`,
      payload: {
        ...bossCommand(1, "task9-archive-preview"),
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().requiresSecondConfirmation).toBe(true);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/archive/${project.id}/delete/confirm`,
      payload: {
        ...bossCommand(1, "task9-archive-confirm"),
        confirmationToken: preview.json().confirmationToken,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      projectId: project.id,
      actorId: "boss-local",
    });

    const deletedDetail = await app.inject({
      method: "GET",
      url: `/api/v1/archive/${project.id}`,
    });
    expect(deletedDetail.statusCode).toBe(404);
    const audit = app.runtime.database.connection
      .prepare(
        "SELECT project_id,deleted_at,actor_id FROM project_deletion_audits WHERE project_id=?",
      )
      .get(project.id) as {
      project_id: string;
      deleted_at: string;
      actor_id: string;
    };
    expect(audit).toMatchObject({
      project_id: project.id,
      actor_id: "boss-local",
    });
    expect(audit.deleted_at).toBeTruthy();
    await app.close();
  });

  it("blocks a database when the Task 9 archive query index is missing", async () => {
    const app = await createTestApp(useTestRoot());
    app.runtime.database.connection
      .prepare("DROP INDEX ix_archive_deletion_confirmations_project_status")
      .run();
    const result = app.runtime.database.checkSchema();
    expect(result.writable).toBe(false);
    expect(result.code).toBe("SCHEMA_INTEGRITY_CONFLICT");
    await app.close();
  });
});
