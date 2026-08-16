import type { FastifyInstance, FastifyRequest } from "fastify";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireSafeString } from "./request-validation.js";
import type { ExecutionQueryService } from "../application/execution-query-service.js";

/** 注册调用控制台的脱敏模型调用查询和领域/模型成本聚合接口。 */
export function registerExecutionRoutes(
  app: FastifyInstance,
  options: { testMode: boolean; queries?: ExecutionQueryService },
): void {
  app.get("/api/v1/executions", async (request) => {
    const traceId = createRequestTraceId("executions");
    assertLocalRequest(request, options.testMode, traceId);
    return app.runtime.modelCallRecorder.list(parseQuery(request, traceId));
  });

  app.get("/api/v1/executions/runs", async (request) => {
    const traceId = createRequestTraceId("execution-runs");
    assertLocalRequest(request, options.testMode, traceId);
    if (!options.queries) throw new InvalidArgumentError("执行查询服务未初始化", { traceId });
    return options.queries.list(parseRunQuery(request, traceId));
  });

  app.get("/api/v1/executions/:executionId", async (request) => {
    const traceId = createRequestTraceId("execution-detail");
    assertLocalRequest(request, options.testMode, traceId);
    if (!options.queries) throw new InvalidArgumentError("执行查询服务未初始化", { traceId });
    const params = request.params as { executionId?: string };
    return options.queries.get(
      requireSafeString(params.executionId ?? "", "executionId", traceId),
      queryValue(request, "projectId", traceId),
    );
  });

  app.get("/api/v1/executions/:executionId/timeline", async (request) => {
    const traceId = createRequestTraceId("execution-timeline");
    assertLocalRequest(request, options.testMode, traceId);
    if (!options.queries) throw new InvalidArgumentError("执行查询服务未初始化", { traceId });
    const params = request.params as { executionId?: string };
    return {
      items: options.queries.timeline(
        requireSafeString(params.executionId ?? "", "executionId", traceId),
      ),
    };
  });

  app.get("/api/v1/executions/:executionId/artifacts", async (request) => {
    const traceId = createRequestTraceId("execution-artifacts");
    assertLocalRequest(request, options.testMode, traceId);
    if (!options.queries) throw new InvalidArgumentError("执行查询服务未初始化", { traceId });
    const params = request.params as { executionId?: string };
    return {
      items: options.queries.listArtifacts(
        requireSafeString(params.executionId ?? "", "executionId", traceId),
        queryValue(request, "projectId", traceId),
      ),
    };
  });
}

/** 解析调用控制台过滤器并限制单次查询的资源消耗。 */
function parseQuery(
  request: FastifyRequest,
  traceId: string,
): {
  projectId: string | null;
  taskId: string | null;
  traceId: string | null;
  domain: string | null;
  model: string | null;
  limit: number;
} {
  const params = new URL(request.raw.url ?? "/", "http://localhost").searchParams;
  const allowed = new Set(["projectId", "taskId", "traceId", "domain", "model", "limit"]);
  const unknown = [...new Set([...params.keys()].filter((key) => !allowed.has(key)))];
  if (unknown.length > 0) {
    throw new InvalidArgumentError("unsupported execution query parameter", {
      traceId,
      data: { parameters: unknown },
    });
  }
  const value = (name: string): string | null => {
    const values = params.getAll(name);
    if (values.length > 1) {
      throw new InvalidArgumentError(`query parameter ${name} must appear once`, {
        traceId,
      });
    }
    const normalized = values[0]?.trim() ?? "";
    if (values.length === 1 && !normalized) {
      throw new InvalidArgumentError(`query parameter ${name} must not be empty`, {
        traceId,
      });
    }
    return normalized || null;
  };
  const limitValue = value("limit");
  const limit = limitValue === null ? 500 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new InvalidArgumentError("limit must be between 1 and 500", {
      traceId,
    });
  }
  return {
    projectId: optionalSafeQuery(value("projectId"), "projectId", traceId),
    taskId: optionalSafeQuery(value("taskId"), "taskId", traceId),
    traceId: optionalSafeQuery(value("traceId"), "traceId", traceId),
    domain: optionalSafeQuery(value("domain"), "domain", traceId),
    model: optionalSafeQuery(value("model"), "model", traceId),
    limit,
  };
}

/** 将可选查询值限制在安全标识边界，避免把控制字符带入日志和 SQL 参数。 */
function optionalSafeQuery(
  value: string | null,
  field: string,
  traceId: string,
): string | null {
  return value === null ? null : requireSafeString(value, field, traceId);
}

/** 解析执行尝试分页查询，允许字段固定映射到 ExecutionQueryService。 */
function parseRunQuery(
  request: FastifyRequest,
  traceId: string,
): Parameters<ExecutionQueryService["list"]>[0] {
  const params = new URL(request.raw.url ?? "/", "http://localhost").searchParams;
  const allowed = new Set([
    "projectId",
    "taskId",
    "workerId",
    "status",
    "from",
    "to",
    "traceId",
    "page",
    "pageSize",
  ]);
  const unknown = [...new Set([...params.keys()].filter((key) => !allowed.has(key)))];
  if (unknown.length > 0) {
    throw new InvalidArgumentError("存在未声明的执行查询参数", {
      traceId,
      data: { unknown },
    });
  }
  const page = integerQuery(params.get("page"), "page", traceId, 1, 10_000);
  const pageSize = integerQuery(params.get("pageSize"), "pageSize", traceId, 1, 100);
  return {
    projectId: optionalSafeQueryValue(params.get("projectId"), "projectId", traceId),
    taskId: optionalSafeQueryValue(params.get("taskId"), "taskId", traceId),
    workerId: optionalSafeQueryValue(params.get("workerId"), "workerId", traceId),
    status: optionalSafeQueryValue(params.get("status"), "status", traceId),
    from: optionalSafeQueryValue(params.get("from"), "from", traceId),
    to: optionalSafeQueryValue(params.get("to"), "to", traceId),
    traceId: optionalSafeQueryValue(params.get("traceId"), "traceId", traceId),
    page,
    pageSize,
  };
}

/** 解析单个执行详情的项目过滤器，空值保持未过滤。 */
function queryValue(
  request: FastifyRequest,
  name: string,
  traceId: string,
): string | null {
  const values = new URL(request.raw.url ?? "/", "http://localhost").searchParams.getAll(name);
  if (values.length > 1) throw new InvalidArgumentError(`${name} 只能出现一次`, { traceId });
  return optionalSafeQueryValue(values[0] ?? null, name, traceId);
}

function optionalSafeQueryValue(value: string | null, field: string, traceId: string): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? requireSafeString(normalized, field, traceId) : null;
}

function integerQuery(
  value: string | null,
  field: string,
  traceId: string,
  minimum: number,
  maximum: number,
): number {
  const number = value === null ? minimum : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new InvalidArgumentError(`${field} 必须介于 ${minimum} 和 ${maximum} 之间`, { traceId });
  }
  return number;
}
