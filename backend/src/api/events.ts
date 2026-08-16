import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvalidArgumentError } from "../domain/errors.js";
import { DomainEvent } from "../domain/events.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import { assertLocalRequest } from "../security/local-access.js";
import { randomUUID } from "node:crypto";

const ALLOWED_PARAMETERS = new Set(["after", "projectId", "taskId", "artifactId", "traceId", "actor", "from", "to", "limit"]);
const MAX_PAGE_LIMIT = 500;
const MAX_FILTER_SCAN = 10_000;

/** 注册只读领域事件 SSE；仅发布已经提交到 EventStore 的快照。 */
export function registerEventRoutes(app: FastifyInstance, options: { store: SqliteEventStore; testMode: boolean }): void {
  app.get("/api/v1/events", async (request, reply) => {
    const traceId = `tr_events_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    assertLocalRequest(request, options.testMode, traceId);
    const query = parseQuery(request, traceId);
    const events = options.store.listAfter(app.runtime.database.connection, query.after, query.projectId, MAX_FILTER_SCAN + 1).filter((event) => matches(event, query));
    if (events.length > MAX_FILTER_SCAN) throw new InvalidArgumentError("event filter scan exceeds the supported window", { traceId, data: { maxScan: MAX_FILTER_SCAN } });
    const selected = events.slice(0, query.limit);
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    if (selected.length === 0) reply.raw.write(": no committed events\n\n");
    for (const event of selected) { reply.raw.write(`id: ${event.eventId}\n`); reply.raw.write("event: domain_event\n"); reply.raw.write(`data: ${serializeEvent(event)}\n\n`); }
    reply.raw.end();
    return reply;
  });
}

type EventQuery = { after: string | null; projectId: string | null; taskId: string | null; artifactId: string | null; traceId: string | null; actor: string | null; from: Date | null; to: Date | null; limit: number };
function parseQuery(request: FastifyRequest, traceId: string): EventQuery { const raw = request.raw.url?.split("?")[1] ?? ""; const params = new URLSearchParams(raw); const unknown = [...new Set([...params.keys()].filter((key) => !ALLOWED_PARAMETERS.has(key)))]; if (unknown.length) throw new InvalidArgumentError("unsupported event query parameter", { traceId, data: { parameters: unknown } }); const value = (name: string): string | null => { const values = params.getAll(name); if (values.length > 1) throw new InvalidArgumentError(`query parameter ${name} must appear at most once`, { traceId, data: { parameter: name } }); const item = values[0]?.trim(); if (values.length === 1 && !item) throw new InvalidArgumentError(`query parameter ${name} must not be empty`, { traceId, data: { parameter: name } }); return item ?? null; }; const after = value("after"); const last = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"].trim() : null; if (last !== null && !last) throw new InvalidArgumentError("Last-Event-ID must not be empty", { traceId }); if (after && last && after !== last) throw new InvalidArgumentError("after and Last-Event-ID must identify the same cursor", { traceId }); const from = parseDate(value("from"), "from", traceId); const to = parseDate(value("to"), "to", traceId); if (from && to && from > to) throw new InvalidArgumentError("from must not be later than to", { traceId, data: { parameter: "from", relatedParameter: "to" } }); const rawLimit = value("limit"); const limit = rawLimit === null ? 100 : Number(rawLimit); if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new InvalidArgumentError(`limit must be between 1 and ${MAX_PAGE_LIMIT}`, { traceId, data: { parameter: "limit", max: MAX_PAGE_LIMIT } }); return { after: after ?? last, projectId: value("projectId"), taskId: value("taskId"), artifactId: value("artifactId"), traceId: value("traceId"), actor: value("actor"), from, to, limit }; }
function parseDate(value: string | null, parameter: string, traceId: string): Date | null { if (!value) return null; const date = new Date(value); if (Number.isNaN(date.valueOf()) || !/[zZ]|[+-]\d\d:\d\d$/.test(value)) throw new InvalidArgumentError(`query parameter ${parameter} must be an ISO-8601 datetime with timezone`, { traceId, data: { parameter } }); return date; }
function matches(event: DomainEvent, query: EventQuery): boolean { const payload = event.payload; if (query.taskId && !((event.aggregateType === "task" && event.aggregateId === query.taskId) || payload.taskId === query.taskId || payload.task_id === query.taskId)) return false; if (query.artifactId && !((event.aggregateType === "artifact" || event.aggregateType === "artifact_version") && event.aggregateId === query.artifactId) && payload.artifactId !== query.artifactId && payload.artifact_id !== query.artifactId) return false; if (query.traceId && event.traceId !== query.traceId) return false; if (query.actor) { const actor = query.actor.includes(":") ? `${event.actor.type}:${event.actor.id}` : event.actor.type === query.actor || event.actor.id === query.actor ? query.actor : ""; if (actor !== query.actor) return false; } const occurred = Date.parse(event.occurredAt); if (query.from && occurred < query.from.valueOf()) return false; if (query.to && occurred > query.to.valueOf()) return false; return true; }
function serializeEvent(event: DomainEvent): string { return JSON.stringify(event); }
