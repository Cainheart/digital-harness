import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  WorkflowCoordinator,
  RiskInput,
} from "../application/workflow-coordinator.js";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import {
  TaskScheduler,
  ExecutionGrant,
  ReleaseResult,
  assertLeaseActive,
  assertScheduleDecisionAccepted,
} from "../workflow/scheduler.js";
import { createRequestTraceId } from "./request-trace.js";
import {
  requireRecord,
  requireSafeString,
  requireString,
} from "./request-validation.js";
import type { ResearchWorkflow } from "../application/research-workflow.js";

/** 注册 Task 4 项目控制、固定工作流、审批、通知和任务租约接口。 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  options: { testMode: boolean; researchWorkflow?: ResearchWorkflow },
): void {
  const coordinator = new WorkflowCoordinator(
    app.runtime.database,
    options.researchWorkflow,
  );
  const scheduler = new TaskScheduler();

  app.post("/api/v1/projects", async (request, reply) => {
    const traceId = createRequestTraceId("project-create");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const project = coordinator.createProject(body);
    reply.code(201);
    return {
      project,
      allowedActions: ["start", "terminate_preview"],
      traceId,
    };
  });

  app.post("/api/v1/projects/:projectId/start", async (request) => {
    const traceId = createRequestTraceId("project-start");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = projectParam(request, traceId);
    return coordinator.startProject(
      projectId,
      requireRecord(request.body, "body", traceId),
    );
  });

  app.post("/api/v1/projects/:projectId/pause", async (request) => {
    const traceId = createRequestTraceId("project-pause");
    assertLocalRequest(request, options.testMode, traceId);
    return coordinator.pauseProject(
      projectParam(request, traceId),
      requireRecord(request.body, "body", traceId),
    );
  });

  app.post("/api/v1/projects/:projectId/resume", async (request) => {
    const traceId = createRequestTraceId("project-resume");
    assertLocalRequest(request, options.testMode, traceId);
    return coordinator.resumeProject(
      projectParam(request, traceId),
      requireRecord(request.body, "body", traceId),
    );
  });

  app.post("/api/v1/projects/:projectId/terminate/preview", async (request) => {
    const traceId = createRequestTraceId("project-terminate-preview");
    assertLocalRequest(request, options.testMode, traceId);
    return coordinator.terminatePreview(
      projectParam(request, traceId),
      requireRecord(request.body, "body", traceId),
    );
  });

  app.post("/api/v1/projects/:projectId/terminate/confirm", async (request) => {
    const traceId = createRequestTraceId("project-terminate-confirm");
    assertLocalRequest(request, options.testMode, traceId);
    return coordinator.terminateProject(
      projectParam(request, traceId),
      requireRecord(request.body, "body", traceId),
    );
  });

  app.post("/api/v1/projects/:projectId/advance", async (request) => {
    const traceId = createRequestTraceId("workflow-advance");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const trigger = requireString(
      body.trigger,
      "trigger",
      traceId,
    ) as Parameters<WorkflowCoordinator["advance"]>[1];
    return coordinator.advance(
      projectParam(request, traceId),
      trigger,
      traceId,
    );
  });

  app.get("/api/v1/projects/:projectId/dashboard", async (request) => {
    const traceId = createRequestTraceId("project-dashboard");
    assertLocalRequest(request, options.testMode, traceId);
    return coordinator.getDashboard(projectParam(request, traceId));
  });

  app.get("/api/v1/approvals/:approvalId", async (request) => {
    const traceId = createRequestTraceId("approval-get");
    assertLocalRequest(request, options.testMode, traceId);
    const approvalId = requireSafeString(
      (request.params as { approvalId?: string }).approvalId ?? "",
      "approvalId",
      traceId,
    );
    return coordinator.getApproval(approvalId);
  });

  app.post("/api/v1/approvals/:approvalId/decision", async (request) => {
    const traceId = createRequestTraceId("approval-decision");
    assertLocalRequest(request, options.testMode, traceId);
    const approvalId = requireSafeString(
      (request.params as { approvalId?: string }).approvalId ?? "",
      "approvalId",
      traceId,
    );
    return coordinator.decideApproval(
      approvalId,
      requireRecord(request.body, "body", traceId),
    );
  });

  app.post("/api/v1/tasks/:taskId/review", async (request) => {
    const traceId = createRequestTraceId("task-review");
    assertLocalRequest(request, options.testMode, traceId);
    const taskId = requireSafeString(
      (request.params as { taskId?: string }).taskId ?? "",
      "taskId",
      traceId,
    );
    return coordinator.reviewTask(
      taskId,
      requireRecord(request.body, "body", traceId),
    );
  });

  app.get("/api/v1/notifications", async (request) => {
    const traceId = createRequestTraceId("notifications");
    assertLocalRequest(request, options.testMode, traceId);
    const query = parseNotificationQuery(request, traceId);
    return coordinator.listNotifications(query.projectId, query.limit);
  });

  app.post("/api/v1/notifications/:notificationId/read", async (request) => {
    const traceId = createRequestTraceId("notification-read");
    assertLocalRequest(request, options.testMode, traceId);
    return coordinator.markNotificationRead(
      requireSafeString(
        (request.params as { notificationId?: string }).notificationId ?? "",
        "notificationId",
        traceId,
      ),
    );
  });

  app.post("/api/v1/notifications/:notificationId/handle", async (request) => {
    const traceId = createRequestTraceId("notification-handle");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    return coordinator.handleNotification(
      requireSafeString(
        (request.params as { notificationId?: string }).notificationId ?? "",
        "notificationId",
        traceId,
      ),
      requireString(body.handledBy, "handledBy", traceId),
      requireString(body.action, "action", traceId),
    );
  });

  app.post("/api/v1/projects/:projectId/risks", async (request) => {
    const traceId = createRequestTraceId("risk-create");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const risk: RiskInput = {
      id: requireString(body.id, "id", traceId),
      projectId: projectParam(request, traceId),
      taskId:
        body.taskId == null
          ? undefined
          : requireString(body.taskId, "taskId", traceId),
      severity: requireString(
        body.severity,
        "severity",
        traceId,
      ) as RiskInput["severity"],
      reason: requireString(body.reason, "reason", traceId),
      impactScope: requireStringArray(body.impactScope, "impactScope", traceId),
      evidence: requireStringArray(body.evidence, "evidence", traceId),
      recommendation: requireString(
        body.recommendation,
        "recommendation",
        traceId,
      ),
    };
    return coordinator.createRisk(risk);
  });

  app.post("/api/v1/tasks/:taskId/claim", async (request) => {
    const traceId = createRequestTraceId("task-claim");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const grant = parseGrant(
      body,
      requireSafeString(
        (request.params as { taskId?: string }).taskId ?? "",
        "taskId",
        traceId,
      ),
      traceId,
    );
    const lease = app.runtime.database.transaction((connection) =>
      scheduler.claim(connection, grant),
    );
    assertLeaseActive(lease);
    return lease;
  });

  app.post("/api/v1/attempts/:attemptId/heartbeat", async (request) => {
    const traceId = createRequestTraceId("attempt-heartbeat");
    assertLocalRequest(request, options.testMode, traceId);
    const attemptId = requireSafeString(
      (request.params as { attemptId?: string }).attemptId ?? "",
      "attemptId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const extensionMs =
      body.extensionMs == null ? 30_000 : Number(body.extensionMs);
    const lease = app.runtime.database.transaction((connection) =>
      scheduler.heartbeat(connection, attemptId, new Date(), extensionMs),
    );
    assertLeaseActive(lease);
    return lease;
  });

  app.post("/api/v1/attempts/:attemptId/release", async (request) => {
    const traceId = createRequestTraceId("attempt-release");
    assertLocalRequest(request, options.testMode, traceId);
    const attemptId = requireSafeString(
      (request.params as { attemptId?: string }).attemptId ?? "",
      "attemptId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const result: ReleaseResult = {
      status: requireString(
        body.status,
        "status",
        traceId,
      ) as ReleaseResult["status"],
      requiresReview: body.requiresReview === true,
      evidenceComplete: body.evidenceComplete !== false,
      failureReason:
        body.failureReason == null
          ? undefined
          : requireString(body.failureReason, "failureReason", traceId),
    };
    const decision = app.runtime.database.transaction((connection) =>
      scheduler.release(connection, attemptId, result),
    );
    assertScheduleDecisionAccepted(decision);
    return decision;
  });
}

/** 从路径读取安全项目 ID，避免同一路由的空值进入业务服务。 */
function projectParam(request: FastifyRequest, traceId: string): string {
  return requireSafeString(
    (request.params as { projectId?: string }).projectId ?? "",
    "projectId",
    traceId,
  );
}

