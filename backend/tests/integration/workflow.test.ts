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
    dashboard = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    expect(
      dashboard.notifications.find(
        (notification: { subjectId: string }) =>
          notification.subjectId === approvalId,
      ).pending,
    ).toBe(false);
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
    const prdApprovalId = request.json().waitingFor as string;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${prdApprovalId}/decision`,
      payload: bossCommand(1, "reject-prd", {
        decision: "rejected",
        opinion: "先补充用户问题和范围边界",
      }),
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/approvals/${prdApprovalId}`,
        })
      ).json().responseTaskId,
    ).toBeTruthy();
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
    const releaseApprovalId = release.json().waitingFor as string;
    const releaseRejected = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${releaseApprovalId}/decision`,
      payload: bossCommand(1, "reject-release", {
        decision: "rejected",
        opinion: "先补齐回归证据",
      }),
    });
    expect(releaseRejected.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/approvals/${releaseApprovalId}`,
        })
      ).json().responseTaskId,
    ).toBeTruthy();
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

  it("routes an open defect through NPI regression before requesting test release", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "prd_submitted" },
    });
    const prd = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "pm_review_completed" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${prd.json().waitingFor}/decision`,
      payload: bossCommand(1, "approve-prd-defect", { decision: "approved" }),
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
    app.runtime.database.transaction((connection) => {
      connection
        .prepare(
          "INSERT INTO test_cases (id,project_id,task_id,acceptance_criteria_json,preconditions,steps,expected_result,test_type,owner_role,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "case-task4-defect",
          projectId,
          null,
          JSON.stringify(["缺陷回归"]),
          "测试环境就绪",
          "执行失败用例",
          "缺陷被记录并回归",
          "integration",
          "test_lead",
          utcNow(),
          1,
        );
      connection
        .prepare(
          "INSERT INTO test_runs (id,project_id,task_id,test_case_id,baseline_version_id,command_or_steps,environment_json,started_at,ended_at,actual_result,exit_code,status,evidence_version_id,trace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "run-task4-defect",
          projectId,
          null,
          "case-task4-defect",
          null,
          "执行失败用例",
          JSON.stringify({ environment: "test" }),
          utcNow(),
          utcNow(),
          "发现阻断缺陷",
          1,
          "failed",
          null,
          "trace-task4-defect",
        );
      connection
        .prepare(
          "INSERT INTO defects (id,project_id,task_id,source_test_run_id,reproduction,severity,actual_result,expected_result,evidence_version_id,npi_owner_role,status,fixed_version_id,regression_test_run_id,created_at,resolved_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "defect-task4-open",
          projectId,
          null,
          "run-task4-defect",
          "重复执行失败用例",
          "P1",
          "接口返回错误",
          "接口成功",
          null,
          "npi_lead",
          "open",
          null,
          null,
          utcNow(),
          null,
          1,
        );
    });
    const testPassed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "test_passed" },
    });
    expect(testPassed.statusCode).toBe(200);
    expect(testPassed.json().project.stage).toBe("缺陷/NPI/回归");
    expect(testPassed.json().waitingFor).toBeNull();
    const regression = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/advance`,
      payload: { trigger: "regression_passed" },
    });
    expect(regression.statusCode).toBe(200);
    expect(regression.json().project.stage).toBe("Boss 测试放行");
    expect(regression.json().project.status).toBe(ProjectStatus.WAITING_BOSS);
    expect(regression.json().waitingFor).toBeTruthy();
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
    const grantNow = new Date();
    const grantExpiresAt = new Date(grantNow.valueOf() + 60_000);
    const leaseExpiresAt = new Date(grantNow.valueOf() + 30_000);
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
      toolPolicy: ["file.read"],
      commandPolicy: ["node"],
      expiresAt: grantExpiresAt.toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      traceId: "trace-task4-lease",
    };
    const scheduler = new TaskScheduler();
    const expandedGrant = {
      ...grant,
      attemptId: "attempt-expanded-policy",
      workspaceRef: `workspace://${projectId}/attempt-expanded-policy`,
      toolPolicy: ["command.run"],
    };
    expect(() =>
      app.runtime.database.transaction((connection) =>
        scheduler.claim(connection, expandedGrant, grantNow),
      ),
    ).toThrow("工具或命令策略超出岗位策略");
    const lease = app.runtime.database.transaction((connection) =>
      scheduler.claim(connection, grant, grantNow),
    );
    expect(lease.status).toBe("active");
    const repeated = app.runtime.database.transaction((connection) =>
      scheduler.claim(connection, grant, grantNow),
    );
    expect(repeated.leaseId).toBe(lease.leaseId);
    const heartbeated = app.runtime.database.transaction((connection) =>
      scheduler.heartbeat(
        connection,
        grant.attemptId,
        new Date(grantNow.valueOf() + 5_000),
        300_000,
      ),
    );
    expect(heartbeated.grantExpiresAt).toBe(grant.expiresAt);
    expect(heartbeated.expiresAt).toBe(grant.expiresAt);
    expect(() =>
      app.runtime.database.transaction((connection) =>
        scheduler.release(connection, grant.attemptId, {
          status: "succeeded",
          requiresReview: true,
          evidenceComplete: false,
        }),
      ),
    ).toThrow("不能提交 Review");
    const released = app.runtime.database.transaction((connection) =>
      scheduler.release(connection, grant.attemptId, {
        status: "succeeded",
        requiresReview: true,
      }),
    );
    expect(released.taskStatus).toBe(TaskStatus.WAITING_REVIEW);
    const selfReview = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/review`,
      payload: {
        commandId: "review-task4-self",
        idempotencyKey: "review-task4-self",
        expectedVersion: 3,
        actor: { type: "product_market_pm", id: "emp_01" },
        decision: "approved",
        comments: "负责人不应批准自己的 Review",
      },
    });
    expect(selfReview.statusCode).toBe(403);
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

  it("expires a stored lease instead of returning it for a later repeated Claim", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    const task = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json().tasks[0] as { id: string; version: number };
    const now = new Date();
    const grantExpiresAt = new Date(now.valueOf() + 60_000);
    const shortLeaseExpiresAt = new Date(now.valueOf() + 5_000);
    const grant: ExecutionGrant = {
      grantId: "grant-expired-replay",
      projectId,
      taskId: task.id,
      attemptId: "attempt-expired-replay",
      roleId: "product_market_pm",
      roleVersion: 1,
      taskVersion: task.version,
      modelConfigVersion: "model-v1",
      workspaceRef: `workspace://${projectId}/attempt-expired-replay`,
      toolPolicy: ["file.read"],
      commandPolicy: ["node"],
      expiresAt: grantExpiresAt.toISOString(),
      leaseExpiresAt: shortLeaseExpiresAt.toISOString(),
      traceId: "trace-expired-replay",
    };
    const scheduler = new TaskScheduler();
    app.runtime.database.transaction((connection) =>
      scheduler.claim(connection, grant, now),
    );
    const replayGrant = {
      ...grant,
      leaseExpiresAt: grantExpiresAt.toISOString(),
    };
    const expired = app.runtime.database.transaction((connection) =>
      scheduler.claim(
        connection,
        replayGrant,
        new Date(now.valueOf() + 10_000),
      ),
    );
    expect(expired.status).toBe("expired");
    const stored = app.runtime.database.connection
      .prepare("SELECT status FROM workflow_leases WHERE attempt_id=?")
      .get("attempt-expired-replay") as { status: string };
    expect(stored.status).toBe("expired");
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
    const repeatedRisk = await app.inject({
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
    expect(repeatedRisk.statusCode).toBe(200);
    expect(repeatedRisk.json().approvalId).toBe(risk.approvalId);

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
      .prepare("SELECT status,response_task_id FROM workflow_risks WHERE id=?")
      .get("risk-p0-task4") as { status: string };
    expect(storedRisk.status).toBe("resolved");
    const responseTaskId = app.runtime.database.connection
      .prepare("SELECT response_task_id FROM approvals WHERE id=?")
      .get(risk.approvalId) as { response_task_id: string };
    expect(responseTaskId.response_task_id).toBeTruthy();
    await app.close();
  });

  it("routes a general risk to the affected domain lead with a linked response task", async () => {
    const app = await createTestApp(useTestRoot());
    const { projectId } = await createAndStart(app);
    const dashboard = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/dashboard`,
      })
    ).json();
    const affectedTask = dashboard.tasks[0] as {
      id: string;
      ownerRole: string;
    };
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/risks`,
      payload: {
        id: "risk-p2-task4",
        taskId: affectedTask.id,
        severity: "P2",
        reason: "验收口径存在偏差",
        impactScope: [affectedTask.id],
        evidence: ["trace-risk-p2"],
        recommendation: "由产品方案 PM 补齐验收口径并提交响应证据",
      },
    });
    expect(created.statusCode).toBe(200);
    const response = created.json() as {
      responseTaskId: string;
      responseOwnerRole: string;
    };
    expect(response.responseTaskId).toBeTruthy();
    expect(response.responseOwnerRole).toBe("product_solution_pm");
    const storedRisk = app.runtime.database.connection
      .prepare(
        "SELECT response_task_id FROM workflow_risks WHERE id=? AND project_id=?",
      )
      .get("risk-p2-task4", projectId) as { response_task_id: string };
    expect(storedRisk.response_task_id).toBe(response.responseTaskId);
    const responseTask = app.runtime.database.connection
      .prepare("SELECT owner_role,status FROM tasks WHERE id=?")
      .get(response.responseTaskId) as {
      owner_role: string;
      status: string;
    };
    expect(responseTask.owner_role).toBe("product_solution_pm");
    expect(responseTask.status).toBe(TaskStatus.PENDING);
    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/risks`,
      payload: {
        id: "risk-p2-task4",
        taskId: affectedTask.id,
        severity: "P2",
        reason: "验收口径存在偏差",
        impactScope: [affectedTask.id],
        evidence: ["trace-risk-p2"],
        recommendation: "由产品方案 PM 补齐验收口径并提交响应证据",
      },
    });
    expect(repeated.statusCode).toBe(200);
    const riskCount = app.runtime.database.connection
      .prepare("SELECT COUNT(*) AS count FROM workflow_risks WHERE id=?")
      .get("risk-p2-task4") as { count: number };
    const responseTaskCount = app.runtime.database.connection
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE id=?")
      .get(response.responseTaskId) as { count: number };
    expect(riskCount.count).toBe(1);
    expect(responseTaskCount.count).toBe(1);
    await app.close();
  });
});
