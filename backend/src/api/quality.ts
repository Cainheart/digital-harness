import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { QualityFlowService } from "../application/quality-flow.js";
import { EvidenceRepository } from "../infra/repositories/evidence.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import { QualityRepository } from "../infra/repositories/quality.js";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireRecord, requireSafeString } from "./request-validation.js";

/** 注册 Task 8 任务拆解、测试、缺陷和 NPI 回归控制面接口。 */
export function registerQualityRoutes(
  app: FastifyInstance,
  options: { testMode: boolean; qualityFlow: QualityFlowService },
): void {
  const projectTasks = new ProjectTaskRepository();
  const evidence = new EvidenceRepository();
  const quality = new QualityRepository();

  /** 开发代表接收已批准需求并创建至少三个专业任务。 */
  const decompositionHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const traceId = createRequestTraceId("quality-decompose");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = pathString(request, "projectId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const result = options.qualityFlow.decomposeTasks(
      projectId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return result;
  };
  app.post("/api/v1/projects/:projectId/coding-tasks", decompositionHandler);
  app.post("/api/projects/:projectId/coding-tasks", decompositionHandler);

  /** 返回项目任务及版本化质量规格；查询不触发执行或状态变化。 */
  app.get("/api/v1/projects/:projectId/tasks", async (request) => {
    const traceId = createRequestTraceId("quality-tasks");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = pathString(request, "projectId", traceId);
    const query = parseTaskPageQuery(request, traceId);
    const page = app.runtime.database.transaction((connection) =>
      projectTasks.listTasks(connection, projectId, query.cursor, query.limit),
    );
    return {
      ...page,
      items: page.items.map((task) => ({
        task,
        qualitySpec: app.runtime.database.transaction((connection) =>
          quality.getTaskQualitySpec(connection, projectId, task.id),
        ),
      })),
      traceId,
    };
  });

  /** 返回单个任务、质量规格和编码会话，供 Review/测试追踪使用。 */
  app.get("/api/v1/tasks/:taskId", async (request) => {
    const traceId = createRequestTraceId("quality-task");
    assertLocalRequest(request, options.testMode, traceId);
    const taskId = pathString(request, "taskId", traceId);
    return app.runtime.database.transaction((connection) => {
      const task = projectTasks.getTask(connection, taskId);
      return {
        task,
        qualitySpec: quality.getTaskQualitySpec(connection, task.projectId, task.id),
        codingSessions: connection
          .prepare(
            "SELECT id,status,attempt_id,trace_id,created_at,updated_at FROM coding_sessions WHERE project_id=? AND task_id=? ORDER BY created_at,id",
          )
          .all(task.projectId, task.id),
        traceId,
      };
    });
  });

  /** 测试组长先创建策略，再按批准验收标准创建用例。 */
  app.post("/api/v1/projects/:projectId/test-strategies", async (request, reply) => {
    const traceId = createRequestTraceId("quality-strategy");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = pathString(request, "projectId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const strategy = options.qualityFlow.createTestStrategy(
      projectId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return { strategy, traceId };
  });

  /** 创建测试用例；用例没有策略引用时由应用服务拒绝。 */
  app.post("/api/v1/test-strategies/:strategyId/test-cases", async (request, reply) => {
    const traceId = createRequestTraceId("quality-case");
    assertLocalRequest(request, options.testMode, traceId);
    const strategyId = pathString(request, "strategyId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const testCase = options.qualityFlow.createTestCase(
      strategyId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return { testCase, traceId };
  });

  /** 执行测试并保存真实结果；失败在同一事务自动创建 Defect。 */
  app.post("/api/v1/test-cases/:testCaseId/runs", async (request, reply) => {
    const traceId = createRequestTraceId("quality-run");
    assertLocalRequest(request, options.testMode, traceId);
    const testCaseId = pathString(request, "testCaseId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const result = options.qualityFlow.runTest(
      testCaseId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return result;
  });

  /** 查询不可变 TestRun 和真实证据引用。 */
  app.get("/api/v1/test-runs/:testRunId", async (request) => {
    const traceId = createRequestTraceId("quality-run-get");
    assertLocalRequest(request, options.testMode, traceId);
    const testRunId = pathString(request, "testRunId", traceId);
    return {
      testRun: evidence.getTestRun(app.runtime.database.connection, testRunId),
      traceId,
    };
  });

  /** 返回测试放行需要的五类摘要和硬性阻断结论。 */
  app.get("/api/v1/projects/:projectId/test-report", async (request) => {
    const traceId = createRequestTraceId("quality-report");
    assertLocalRequest(request, options.testMode, traceId);
    return options.qualityFlow.getTestReport(
      pathString(request, "projectId", traceId),
      traceId,
    );
  });

  /** 允许测试角色从失败 TestRun 补交缺陷，正常失败已自动创建缺陷。 */
  app.post("/api/v1/test-runs/:testRunId/defects", async (request, reply) => {
    const traceId = createRequestTraceId("quality-defect");
    assertLocalRequest(request, options.testMode, traceId);
    const testRunId = pathString(request, "testRunId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const defect = options.qualityFlow.createDefectFromTestRun(
      testRunId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return { defect, traceId };
  });

  /** 查询缺陷及其当前 NPI/回归状态。 */
  app.get("/api/v1/defects/:defectId", async (request) => {
    const traceId = createRequestTraceId("quality-defect-get");
    assertLocalRequest(request, options.testMode, traceId);
    const defectId = pathString(request, "defectId", traceId);
    return {
      defect: evidence.getDefect(app.runtime.database.connection, defectId),
      traceId,
    };
  });

  /** NPI 记录复现和根因分析。 */
  app.post("/api/v1/defects/:defectId/npi-analysis", async (request, reply) => {
    const traceId = createRequestTraceId("quality-npi-analysis");
    assertLocalRequest(request, options.testMode, traceId);
    const defectId = pathString(request, "defectId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const analysis = options.qualityFlow.createNpiAnalysis(
      defectId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return { analysis, traceId };
  });

  /** NPI 提交修复，只能进入待回归。 */
  app.post("/api/v1/defects/:defectId/fix-request", async (request, reply) => {
    const traceId = createRequestTraceId("quality-fix");
    assertLocalRequest(request, options.testMode, traceId);
    const defectId = pathString(request, "defectId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const fix = options.qualityFlow.submitFixRequest(
      defectId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return { fix, traceId };
  });

  /** NPI 向测试组发起回归请求。 */
  app.post("/api/v1/defects/:defectId/regression-request", async (request, reply) => {
    const traceId = createRequestTraceId("quality-regression-request");
    assertLocalRequest(request, options.testMode, traceId);
    const defectId = pathString(request, "defectId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const regression = options.qualityFlow.requestRegression(
      defectId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return { regression, traceId };
  });

  /** 只有测试角色可提交真实回归结果；passed 才允许关闭缺陷。 */
  app.post("/api/v1/defects/:defectId/regression-result", async (request, reply) => {
    const traceId = createRequestTraceId("quality-regression-result");
    assertLocalRequest(request, options.testMode, traceId);
    const defectId = pathString(request, "defectId", traceId);
    const body = requestBody(request, traceId);
    const actor = actorFromBody(body, traceId);
    const result = options.qualityFlow.recordRegressionResult(
      defectId,
      withRequestMetadata(body, traceId),
      actor.role,
      actor.id,
    );
    reply.code(201);
    return { result, traceId };
  });
}

/** 从统一 body 读取角色；不提供默认特权身份，避免客户端绕过岗位边界。 */
function actorFromBody(
  body: Record<string, unknown>,
  traceId: string,
): { role: string; id: string } {
  const actor = body.actor;
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const value = actor as Record<string, unknown>;
    const role =
      value.role ??
      (value.type === "role" ? value.id : value.type);
    return {
      role: requireSafeString(role, "actor.role", traceId),
      id: requireSafeString(value.id, "actor.id", traceId),
    };
  }
  const role = body.actorRole ?? body.role;
  return {
    role: requireSafeString(role, "actorRole", traceId),
    id: requireSafeString(body.actorId ?? role, "actorId", traceId),
  };
}

/** 让 API 统一补充 trace 和幂等字段，同时保留客户端明确提交的值。 */
function withRequestMetadata(
  body: Record<string, unknown>,
  traceId: string,
): Record<string, unknown> {
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey
      : `${traceId}:request`;
  const { actor: _actor, actorRole: _actorRole, actorId: _actorId, role: _role, ...input } = body;
  return {
    ...input,
    traceId: typeof body.traceId === "string" ? body.traceId : traceId,
    idempotencyKey,
  };
}

/** 读取对象 body 并把 Fastify 的 unknown 输入收敛为领域服务可校验对象。 */
function requestBody(
  request: FastifyRequest,
  traceId: string,
): Record<string, unknown> {
  return requireRecord(request.body, "body", traceId);
}

/** 读取安全路径参数，拒绝跨边界字符进入查询。 */
function pathString(
  request: FastifyRequest,
  name: string,
  traceId: string,
): string {
  const params = request.params as Record<string, unknown>;
  return requireSafeString(params[name], name, traceId);
}

/** 读取 Task 9 任务列表游标，兼容 Task 8 质量规格包装结果。 */
function parseTaskPageQuery(
  request: FastifyRequest,
  traceId: string,
): { cursor: string | null; limit: number } {
  const search = new URL(request.raw.url ?? "/", "http://localhost")
    .searchParams;
  const allowed = new Set(["cursor", "limit"]);
  const unknown = [
    ...new Set([...search.keys()].filter((key) => !allowed.has(key))),
  ];
  if (unknown.length > 0) {
    throw new InvalidArgumentError("存在未声明的任务查询参数", {
      traceId,
      data: { unknown },
    });
  }
  const cursorValues = search.getAll("cursor");
  if (cursorValues.length > 1)
    throw new InvalidArgumentError("cursor 只能出现一次", { traceId });
  const cursor = cursorValues[0]?.trim() || null;
  const rawLimit = search.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new InvalidArgumentError("limit 必须介于 1 和 500 之间", {
      traceId,
    });
  }
  return { cursor, limit };
}
