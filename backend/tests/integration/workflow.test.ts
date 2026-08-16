import { describe, expect, it } from "vitest";
import { ProjectStatus, TaskStatus, utcNow } from "../../src/domain/common.js";
import { createTestApp, useTestRoot } from "../helpers.js";
import { TaskScheduler, ExecutionGrant } from "../../src/workflow/scheduler.js";

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
      commandId: "create-project-command",
      idempotencyKey: "create-project",
      expectedVersion: 0,
      actor: { type: "boss", id: "boss-local" },
      name: "Task 4 验收项目",
      businessGoal: "验证固定工作流",
      targetUsers: "工程团队",
      priority: "P1",
    },
  });
  expect(created.statusCode).toBe(201);
  const project = created.json().project as { id: string; version: number };
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/start`,
    payload: bossCommand(project.version, "start-project"),
  });
  expect(started.statusCode).toBe(200);
  return {
    projectId: project.id,
    projectVersion: started.json().version as number,
    taskId: started.json().eventId as string,
  };
}

describe("Task 4 workflow coordinator", () => {
  it("runs the fixed flow through all four gates and archives without a direct jump", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    let dashboard = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(dashboard.project.status).toBe(ProjectStatus.RUNNING);
    expect(dashboard.project.stage).toBe("调研/PRD");

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
    expect(approvalRequest.statusCode).toBe(200);
    const approvalId = approvalRequest.json().waitingFor as string;
    expect(approvalId).toBeTruthy();
    dashboard = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(dashboard.project.status).toBe(ProjectStatus.WAITING_BOSS);

    const prdApproval = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: bossCommand(1, "approve-prd", {
        decision: "approved",
        evidenceVersion: 1,
      }),
    });
    expect(prdApproval.statusCode).toBe(200);
    expect(prdApproval.json().version).toBe(2);
    const repeatedPrdApproval = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: bossCommand(1, "approve-prd", {
        decision: "approved",
        evidenceVersion: 1,
      }),
    });
    expect(repeatedPrdApproval.statusCode).toBe(200);
    expect(repeatedPrdApproval.json()).toEqual(prdApproval.json());

    const triggers = [
      "feasibility_completed",
      "task_breakdown_completed",
      "development_completed",
      "review_passed",
      "test_strategy_completed",
    ] as const;
    for (const trigger of triggers) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/advance`,
        payload: { trigger },
      });
      expect(response.statusCode).toBe(200);
    }
    const releaseRequest = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "test_passed" },
    });
    expect(releaseRequest.statusCode).toBe(200);
    const releaseApprovalId = releaseRequest.json().waitingFor as string;
    const releaseApproval = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${releaseApprovalId}/decision`,
      payload: bossCommand(1, "approve-release", {
        decision: "approved",
        evidenceVersion: 1,
      }),
    });
    expect(releaseApproval.statusCode).toBe(200);
    dashboard = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(dashboard.project.status).toBe(ProjectStatus.CLOSING);
    expect(dashboard.project.stage).toBe("结项检查/历史归档");

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "closing_checks_passed" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().project.status).toBe(ProjectStatus.COMPLETED);

    const illegal = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/resume`,
      payload: bossCommand(
        completed.json().project.version,
        "resume-completed",
      ),
    });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().code).toBe("WORKFLOW_GUARD_BLOCKED");
    await app.close();
  });

  it("keeps PRD rejection and test-release rejection on their required rework paths", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "prd_submitted" },
    });
    const request = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "pm_review_completed" },
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${request.json().waitingFor}/decision`,
      payload: bossCommand(1, "reject-prd", {
        decision: "rejected",
        opinion: "先补充用户问题和范围边界",
      }),
    });
    expect(rejected.statusCode).toBe(200);
    let dashboard = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(dashboard.project.stage).toBe("调研/PRD");
    expect(
      dashboard.tasks.some(
        (task: { title: string }) => task.title === "PM 修订 PRD",
      ),
    ).toBe(true);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "prd_submitted" },
    });
    const secondRequest = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "pm_review_completed" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${secondRequest.json().waitingFor}/decision`,
      payload: bossCommand(1, "approve-prd-2", { decision: "approved" }),
    });
    for (const trigger of [
      "feasibility_completed",
      "task_breakdown_completed",
      "development_completed",
      "review_passed",
      "test_strategy_completed",
    ] as const)
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/advance`,
        payload: { trigger },
      });
    const release = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "test_passed" },
    });
    const releaseRejected = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${release.json().waitingFor}/decision`,
      payload: bossCommand(1, "reject-release", {
        decision: "rejected",
        opinion: "先补齐回归证据",
      }),
    });
    expect(releaseRejected.statusCode).toBe(200);
    dashboard = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(dashboard.project.stage).toBe("测试策略/用例");
    expect(
      dashboard.tasks.some(
        (task: { title: string }) => task.title === "测试放行整改计划",
      ),
    ).toBe(true);
    expect(
      dashboard.tasks.some(
        (task: { title: string }) => task.title === "PM 修订 PRD",
      ),
    ).toBe(true);
    await app.close();
  });

  it("pauses, resumes, previews termination and requires the second confirmation", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/pause`,
      payload: bossCommand(2, "pause-project", {
        reason: "等待业务方向",
        recoveryCondition: "Boss 完成方向确认",
      }),
    });
    expect(pause.statusCode).toBe(200);
    const paused = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(paused.project.status).toBe(ProjectStatus.PAUSED);
    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/resume`,
      payload: bossCommand(paused.project.version, "resume-project"),
    });
    expect(resume.statusCode).toBe(200);
    const preview = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminate/preview`,
      payload: bossCommand(resume.json().version, "preview-termination", {
        reason: "项目方向终止",
      }),
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json();
    const emptyReason = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminate/confirm`,
      payload: bossCommand(resume.json().version, "confirm-empty", {
        reason: "",
        confirmationToken: previewBody.confirmationToken,
      }),
    });
    expect(emptyReason.statusCode).toBe(400);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminate/confirm`,
      payload: bossCommand(resume.json().version, "confirm-termination", {
        reason: "项目方向终止",
        confirmationToken: previewBody.confirmationToken,
      }),
    });
    expect(confirmed.statusCode).toBe(200);
    const after = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(after.project.status).toBe(ProjectStatus.TERMINATED);
    expect(after.project.readOnly).toBe(true);
    await app.close();
  });

  it("claims a dependency-free task with an isolated lease and moves it to Review", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    const task = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json().tasks[0] as { id: string; version: number };
    const grant: ExecutionGrant = {
      grantId: "grant-task4",
      projectId,
      taskId: task.id,
      attemptId: "attempt-task4",
      roleId: "product_market_pm",
      roleVersion: 1,
      taskVersion: task.version,
      modelConfigVersion: "model-v1",
      workspaceRef: `workspace://${projectId}/attempt-task4`,
      toolPolicy: ["repo_scan"],
      commandPolicy: ["npm test"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      traceId: "trace-task4-lease",
    };
    const scheduler = new TaskScheduler();
    const lease = app.runtime.database.transaction((connection) =>
      scheduler.claim(connection, grant),
    );
    expect(lease.status).toBe("active");
    const released = app.runtime.database.transaction((connection) =>
      scheduler.release(connection, grant.attemptId, {
        status: "succeeded",
        requiresReview: true,
      }),
    );
    expect(released.taskStatus).toBe(TaskStatus.WAITING_REVIEW);
    const reviewed = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/review`,
      payload: {
        commandId: "review-task4",
        idempotencyKey: "review-task4",
        expectedVersion: 3,
        actor: {
          type: "developer_representative",
          id: "developer-representative-local",
        },
        decision: "approved",
        comments: "交付物和执行证据完整",
      },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().version).toBe(4);
    const secondClaim = app.runtime.database.transaction((connection) => {
      const count = (
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_leases WHERE task_id=? AND status='active'",
          )
          .get(task.id) as { count: number }
      ).count;
      return count;
    });
    expect(secondClaim).toBe(0);
    await app.close();
  });

  it("pauses on a P0 risk, requires Boss approval, and resolves the risk on recovery", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/risks`,
      payload: {
        id: "risk-p0-task4",
        severity: "P0",
        reason: "关键依赖不可用",
        impactScope: ["当前项目"],
        evidence: ["trace-risk-1"],
        recommendation: "完成 Boss 方向裁决并恢复执行",
      },
    });
    expect(created.statusCode).toBe(200);
    const risk = created.json() as { approvalId: string };
    expect(risk.approvalId).toBeTruthy();
    const paused = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(paused.project.status).toBe(ProjectStatus.PAUSED);
    expect(
      paused.notifications.some(
        (notification: { notificationType: string }) =>
          notification.notificationType === "major_risk",
      ),
    ).toBe(true);

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${risk.approvalId}/decision`,
      payload: bossCommand(1, "approve-risk", {
        decision: "approved",
        opinion: "按恢复条件继续执行",
      }),
    });
    expect(approved.statusCode).toBe(200);
    const recovered = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(recovered.project.status).toBe(ProjectStatus.RUNNING);
    const storedRisk = app.runtime.database.connection
      .prepare("SELECT status FROM workflow_risks WHERE id=?")
      .get("risk-p0-task4") as { status: string };
    expect(storedRisk.status).toBe("resolved");
    await app.close();
  });
});
