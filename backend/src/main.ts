import { existsSync } from "node:fs";
import Fastify, { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { RuntimeBoundaryError, errorPayload } from "./api/errors.js";
import { registerEventRoutes } from "./api/events.js";
import { StartupGate } from "./bootstrap/startup-gate.js";
import { Settings } from "./config/settings.js";
import {
  DockerCliRuntime,
  UnavailableContainerRuntime,
} from "./infra/container-runtime.js";
import { Database } from "./infra/database.js";
import {
  SystemCredentialAdapter,
  MemoryCredentialAdapter,
  CredentialAdapter,
} from "./infra/keychain.js";
import { PersistenceRoot } from "./infra/persistence-root.js";
import { ModelReadinessChecker } from "./readiness/checkers/model.js";
import { PersistenceReadinessChecker } from "./readiness/checkers/persistence.js";
import {
  ResearchReadinessChecker,
  LocalBrowserProbe,
  UnavailableResearchProbe,
} from "./readiness/checkers/research.js";
import { ContainerReadinessChecker } from "./readiness/checkers/container.js";
import { WorkspaceReadinessChecker } from "./readiness/checkers/workspace.js";
import { ReadinessService } from "./readiness/service.js";
import { AuditWriter } from "./security/audit.js";
import { assertLocalRequest } from "./security/local-access.js";
import { SqliteEventStore } from "./infra/repositories/events.js";
import { ApplicationRuntime } from "./bootstrap/application.js";
import { ApplicationLifecycle } from "./lifecycle/service.js";
import { WorkerLeaseStore } from "./lifecycle/worker-lease.js";
import { FileArtifactStore } from "./infra/artifacts.js";
import { TraceContext } from "./observability/trace.js";
import { registerOrganizationRoutes } from "./api/organization-routes.js";
import { registerMessageRoutes } from "./api/message-routes.js";
import { registerPolicyRoutes } from "./api/policy-routes.js";
import { createRequestTraceId } from "./api/request-trace.js";
import { DomainError } from "./domain/errors.js";
import { registerWorkflowRoutes } from "./api/workflow-routes.js";
import { registerModelSettingsRoutes } from "./api/model-settings-routes.js";
import { registerExecutionRoutes } from "./api/execution-routes.js";
import { ModelSettingsService } from "./application/model-settings.js";
import {
  DeepSeekAdapter,
  OpenAiAdapter,
} from "./gateway/model/index.js";
import {
  ModelAdapterRegistry,
  ModelGateway,
} from "./gateway/model/gateway.js";
import { SqliteModelCallRecorder } from "./observability/model-call-recorder.js";
import { registerResearchRoutes } from "./api/research.js";
import { ResearchWorkflow } from "./application/research-workflow.js";
import { ResearchAdapter } from "./research/adapter.js";
import {
  PlaywrightResearchBrowser,
  UnavailableResearchBrowser,
  type ResearchBrowser,
} from "./research/browser.js";

declare module "fastify" {
  interface FastifyInstance {
    runtime: RuntimeState;
  }
}
export type RuntimeState = {
  settings: Settings;
  database: Database;
  persistenceRoot: PersistenceRoot;
  credentials: CredentialAdapter;
  readiness: ReadinessService;
  startupGate: StartupGate;
  audit: AuditWriter;
  lifecycle: ApplicationLifecycle;
  leases: WorkerLeaseStore;
  artifactStore: FileArtifactStore;
  traceContextFactory: () => TraceContext;
  modelCallRecorder: SqliteModelCallRecorder;
  modelGateway: ModelGateway;
  modelSettings: ModelSettingsService;
  researchWorkflow: ResearchWorkflow;
  schemaInitializationError: Record<string, unknown> | null;
  testMode: boolean;
};

/** 创建本地 Fastify 控制面，组装持久化、readiness、生命周期和访问边界。 */
export function createApp(options: {
  persistentRoot: string;
  testMode?: boolean;
  initializeRuntime?: boolean;
  researchBrowser?: ResearchBrowser;
}): FastifyInstance {
  const testMode = options.testMode ?? false;
  const initializeRuntime = options.initializeRuntime ?? true;
  const settings = new Settings({ persistentRoot: options.persistentRoot });
  const persistenceRoot = new PersistenceRoot(settings.persistentRoot, {
    appVersion: settings.appVersion,
    schemaRevision: settings.currentSchemaRevision,
  });
  const database = new Database(settings.databasePath, {
    persistentRoot: settings.persistentRoot,
    appVersion: settings.appVersion,
    schemaRevision: settings.currentSchemaRevision,
  });
  let schemaInitializationError: Record<string, unknown> | null = null;
  if (initializeRuntime) {
    try {
      persistenceRoot.initializeDatabase(database);
    } catch (error) {
      schemaInitializationError = initializationPayload(error);
    }
  }
  const credentials = testMode
    ? new MemoryCredentialAdapter()
    : new SystemCredentialAdapter();
  const modelCallRecorder = new SqliteModelCallRecorder(database);
  const modelGateway = new ModelGateway(
    new ModelAdapterRegistry([
      new OpenAiAdapter(credentials),
      new DeepSeekAdapter(credentials),
    ]),
    modelCallRecorder,
  );
  const modelSettings = new ModelSettingsService(
    database,
    credentials,
    modelGateway,
  );
  const secretRef = testMode
    ? "memory://unconfigured"
    : settings.modelSecretRef;
  const readiness = new ReadinessService([
    new ModelReadinessChecker(
      credentials,
      settings.modelProvider,
      settings.modelName,
      secretRef,
      database,
    ),
    new ResearchReadinessChecker(
      testMode
        ? new UnavailableResearchProbe()
        : new LocalBrowserProbe(findBrowserExecutable()),
    ),
    new WorkspaceReadinessChecker(settings.workspacePath),
    new ContainerReadinessChecker(
      testMode ? new UnavailableContainerRuntime() : new DockerCliRuntime(),
    ),
    new PersistenceReadinessChecker(database),
  ]);
  const leases = new WorkerLeaseStore(database);
  const lifecycle = new ApplicationLifecycle(database, leases);
  const artifactStore = new FileArtifactStore(
    settings.artifactPath,
    settings.artifactMaxSizeBytes,
  );
  const researchBrowser =
    options.researchBrowser ??
    (testMode
      ? new UnavailableResearchBrowser()
      : new PlaywrightResearchBrowser({
          executablePath: findBrowserExecutable(),
        }));
  const researchWorkflow = new ResearchWorkflow(
    database,
    artifactStore,
    new ResearchAdapter(database, researchBrowser),
  );
  const runtime: RuntimeState = {
    settings,
    database,
    persistenceRoot,
    credentials,
    readiness,
    startupGate: new StartupGate(readiness, settings.allowRealExecution),
    audit: new AuditWriter(database),
    lifecycle,
    leases,
    artifactStore,
    traceContextFactory: TraceContext.new,
    modelCallRecorder,
    modelGateway,
    modelSettings,
    researchWorkflow,
    schemaInitializationError,
    testMode,
  };
  const app = Fastify({ logger: false });
  app.decorate("runtime", runtime);
  app.setErrorHandler(async (error, request, reply) => {
    const traceId = createRequestTraceId("http");
    if (error instanceof RuntimeBoundaryError) {
      if (error.code === "POLICY_DENIED")
        await runtime.audit.write({
          traceId: error.traceId,
          eventType: "SecurityAccessDenied",
          result: "blocked",
          metadata: { code: error.code, message: error.message },
        });
      return reply.code(error.statusCode).send(errorPayload(error));
    }
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send(errorPayload(error));
    }
    request.log.error({ err: error, traceId }, "request failed");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "请求处理失败",
      impact: "当前操作未完成",
      paused: true,
      dataPreserved: true,
      nextAction: "检查诊断日志后重试",
      traceId,
    });
  });
  app.addHook("onReady", async () => {
    if (!initializeRuntime && !runtime.schemaInitializationError) {
      try {
        persistenceRoot.initializeDatabase(database);
        runtime.schemaInitializationError = null;
      } catch (error) {
        runtime.schemaInitializationError = initializationPayload(error);
      }
    }
    if (!runtime.schemaInitializationError) {
      try {
        runtime.lifecycle.startSync();
      } catch (error) {
        runtime.schemaInitializationError = initializationPayload(error);
      }
    }
  });
  app.addHook("onClose", async () => {
    if (!database.connection.open) return;
    try {
      if (
        !runtime.schemaInitializationError &&
        database.currentRevision() !== null
      )
        runtime.lifecycle.stopSync();
    } finally {
      database.close();
    }
  });
  app.get(
    "/api/v1/readiness",
    { schema: { response: { 200: Type.Any() } } },
    async (request) => {
      const traceId = createRequestTraceId("readiness");
      assertLocalRequest(request, testMode, traceId);
      return runtime.readiness.check(traceId);
    },
  );
  registerEventRoutes(app, { store: new SqliteEventStore(), testMode });
  registerOrganizationRoutes(app, { testMode });
  registerMessageRoutes(app, { testMode });
  registerPolicyRoutes(app, { testMode });
  registerWorkflowRoutes(app, { testMode, researchWorkflow });
  registerModelSettingsRoutes(app, { testMode });
  registerExecutionRoutes(app, { testMode });
  registerResearchRoutes(app, { testMode });
  return app;
}

/** 把启动失败保存为固定可机器解析错误，不暴露底层路径和锁信息。 */
function initializationPayload(error: unknown): Record<string, unknown> {
  if (error instanceof RuntimeBoundaryError) return error.toPayload();
  return {
    code: "SCHEMA_INITIALIZATION_FAILED",
    message: "持久化 Schema 初始化未完成",
    impact: "Schema 初始化未完成，业务写入、真实执行和工作区写入保持阻断",
    paused: true,
    dataPreserved: true,
    nextAction: "检查数据库初始化日志和持久化根目录后重试",
    traceId: `tr_schema_init_${Date.now().toString(36)}`,
  };
}
/** 发现本机浏览器可执行文件，仅供无副作用 readiness 探针使用。 */
function findBrowserExecutable(): string {
  for (const candidate of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ])
    if (existsSync(candidate)) return candidate;
  return "__browser_not_configured__";
}
