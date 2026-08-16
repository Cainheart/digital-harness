import type { FastifyInstance, FastifyRequest } from "fastify";
import { PolicyDeniedError } from "../domain/errors.js";
import type { ScorecardService } from "../application/scorecard-service.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireRecord, requireSafeString } from "./request-validation.js";

/** 注册评分卡查询、重算和证据接口；总分和门槛均由后端规则引擎产生。 */
export function registerScorecardRoutes(
  app: FastifyInstance,
  options: { testMode: boolean; scorecard: ScorecardService },
): void {
  app.get("/api/v1/projects/:projectId/scorecard", async (request) => {
    const traceId = createRequestTraceId("scorecard-get");
    assertLocalRequest(request, options.testMode, traceId);
    return options.scorecard.get(projectParam(request, traceId));
  });

  app.get("/api/v1/projects/:projectId/scorecard/evidence", async (request) => {
    const traceId = createRequestTraceId("scorecard-evidence");
    assertLocalRequest(request, options.testMode, traceId);
    return options.scorecard.listEvidence(projectParam(request, traceId));
  });

  app.get("/api/v1/projects/:projectId/scorecard/history", async (request) => {
    const traceId = createRequestTraceId("scorecard-history");
    assertLocalRequest(request, options.testMode, traceId);
    const limit = Number(
      new URL(request.raw.url ?? "/", "http://localhost").searchParams.get("limit") ?? "50",
    );
    return {
      items: options.scorecard.listHistory(projectParam(request, traceId), limit),
    };
  });

  app.post("/api/v1/projects/:projectId/scorecard/recalculate", async (request) => {
    const traceId = createRequestTraceId("scorecard-recalculate");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const actor = parseActor(body.actor);
    return options.scorecard.recalculate(projectParam(request, traceId), actor);
  });
}

/** 评分卡重算允许 Boss 或内部 system 评估角色，其他身份默认拒绝。 */
function parseActor(value: unknown): { type: string; id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyDeniedError("评分卡重算必须携带 Boss 或 system actor");
  }
  const actor = value as Record<string, unknown>;
  if (actor.type !== "boss" && actor.type !== "system") {
    throw new PolicyDeniedError("只有 Boss 或 system 评估角色可以重算评分卡");
  }
  if (typeof actor.id !== "string" || !actor.id.trim()) {
    throw new PolicyDeniedError("评分卡 actor.id 不能为空");
  }
  return { type: actor.type, id: actor.id };
}

/** 读取并校验项目 ID。 */
function projectParam(request: FastifyRequest, traceId: string): string {
  return requireSafeString(
    (request.params as { projectId?: string }).projectId ?? "",
    "projectId",
    traceId,
  );
}
