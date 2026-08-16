import type { FastifyInstance } from "fastify";
import { ModelSettingsService } from "../application/model-settings.js";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireRecord, requireSafeString } from "./request-validation.js";
import { TraceContext } from "../observability/trace.js";

/** 注册五领域模型配置、连接检测和凭据删除 API；所有响应均为脱敏视图。 */
export function registerModelSettingsRoutes(
  app: FastifyInstance,
  options: { testMode: boolean },
): void {
  const service = app.runtime.modelSettings;

  app.get("/api/v1/settings/models", async (request) => {
    const traceId = createRequestTraceId("model-settings");
    assertLocalRequest(request, options.testMode, traceId);
    return service.list();
  });

  app.put("/api/v1/settings/models/:domain", async (request) => {
    const traceId = createRequestTraceId("model-update");
    assertLocalRequest(request, options.testMode, traceId);
    const params = request.params as { domain?: string };
    const domain = requireSafeString(params.domain?.trim() ?? "", "domain", traceId);
    const body = requireRecord(request.body, "body", traceId);
    return service.update(domain, body, traceId);
  });

  app.post(
    "/api/v1/settings/models/:domain/connection-test",
    async (request, reply) => {
      const traceId = createRequestTraceId("model-connection");
      assertLocalRequest(request, options.testMode, traceId);
      const params = request.params as { domain?: string };
      const domain = requireSafeString(
        params.domain?.trim() ?? "",
        "domain",
        traceId,
      );
      const result = await service.testConnection(
        domain,
        TraceContext.fromTraceId(traceId),
      );
      reply.code(result.connectionStatus === "ready" ? 200 : 503);
      return result;
    },
  );

  app.delete("/api/v1/settings/models/:domain/credential", async (request) => {
    const traceId = createRequestTraceId("model-credential-delete");
    assertLocalRequest(request, options.testMode, traceId);
    const params = request.params as { domain?: string };
    const domain = requireSafeString(params.domain?.trim() ?? "", "domain", traceId);
    const body = request.body === undefined
      ? {}
      : requireRecord(request.body, "body", traceId);
    return service.deleteCredential(domain, {
      expectedConfigVersion: optionalNonNegativeInteger(
        body.expectedConfigVersion,
        traceId,
      ),
      idempotencyKey:
        body.idempotencyKey === undefined
          ? undefined
          : requireSafeString(body.idempotencyKey, "idempotencyKey", traceId),
    }, traceId);
  });
}

/** 解析可选配置版本，字段存在但类型错误时拒绝而不是默认放行。 */
function optionalNonNegativeInteger(
  value: unknown,
  traceId: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new InvalidArgumentError(
      "expectedConfigVersion must be a non-negative integer",
      { traceId },
    );
  }
  return Number(value);
}
