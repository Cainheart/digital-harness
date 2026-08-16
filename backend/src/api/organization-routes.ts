import type { FastifyInstance } from "fastify";
import { OrganizationService } from "../application/organization-service.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireSafeString } from "./request-validation.js";

/** 注册组织、岗位和办公室展示投影查询接口。 */
export function registerOrganizationRoutes(
  app: FastifyInstance,
  options: { testMode: boolean },
): void {
  const service = new OrganizationService(app.runtime.database);

  app.get("/api/v1/organization", async (request) => {
    const traceId = createRequestTraceId("organization");
    assertLocalRequest(request, options.testMode, traceId);
    return service.getOrganization();
  });

  app.get("/api/v1/roles", async (request) => {
    const traceId = createRequestTraceId("roles");
    assertLocalRequest(request, options.testMode, traceId);
    return {
      roles: service.listRoles(),
      version: 1,
    };
  });

  app.get("/api/v1/roles/:roleId", async (request) => {
    const traceId = createRequestTraceId("role");
    assertLocalRequest(request, options.testMode, traceId);
    const params = request.params as { roleId?: string };
    const roleId = requireSafeString(
      params.roleId?.trim() ?? "",
      "roleId",
      traceId,
    );

    return service.getRole(roleId);
  });

  app.get("/api/v1/organization/office-view", async (request) => {
    const traceId = createRequestTraceId("office");
    assertLocalRequest(request, options.testMode, traceId);
    return service.getOfficeView();
  });
}
