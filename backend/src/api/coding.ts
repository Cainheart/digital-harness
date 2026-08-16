import type { FastifyInstance } from "fastify";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireRecord, requireSafeString } from "./request-validation.js";
import { NativeCodingHarness } from "../coding/native-harness.js";

/** 注册编码会话、动作、暂停恢复、验证和人工 Review API。 */
export function registerCodingRoutes(
  app: FastifyInstance,
  options: { testMode: boolean; harness: NativeCodingHarness },
): void {
  app.post("/api/v1/coding-sessions", async (request, reply) => {
    const traceId = createRequestTraceId("coding-start");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    const spec = body.spec;
    const grant = body.grant;
    if (!spec || !grant)
      throw new InvalidArgumentError("spec 和 grant 都是必需字段", { traceId });
    const session = await options.harness.start(spec, grant);
    reply.code(202);
    return {
      sessionId: session.id,
      attemptId: session.attemptId,
      status: session.status,
      leaseExpiresAt: session.grant.expiresAt,
      eventStream: `/api/v1/coding-sessions/${session.id}/events`,
      traceId,
    };
  });

  app.get("/api/v1/coding-sessions/:sessionId", async (request) => {
    const traceId = createRequestTraceId("coding-session");
    assertLocalRequest(request, options.testMode, traceId);
    const sessionId = requireSafeString(
      (request.params as { sessionId?: unknown }).sessionId,
      "sessionId",
      traceId,
    );
    return options.harness.result(sessionId);
  });

  app.get("/api/v1/coding-sessions/:sessionId/events", async (request) => {
    const traceId = createRequestTraceId("coding-events");
    assertLocalRequest(request, options.testMode, traceId);
    const sessionId = requireSafeString(
      (request.params as { sessionId?: unknown }).sessionId,
      "sessionId",
      traceId,
    );
    const events = [];
    for await (const event of options.harness.stream(sessionId))
      events.push(event);
    return { sessionId, events, traceId };
  });

  app.post("/api/v1/coding-sessions/:sessionId/pause", async (request) => {
    const traceId = createRequestTraceId("coding-pause");
    assertLocalRequest(request, options.testMode, traceId);
    const sessionId = requireSafeString(
      (request.params as { sessionId?: unknown }).sessionId,
      "sessionId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const reason = requireSafeString(body.reason, "reason", traceId);
    return options.harness.pause(sessionId, reason);
  });

  app.post("/api/v1/coding-sessions/:sessionId/resume", async (request) => {
    const traceId = createRequestTraceId("coding-resume");
    assertLocalRequest(request, options.testMode, traceId);
    const sessionId = requireSafeString(
      (request.params as { sessionId?: unknown }).sessionId,
      "sessionId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const checkpointId = requireSafeString(
      body.checkpointId,
      "checkpointId",
      traceId,
    );
    return options.harness.resume(sessionId, checkpointId);
  });

  app.post("/api/v1/coding-sessions/:sessionId/cancel", async (request) => {
    const traceId = createRequestTraceId("coding-cancel");
    assertLocalRequest(request, options.testMode, traceId);
    const sessionId = requireSafeString(
      (request.params as { sessionId?: unknown }).sessionId,
      "sessionId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const reason = requireSafeString(body.reason, "reason", traceId);
    return options.harness.cancel(sessionId, reason);
  });

  app.post(
    "/api/v1/coding-sessions/:sessionId/actions/apply-patch",
    async (request) => {
      const traceId = createRequestTraceId("coding-patch");
      assertLocalRequest(request, options.testMode, traceId);
      const sessionId = requireSafeString(
        (request.params as { sessionId?: unknown }).sessionId,
        "sessionId",
        traceId,
      );
      const observation = await options.harness.applyPatch(
        sessionId,
        request.body,
      );
      return observation;
    },
  );

  app.post("/api/v1/coding-sessions/:sessionId/verify", async (request) => {
    const traceId = createRequestTraceId("coding-verify");
    assertLocalRequest(request, options.testMode, traceId);
    const sessionId = requireSafeString(
      (request.params as { sessionId?: unknown }).sessionId,
      "sessionId",
      traceId,
    );
    return options.harness.runVerification(sessionId);
  });

  app.get("/api/v1/coding-sessions/:sessionId/handoff", async (request) => {
    const traceId = createRequestTraceId("coding-handoff");
    assertLocalRequest(request, options.testMode, traceId);
    const sessionId = requireSafeString(
      (request.params as { sessionId?: unknown }).sessionId,
      "sessionId",
      traceId,
    );
    return options.harness.requestHandoff(sessionId);
  });

  app.post("/api/v1/handoffs/:handoffId/review", async (request) => {
    const traceId = createRequestTraceId("coding-review");
    assertLocalRequest(request, options.testMode, traceId);
    const handoffId = requireSafeString(
      (request.params as { handoffId?: unknown }).handoffId,
      "handoffId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const sessionId = requireSafeString(body.sessionId, "sessionId", traceId);
    const reviewerRole = requireSafeString(
      body.reviewerRole,
      "reviewerRole",
      traceId,
    );
    const decision = requireSafeString(body.decision, "decision", traceId);
    if (!["approved", "changes_requested", "blocked"].includes(decision))
      throw new InvalidArgumentError("Review decision 无效", { traceId });
    const comments = typeof body.comments === "string" ? body.comments : "";
    const handoff = options.harness.result(sessionId).handoff;
    if (!handoff || handoff.handoffId !== handoffId)
      throw new InvalidArgumentError("handoffId 与 sessionId 不匹配", {
        traceId,
      });
    return options.harness.reviewHandoff(
      sessionId,
      reviewerRole,
      decision as "approved" | "changes_requested" | "blocked",
      comments,
    );
  });
}
