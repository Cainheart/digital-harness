import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BossDirectionService,
  OrganizationService,
} from "../application/organization-service.js";
import { InvalidArgumentError } from "../domain/errors.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import {
  optionalBoolean,
  requireRecord,
  requireSafeString,
  requireString,
} from "./request-validation.js";

/** 注册结构化消息、消息确认和 Boss 方向交接接口。 */
export function registerMessageRoutes(
  app: FastifyInstance,
  options: { testMode: boolean },
): void {
  const service = new OrganizationService(app.runtime.database);
  const directions = new BossDirectionService(app.runtime.database);

  app.post("/api/v1/messages", async (request, reply) => {
    const traceId = createRequestTraceId("message");
    assertLocalRequest(request, options.testMode, traceId);
    const message = service.sendMessage(request.body);
    reply.code(201);
    return message;
  });

  app.get("/api/v1/messages", async (request) => {
    const traceId = createRequestTraceId("messages");
    assertLocalRequest(request, options.testMode, traceId);
    return service.listMessages(parseMessageQuery(request, traceId));
  });

  app.post("/api/v1/messages/:messageId/acknowledge", async (request) => {
    const traceId = createRequestTraceId("message-ack");
    assertLocalRequest(request, options.testMode, traceId);
    const params = request.params as { messageId?: string };
    const messageId = requireSafeString(
      params.messageId?.trim() ?? "",
      "messageId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const handledBy = requireSafeString(body.handledBy, "handledBy", traceId);

    return service.acknowledgeMessage(messageId, handledBy);
  });

  app.post("/api/v1/approvals/:approvalId/direction", async (request) => {
    const traceId = createRequestTraceId("direction");
    assertLocalRequest(request, options.testMode, traceId);
    const params = request.params as { approvalId?: string };
    const approvalId = requireSafeString(
      params.approvalId?.trim() ?? "",
      "approvalId",
      traceId,
    );
    const body = requireRecord(request.body, "body", traceId);
    const assignedLead = requireRecord(
      body.assignedLead,
      "assignedLead",
      traceId,
    );

    return directions.convert({
      approvalId,
      directionOpinion: requireString(
        body.directionOpinion,
        "directionOpinion",
        traceId,
      ),
      assignedLead: {
        roleId: requireString(
          assignedLead.roleId,
          "assignedLead.roleId",
          traceId,
        ),
        instanceId: requireString(
          assignedLead.instanceId,
          "assignedLead.instanceId",
          traceId,
        ),
      },
      responseArtifactRequired: optionalBoolean(
        body.responseArtifactRequired,
        "responseArtifactRequired",
        true,
        traceId,
      ),
    });
  });
}

/** 解析消息列表查询，拒绝未声明过滤器并限制单页资源消耗。 */
function parseMessageQuery(
  request: FastifyRequest,
  traceId: string,
): {
  projectId: string | null;
  taskId: string | null;
  limit: number;
  cursor: string | null;
} {
  const params = new URL(request.raw.url ?? "/", "http://localhost")
    .searchParams;
  const allowedParameters = new Set(["projectId", "taskId", "limit", "cursor"]);
  const unknownParameters = [
    ...new Set([...params.keys()].filter((key) => !allowedParameters.has(key))),
  ];

  if (unknownParameters.length > 0) {
    throw new InvalidArgumentError("unsupported message query parameter", {
      traceId,
      data: { parameters: unknownParameters },
    });
  }

  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new InvalidArgumentError("limit must be between 1 and 500", {
      traceId,
    });
  }

  return {
    projectId: normalizeQueryValue(params.get("projectId")),
    taskId: normalizeQueryValue(params.get("taskId")),
    limit,
    cursor: normalizeQueryValue(params.get("cursor")),
  };
}

/** 将可选查询值规范化为空值，避免空字符串成为隐式过滤条件。 */
function normalizeQueryValue(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
