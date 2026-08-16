import type { FastifyInstance, FastifyRequest } from "fastify";
import { InvalidArgumentError } from "../domain/errors.js";
import type { DomainEvent } from "../domain/events.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import { assertLocalRequest } from "../security/local-access.js";
import { normalizeUtc } from "../domain/common.js";
import { createRequestTraceId } from "./request-trace.js";

/** 事件查询允许的参数；未声明参数不能悄悄改变扫描范围或过滤语义。 */
const ALLOWED_PARAMETERS = new Set([
  "after",
  "projectId",
  "taskId",
  "artifactId",
  "traceId",
  "actor",
  "from",
  "to",
  "limit",
]);

/** 单次 SSE 查询的最大返回数，保护本地控制面内存和响应时间。 */
const MAX_PAGE_LIMIT = 500;

/** 过滤器允许扫描的事件窗口，超过窗口时要求调用方缩小查询范围。 */
const MAX_FILTER_SCAN = 10_000;

/** 注册只读领域事件 SSE；只发布已经提交到 EventStore 的不可变快照。 */
export function registerEventRoutes(
  app: FastifyInstance,
  options: { store: SqliteEventStore; testMode: boolean },
): void {
  app.get("/api/v1/events", async (request, reply) => {
    const traceId = createRequestTraceId("events");
    assertLocalRequest(request, options.testMode, traceId);
    const query = parseQuery(request, traceId);
    const events = options.store
      .listAfter(
        app.runtime.database.connection,
        query.after,
        query.projectId,
        MAX_FILTER_SCAN + 1,
      )
      .filter((event) => matches(event, query));

    if (events.length > MAX_FILTER_SCAN) {
      throw new InvalidArgumentError(
        "event filter scan exceeds the supported window",
        {
          traceId,
          data: { maxScan: MAX_FILTER_SCAN },
        },
      );
    }

    const selected = events.slice(0, query.limit);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (selected.length === 0) {
      reply.raw.write(": no committed events\n\n");
    }

    for (const event of selected) {
      reply.raw.write(`id: ${event.eventId}\n`);
      reply.raw.write("event: domain_event\n");
      reply.raw.write(`data: ${serializeEvent(event)}\n\n`);
    }

    reply.raw.end();
    return reply;
  });
}

/** 事件过滤参数的规范化内部形状。 */
type EventQuery = {
  after: string | null;
  projectId: string | null;
  taskId: string | null;
  artifactId: string | null;
  traceId: string | null;
  actor: string | null;
  from: Date | null;
  to: Date | null;
  limit: number;
};

/** 解析事件查询并确保游标、时间范围和扫描上限可解释。 */
function parseQuery(request: FastifyRequest, traceId: string): EventQuery {
  const url = new URL(request.raw.url ?? "/", "http://localhost");
  const unknownParameters = [
    ...new Set(
      [...url.searchParams.keys()].filter(
        (key) => !ALLOWED_PARAMETERS.has(key),
      ),
    ),
  ];

  if (unknownParameters.length > 0) {
    throw new InvalidArgumentError("unsupported event query parameter", {
      traceId,
      data: { parameters: unknownParameters },
    });
  }

  const value = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) {
      throw new InvalidArgumentError(
        `query parameter ${name} must appear at most once`,
        {
          traceId,
          data: { parameter: name },
        },
      );
    }

    const item = values[0]?.trim();
    if (values.length === 1 && !item) {
      throw new InvalidArgumentError(
        `query parameter ${name} must not be empty`,
        {
          traceId,
          data: { parameter: name },
        },
      );
    }

    return item ?? null;
  };

  const after = value("after");
  const header = request.headers["last-event-id"];
  if (Array.isArray(header)) {
    throw new InvalidArgumentError("Last-Event-ID must appear at most once", {
      traceId,
    });
  }

  const lastEventId = typeof header === "string" ? header.trim() : null;
  if (header !== undefined && !lastEventId) {
    throw new InvalidArgumentError("Last-Event-ID must not be empty", {
      traceId,
    });
  }

  if (after && lastEventId && after !== lastEventId) {
    throw new InvalidArgumentError(
      "after and Last-Event-ID must identify the same cursor",
      { traceId },
    );
  }

  const from = parseDate(value("from"), "from", traceId);
  const to = parseDate(value("to"), "to", traceId);
  if (from && to && from > to) {
    throw new InvalidArgumentError("from must not be later than to", {
      traceId,
      data: { parameter: "from", relatedParameter: "to" },
    });
  }

  const rawLimit = value("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new InvalidArgumentError(
      `limit must be between 1 and ${MAX_PAGE_LIMIT}`,
      {
        traceId,
        data: { parameter: "limit", max: MAX_PAGE_LIMIT },
      },
    );
  }

  return {
    after: after ?? lastEventId,
    projectId: value("projectId"),
    taskId: value("taskId"),
    artifactId: value("artifactId"),
    traceId: value("traceId"),
    actor: value("actor"),
    from,
    to,
    limit,
  };
}

/** 解析带时区的时间过滤值，拒绝按本地时区产生歧义的输入。 */
function parseDate(
  value: string | null,
  parameter: string,
  traceId: string,
): Date | null {
  if (!value) {
    return null;
  }

  try {
    return new Date(normalizeUtc(value));
  } catch (_error) {
    throw new InvalidArgumentError(
      `query parameter ${parameter} must be an ISO-8601 datetime with timezone`,
      {
        traceId,
        data: { parameter },
      },
    );
  }
}

/** 应用任务、Artifact、trace、操作者和时间条件，不改变事件正文。 */
function matches(event: DomainEvent, query: EventQuery): boolean {
  if (query.taskId && !matchesTask(event, query.taskId)) {
    return false;
  }

  if (query.artifactId && !matchesArtifact(event, query.artifactId)) {
    return false;
  }

  if (query.traceId && event.traceId !== query.traceId) {
    return false;
  }

  if (query.actor && !matchesActor(event, query.actor)) {
    return false;
  }

  const occurredAt = Date.parse(event.occurredAt);
  if (query.from && occurredAt < query.from.valueOf()) {
    return false;
  }

  if (query.to && occurredAt > query.to.valueOf()) {
    return false;
  }

  return true;
}

/** 判断任务过滤器是否命中聚合端点或事件 payload 引用。 */
function matchesTask(event: DomainEvent, taskId: string): boolean {
  return (
    (event.aggregateType === "task" && event.aggregateId === taskId) ||
    event.payload.taskId === taskId ||
    event.payload.task_id === taskId
  );
}

/** 判断 Artifact 过滤器是否命中交付物聚合或事件 payload 引用。 */
function matchesArtifact(event: DomainEvent, artifactId: string): boolean {
  const aggregateMatches =
    (event.aggregateType === "artifact" ||
      event.aggregateType === "artifact_version") &&
    event.aggregateId === artifactId;

  return (
    aggregateMatches ||
    event.payload.artifactId === artifactId ||
    event.payload.artifact_id === artifactId
  );
}

/** 支持 type、type:id 和 id 三种安全的操作者过滤方式。 */
function matchesActor(event: DomainEvent, actor: string): boolean {
  if (actor.includes(":")) {
    return `${event.actor.type}:${event.actor.id}` === actor;
  }

  return event.actor.type === actor || event.actor.id === actor;
}

/** 将已校验的事件序列化为 SSE data 行。 */
function serializeEvent(event: DomainEvent): string {
  return JSON.stringify(event);
}
