import type { FastifyInstance, FastifyRequest } from "fastify";
import { ArchiveService } from "../application/archive-service.js";
import {
  ArchiveFilters,
  ConsoleQueryService,
} from "../application/console-query-service.js";
import { InvalidArgumentError, PolicyDeniedError } from "../domain/errors.js";
import { normalizeUtc } from "../domain/common.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import {
  requireRecord,
  requireSafeString,
  requireString,
} from "./request-validation.js";

/** 注册 Task 9 的任务、交付物、事件和历史只读查询及删除命令。 */
export function registerConsoleRoutes(
  app: FastifyInstance,
  options: {
    testMode: boolean;
    queries: ConsoleQueryService;
    archive: ArchiveService;
  },
): void {
  app.get("/api/v1/projects/:projectId/tasks/:taskId", async (request) => {
    const traceId = createRequestTraceId("task-detail");
    assertLocalRequest(request, options.testMode, traceId);
    const params = request.params as { projectId?: string; taskId?: string };
    const projectId = requireSafeString(
      params.projectId ?? "",
      "projectId",
      traceId,
    );
    const taskId = requireSafeString(params.taskId ?? "", "taskId", traceId);
    return options.queries.getTask(projectId, taskId);
  });

  app.get("/api/v1/projects/:projectId/artifacts", async (request) => {
    const traceId = createRequestTraceId("project-artifacts");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = projectParam(request, traceId);
    const query = parseLimitQuery(request, traceId, 500);
    return {
      items: options.queries.listArtifacts(projectId, query.limit),
      nextCursor: null,
      hasMore: false,
    };
  });

  app.get(
    "/api/v1/projects/:projectId/artifacts/:artifactId",
    async (request) => {
      const traceId = createRequestTraceId("artifact-detail");
      assertLocalRequest(request, options.testMode, traceId);
      const params = request.params as {
        projectId?: string;
        artifactId?: string;
      };
      const projectId = requireSafeString(
        params.projectId ?? "",
        "projectId",
        traceId,
      );
      const artifactId = requireSafeString(
        params.artifactId ?? "",
        "artifactId",
        traceId,
      );
      return options.queries.getArtifact(projectId, artifactId);
    },
  );

  app.get("/api/v1/projects/:projectId/events", async (request) => {
    const traceId = createRequestTraceId("project-events");
    assertLocalRequest(request, options.testMode, traceId);
    const projectId = projectParam(request, traceId);
    const query = parseEventQuery(request, traceId);
    return options.queries.listEvents(projectId, query.after, query.limit);
  });

  app.get("/api/v1/archive", async (request) => {
    const traceId = createRequestTraceId("archive-list");
    assertLocalRequest(request, options.testMode, traceId);
    return options.queries.listArchive(parseArchiveQuery(request, traceId));
  });

  app.get("/api/v1/archive/:projectId", async (request) => {
    const traceId = createRequestTraceId("archive-detail");
    assertLocalRequest(request, options.testMode, traceId);
    return options.queries.getArchive(projectParam(request, traceId));
  });

  app.post("/api/v1/archive/:projectId/delete/preview", async (request) => {
    const traceId = createRequestTraceId("archive-delete-preview");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    return options.archive.previewDeletion(
      projectParam(request, traceId),
      parseArchiveCommand(body, traceId),
    );
  });

  app.post("/api/v1/archive/:projectId/delete/confirm", async (request) => {
    const traceId = createRequestTraceId("archive-delete-confirm");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    return options.archive.confirmDeletion(
      projectParam(request, traceId),
      parseArchiveDeleteCommand(body, traceId),
    );
  });
}

/** 解析项目事件补齐游标；after 与 Last-Event-ID 由调用方统一传入 after。 */
function parseEventQuery(
  request: FastifyRequest,
  traceId: string,
): { after: string | null; limit: number } {
  const query = parseQuery(request, traceId, ["after", "limit"]);
  return {
    after: query.after ?? null,
    limit: parseLimit(query.limit, traceId, 500),
  };
}

/** 解析历史搜索与固定筛选项，查询条件不会进入 SQL 标识符。 */
function parseArchiveQuery(
  request: FastifyRequest,
  traceId: string,
): ArchiveFilters {
  const query = parseQuery(request, traceId, [
    "search",
    "status",
    "priority",
    "from",
    "to",
    "cursor",
    "limit",
  ]);
  const status = query.status;
  if (status !== null && status !== "已结项" && status !== "已终止") {
    throw new InvalidArgumentError("status 只能是已结项或已终止", { traceId });
  }
  const priority = query.priority;
  if (
    priority !== null &&
    priority !== "P0" &&
    priority !== "P1" &&
    priority !== "P2" &&
    priority !== "P3"
  ) {
    throw new InvalidArgumentError("priority 只能是 P0、P1、P2 或 P3", {
      traceId,
    });
  }
  const from = archiveDate(query.from, "from", traceId);
  const to = archiveDate(query.to, "to", traceId);
  if (from && to && from > to) {
    throw new InvalidArgumentError("from 不能晚于 to", { traceId });
  }
  return {
    search: boundedText(query.search, "search", traceId),
    status: status as ArchiveFilters["status"],
    priority: priority as ArchiveFilters["priority"],
    from,
    to,
    cursor: query.cursor,
    limit: parseLimit(query.limit, traceId, 500),
  };
}

