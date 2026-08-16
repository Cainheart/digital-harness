import { Settings } from "../config/settings.js";
import { FileArtifactStore } from "../infra/artifacts.js";
import { Database } from "../infra/database.js";
import { PersistenceRoot } from "../infra/persistence-root.js";
import { ApplicationLifecycle } from "../lifecycle/service.js";
import { WorkerLeaseStore } from "../lifecycle/worker-lease.js";
import { TraceContext } from "../observability/trace.js";

/** 汇总后续业务任务消费的基础运行时组件。 */
export type ApplicationRuntime = {
  settings: Settings;
  database: Database;
  lifecycle: ApplicationLifecycle;
  leases: WorkerLeaseStore;
  artifactStore: FileArtifactStore;
  traceContextFactory: () => TraceContext;
};
/** 初始化持久化根目录并构造数据库、生命周期和证据存储组件。 */
export function buildRuntime(
  persistentRoot: string,
  options: { testMode?: boolean } = {},
): ApplicationRuntime {
  const settings = new Settings({ persistentRoot });
  const root = new PersistenceRoot(settings.persistentRoot, {
    appVersion: settings.appVersion,
    schemaRevision: settings.currentSchemaRevision,
  });
  const database = new Database(settings.databasePath, {
    persistentRoot: settings.persistentRoot,
    appVersion: settings.appVersion,
    schemaRevision: settings.currentSchemaRevision,
  });
  root.initializeDatabase(database);
  const leases = new WorkerLeaseStore(database);
  return {
    settings,
    database,
    lifecycle: new ApplicationLifecycle(database, leases),
    leases,
    artifactStore: new FileArtifactStore(
      settings.artifactPath,
      settings.artifactMaxSizeBytes,
    ),
    traceContextFactory: TraceContext.new,
  };
}
