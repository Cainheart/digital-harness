import type { FastifyInstance, FastifyRequest } from "fastify";
import { ResearchWorkflow } from "../application/research-workflow.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireRecord, requireSafeString } from "./request-validation.js";

/** 注册 Task 6 的 Grant、网页来源、结论、指标、PRD 和 PM 评审接口。 */
export function registerResearchRoutes(
  app: FastifyInstance,
  options: { testMode: boolean },
): void {
  const workflow = app.runtime.researchWorkflow;

  app.post("/api/v1/projects/:projectId/research/grants", async (request) => {
    const traceId = createRequestTraceId("research-grant");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = projectParam(request, traceId);
    return workflow.createGrant(
      projectId,
      requireRecord(request.body, "body", traceId),
      traceId,
    );
  });

  app.post("/api/v1/projects/:projectId/research/runs", async (request) => {
    const traceId = createRequestTraceId("research-run");
    assertLocalRequest(request, options.testMode, traceId);
    return workflow.startRun(
      projectParam(request, traceId),
      requireRecord(request.body, "body", traceId),
      traceId,
    );
  });

  app.get("/api/v1/projects/:projectId/research/sources", async (request) => {
    const traceId = createRequestTraceId("research-sources");
    assertLocalRequest(request, options.testMode, traceId);
    const research = workflow.getProjectResearch(
      projectParam(request, traceId),
    );
    return { items: research.sources, traceId };
  });

  app.get("/api/v1/projects/:projectId/research/reports", async (request) => {
    const traceId = createRequestTraceId("research-reports");
    assertLocalRequest(request, options.testMode, traceId);
    const research = workflow.getProjectResearch(
      projectParam(request, traceId),
    );
    return { items: research.reports, traceId };
  });

  app.get("/api/v1/projects/:projectId/research", async (request) => {
    const traceId = createRequestTraceId("research-overview");
    assertLocalRequest(request, options.testMode, traceId);
    return {
      ...workflow.getProjectResearch(projectParam(request, traceId)),
      traceId,
    };
  });

  app.post(
    "/api/v1/projects/:projectId/research/conclusions/validate",
    async (request) => {
      const traceId = createRequestTraceId("research-conclusion");
      assertLocalRequest(request, options.testMode, traceId);
      return workflow.validateConclusion(
        projectParam(request, traceId),
        requireRecord(request.body, "body", traceId),
        traceId,
      );
    },
  );

  app.post("/api/v1/projects/:projectId/research/metrics", async (request) => {
    const traceId = createRequestTraceId("research-metric");
    assertLocalRequest(request, options.testMode, traceId);
    return workflow.createMetric(
      projectParam(request, traceId),
      requireRecord(request.body, "body", traceId),
      traceId,
    );
  });

  app.post(
    "/api/v1/projects/:projectId/research/peer-review",
    async (request) => {
      const traceId = createRequestTraceId("research-peer-review");
      assertLocalRequest(request, options.testMode, traceId);
      return workflow.peerReview(
        projectParam(request, traceId),
        requireRecord(request.body, "body", traceId),
        traceId,
      );
    },
  );

  app.post(
    "/api/v1/projects/:projectId/research/prd-versions",
    async (request) => {
      const traceId = createRequestTraceId("research-prd");
      assertLocalRequest(request, options.testMode, traceId);
      return workflow.createPrd(
        projectParam(request, traceId),
        requireRecord(request.body, "body", traceId),
        traceId,
      );
    },
  );
}

/** 读取路径项目 ID，防止空值或路径分隔符进入应用服务。 */
function projectParam(request: FastifyRequest, traceId: string): string {
  return requireSafeString(
    (request.params as { projectId?: string }).projectId ?? "",
    "projectId",
    traceId,
  );
}
