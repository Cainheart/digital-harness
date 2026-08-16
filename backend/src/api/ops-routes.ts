import type { FastifyInstance, FastifyRequest } from "fastify";
import { PolicyDeniedError } from "../domain/errors.js";
import type { BackupService } from "../ops/backup.js";
import type { RestoreService } from "../ops/restore.js";
import { assertLocalRequest } from "../security/local-access.js";
import { createRequestTraceId } from "./request-trace.js";
import { requireRecord, requireSafeString } from "./request-validation.js";

/** 注册仅本机运维接口；不提供普通产品页面的任意导入/导出入口。 */
export function registerOpsRoutes(
  app: FastifyInstance,
  options: { testMode: boolean; backup: BackupService; restore: RestoreService },
): void {
  app.post("/internal/ops/backups", async (request) => {
    const traceId = createRequestTraceId("ops-backup-create");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    assertOpsActor(body.actor);
    const output = requireSafeString(body.outputPath, "outputPath", traceId);
    const projects = Array.isArray(body.projectIds)
      ? body.projectIds.map((value) => requireSafeString(value, "projectIds", traceId))
      : undefined;
    return options.backup.create(output, projects);
  });

  app.get("/internal/ops/backups/verify", async (request) => {
    const traceId = createRequestTraceId("ops-backup-verify");
    assertLocalRequest(request, options.testMode, traceId);
    assertOpsActor(request.headers["x-ops-actor"]);
    const path = new URL(request.raw.url ?? "/", "http://localhost").searchParams.get("input");
    return options.backup.verify(requireSafeString(path, "input", traceId));
  });

  app.post("/internal/ops/restores/validate", async (request) => {
    const traceId = createRequestTraceId("ops-restore-validate");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    assertOpsActor(body.actor);
    return options.restore.validate(
      requireSafeString(body.inputPath, "inputPath", traceId),
      requireSafeString(body.targetRoot, "targetRoot", traceId),
    );
  });

  app.post("/internal/ops/restores", async (request) => {
    const traceId = createRequestTraceId("ops-restore-apply");
    assertLocalRequest(request, options.testMode, traceId);
    const body = requireRecord(request.body, "body", traceId);
    assertOpsActor(body.actor);
    return options.restore.apply(
      requireSafeString(body.inputPath, "inputPath", traceId),
      requireSafeString(body.targetRoot, "targetRoot", traceId),
      requireSafeString(body.changeTicket, "changeTicket", traceId),
    );
  });
}

/** 内部运维操作仍需明确 actor，不允许普通请求默认放行。 */
function assertOpsActor(value: unknown): void {
  if (value === "system" || value === "boss") return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyDeniedError("运维操作必须由 Boss 或 system actor 发起");
  }
  const actor = value as Record<string, unknown>;
  if (actor.type !== "boss" && actor.type !== "system") {
    throw new PolicyDeniedError("运维操作 actor 不被允许");
  }
}