/** 解析删除命令中的 Boss 身份和 expectedVersion。 */
function parseArchiveCommand(
  body: Record<string, unknown>,
  traceId: string,
): { actorId: string; expectedVersion: number; idempotencyKey: string } {
  const actorId = bossActorId(body, traceId);
  const idempotencyKey = requireSafeString(
    body.idempotencyKey,
    "idempotencyKey",
    traceId,
  );
  const expectedVersion = integer(
    body.expectedVersion,
    "expectedVersion",
    traceId,
  );
  return { actorId, expectedVersion, idempotencyKey };
}

/** 解析删除确认 token，并保证二次确认仍绑定同一项目版本和 Boss。 */
function parseArchiveDeleteCommand(
  body: Record<string, unknown>,
  traceId: string,
): {
  actorId: string;
  confirmationToken: string;
  expectedVersion: number;
  idempotencyKey: string;
} {
  const idempotencyKey = requireSafeString(
    body.idempotencyKey,
    "idempotencyKey",
    traceId,
  );
  return {
    actorId: bossActorId(body, traceId),
    confirmationToken: requireString(
      body.confirmationToken,
      "confirmationToken",
      traceId,
    ),
    expectedVersion: integer(body.expectedVersion, "expectedVersion", traceId),
    idempotencyKey,
  };
}

/** 只接受明确的 Boss actor，不允许普通字符串伪造操作者类型。 */
function bossActorId(body: Record<string, unknown>, traceId: string): string {
  const actor = body.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new PolicyDeniedError("历史删除必须由 Boss actor 发起", { traceId });
  }
  const actorRecord = actor as Record<string, unknown>;
  if (actorRecord.type !== "boss") {
    throw new PolicyDeniedError("只有 Boss 可以删除历史项目", { traceId });
  }
  return requireSafeString(actorRecord.id, "actor.id", traceId);
}

/** 解析统一查询参数并拒绝未声明字段。 */
function parseQuery(
  request: FastifyRequest,
  traceId: string,
  allowed: string[],
): Record<string, string | null> {
  const search = new URL(request.raw.url ?? "/", "http://localhost")
    .searchParams;
  const allowedSet = new Set(allowed);
  const unknown = [
    ...new Set([...search.keys()].filter((key) => !allowedSet.has(key))),
  ];
  if (unknown.length > 0) {
    throw new InvalidArgumentError("存在未声明的查询参数", {
      traceId,
      data: { unknown },
    });
  }
  const result: Record<string, string | null> = {};
  for (const key of allowed) {
    const values = search.getAll(key);
    if (values.length > 1) {
      throw new InvalidArgumentError(`${key} 只能出现一次`, { traceId });
    }
    const value = values[0]?.trim() ?? "";
    result[key] = value || null;
  }
  return result;
}

/** 解析并限制分页数字，避免 NaN、负数和超大查询。 */
function parseLimit(
  value: string | null,
  traceId: string,
  maximum: number,
): number {
  const limit = value === null ? 100 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new InvalidArgumentError(`limit 必须介于 1 和 ${maximum} 之间`, {
      traceId,
    });
  }
  return limit;
}

/** 解析通用 limit 查询，保持调用边界清晰。 */
function parseLimitQuery(
  request: FastifyRequest,
  traceId: string,
  maximum: number,
): { limit: number } {
  const query = parseQuery(request, traceId, ["limit"]);
  return { limit: parseLimit(query.limit, traceId, maximum) };
}

/** 校验命令版本为正整数。 */
function integer(value: unknown, field: string, traceId: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new InvalidArgumentError(`${field} 必须是正整数`, { traceId });
  }
  return Number(value);
}

/** 限制搜索和日期过滤字段长度，避免把异常大输入交给查询层。 */
function boundedText(
  value: string | null,
  field: string,
  traceId: string,
): string | undefined {
  if (value === null) return undefined;
  if (value.length > 120) {
    throw new InvalidArgumentError(`${field} 长度不能超过 120`, { traceId });
  }
  return value;
}

/** 归档时间筛选必须带时区，避免 Boss 在本地时区下看到不一致的结果。 */
function archiveDate(
  value: string | null,
  field: string,
  traceId: string,
): string | undefined {
  const bounded = boundedText(value, field, traceId);
  if (bounded === undefined) return undefined;
  try {
    return normalizeUtc(bounded);
  } catch (_error) {
    throw new InvalidArgumentError(`${field} 必须是带时区的 ISO 时间`, {
      traceId,
    });
  }
}

/** 从路由参数读取项目 ID并保持项目接口的统一安全边界。 */
function projectParam(request: FastifyRequest, traceId: string): string {
  return requireSafeString(
    (request.params as { projectId?: string }).projectId ?? "",
    "projectId",
    traceId,
  );
}
