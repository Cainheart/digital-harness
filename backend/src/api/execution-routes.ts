import type { FastifyInstance, FastifyRequest } from "fastify";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireSafeString } from "./request-validation.js";

/** 注册调用控制台的脱敏模型调用查询和领域/模型成本聚合接口。 */
export function registerExecutionRoutes(
  app: FastifyInstance,
  options: { testMode: boolean },
): void {
  app.get("/api/v1/executions", async (request) => {
    const traceId = createRequestTraceId("executions");
    assertLocalRequest(request, options.testMode, traceId);
    return app.runtime.modelCallRecorder.list(parseQuery(request, traceId));
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
