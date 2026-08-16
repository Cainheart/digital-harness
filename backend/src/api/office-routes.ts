import type { FastifyInstance, FastifyRequest } from "fastify";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import type { OfficeProjection } from "../application/office-projection.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireSafeString } from "./request-validation.js";

/** 注册办公室快照和一次性 SSE 事件补齐接口；前端不直接修改任何领域状态。 */
export function registerOfficeRoutes(
  app: FastifyInstance,
  options: { testMode: boolean; projection: OfficeProjection },
): void {
  app.get("/api/v1/projects/:projectId/office", async (request) => {
    const traceId = createRequestTraceId("office-snapshot");
    assertLocalRequest(request, options.testMode, traceId);
    return options.projection.get(projectParam(request, traceId));
  });

  app.get("/api/v1/projects/:projectId/office/events", async (request, reply) => {
    const traceId = createRequestTraceId("office-events");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = projectParam(request, traceId);
    const search = new URL(request.raw.url ?? "/", "http://localhost").searchParams;
    const after = search.get("after") ?? lastEventId(request, traceId);
    const limit = parseLimit(search.get("limit"), traceId);
    const events = options.projection.listEvents(projectId, after, limit);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (events.length === 0) {
      reply.raw.write(": no committed project events\n\n");
    }
    for (const event of events) {
      reply.raw.write(`id: ${String(event.eventId)}\n`);
      reply.raw.write("event: office_event\n");
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    reply.raw.end();
    return reply;
  });
}

/** 读取并校验项目 ID，避免空路径进入查询服务。 */
function projectParam(request: FastifyRequest, traceId: string): string {
  return requireSafeString(
    (request.params as { projectId?: string }).projectId ?? "",
    "projectId",
    traceId,
  );
}

/** Last-Event-ID 只允许单个非空游标，重连时与 after 共享同一语义。 */
function lastEventId(request: FastifyRequest, traceId: string): string | null {
  const value = request.headers["last-event-id"];
  if (Array.isArray(value) || (value !== undefined && !value.trim())) {
    throw new InvalidArgumentError("Last-Event-ID 必须是单个非空游标", { traceId });
  }
  return typeof value === "string" ? value : null;
}

/** 限制办公室事件补齐数量，防止重连一次读取无界历史。 */
function parseLimit(value: string | null, traceId: string): number {
  const limit = value === null ? 100 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new InvalidArgumentError("limit 必须介于 1 和 500 之间", { traceId });
  }
  return limit;
}
