import type { FastifyInstance } from "fastify";
import { assertLocalRequest } from "../security/local-access.js";
import { OrganizationService } from "../application/organization-service.js";
import type {
  Action,
  ExecutionGrant,
  PolicyDecision,
  StructuredPlan,
} from "../policy/types.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireRecord, requireSafeString } from "./request-validation.js";

/** 注册 Policy Gate 的动作授权和结构化计划检查接口。 */
export function registerPolicyRoutes(
  app: FastifyInstance,
  options: { testMode: boolean },
): void {
  const service = new OrganizationService(app.runtime.database);

  app.post("/api/v1/policy/authorize-action", async (request, reply) => {
    const traceId = createRequestTraceId("policy");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const roleId = requireSafeString(body.roleId, "roleId", traceId);
    const action = requireRecord(body.action, "action", traceId) as Action;
    const grant = requireRecord(body.grant, "grant", traceId) as ExecutionGrant;

    const decision = await service.authorizeAction(roleId, action, grant);
    await auditPolicyDecision(app, decision);
    reply.code(decision.decision === "allow" ? 200 : 403);
    return decision;
  });

  app.post("/api/v1/policy/evaluate-plan", async (request, reply) => {
    const traceId = createRequestTraceId("policy-plan");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const roleId = requireSafeString(body.roleId, "roleId", traceId);
    const task = requireRecord(body.task, "task", traceId) as {
      id: string;
      projectId: string;
      ownerRole: string;
      version: number;
    };
    const plan = requireRecord(body.plan, "plan", traceId) as StructuredPlan;
    const grant = requireRecord(body.grant, "grant", traceId) as ExecutionGrant;

    const decision = await service.evaluatePlan(roleId, task, plan, grant);
    await auditPolicyDecision(app, decision);
    reply.code(decision.decision === "allow" ? 200 : 403);
    return decision;
  });
}

/** 将所有非允许策略结果记录为脱敏安全事件。 */
async function auditPolicyDecision(
  app: FastifyInstance,
  decision: Pick<
    PolicyDecision,
    "decision" | "traceId" | "roleId" | "policyVersion" | "reason"
  >,
): Promise<void> {
  if (decision.decision === "allow") {
    return;
  }

  await app.runtime.audit.write({
    traceId: decision.traceId,
    eventType: "SecurityPolicyDenied",
    result: "blocked",
    metadata: {
      roleId: decision.roleId,
      policyVersion: decision.policyVersion,
      reason: decision.reason,
    },
  });
}