/** 解析通知列表查询并限制分页资源。 */
function parseNotificationQuery(
  request: FastifyRequest,
  traceId: string,
): { projectId: string | null; limit: number } {
  const search = new URL(request.raw.url ?? "/", "http://localhost")
    .searchParams;
  const unknown = [...search.keys()].filter(
    (key) => !["projectId", "limit"].includes(key),
  );
  if (unknown.length > 0)
    throw new InvalidArgumentError("存在未声明的通知查询参数", {
      traceId,
      data: { unknown },
    });
  const rawLimit = search.get("limit");
  const limit = rawLimit == null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new InvalidArgumentError("limit 必须介于 1 和 500 之间", { traceId });
  const projectId = search.get("projectId")?.trim() || null;
  return { projectId, limit };
}

/** 校验并冻结 Worker Grant，不能从 HTTP body 扩大项目或工具范围。 */
function parseGrant(
  body: Record<string, unknown>,
  taskId: string,
  traceId: string,
): ExecutionGrant {
  const grant = body.grant;
  if (!grant || typeof grant !== "object" || Array.isArray(grant))
    throw new InvalidArgumentError("grant 必须是对象", { traceId });
  const value = grant as Record<string, unknown>;
  const stringField = (field: string): string =>
    requireString(value[field], `grant.${field}`, traceId);
  const arrayField = (field: string): string[] =>
    requireStringArray(value[field], `grant.${field}`, traceId);
  return {
    grantId: stringField("grantId"),
    projectId: stringField("projectId"),
    taskId,
    attemptId: stringField("attemptId"),
    roleId: stringField("roleId"),
    roleVersion: Number(value.roleVersion),
    taskVersion: Number(value.taskVersion),
    modelConfigVersion: stringField("modelConfigVersion"),
    workspaceRef: stringField("workspaceRef"),
    toolPolicy: arrayField("toolPolicy"),
    commandPolicy: arrayField("commandPolicy"),
    expiresAt: stringField("expiresAt"),
    leaseExpiresAt: stringField("leaseExpiresAt"),
    traceId: stringField("traceId"),
  };
}

function requireStringArray(
  value: unknown,
  field: string,
  traceId: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new InvalidArgumentError(`${field} 必须是非空字符串数组`, {
      traceId,
    });
  return value.map((item) => requireString(item, field, traceId));
}
