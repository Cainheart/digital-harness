import { describe, expect, it } from "vitest";
import { Database } from "../../src/infra/database.js";
import { PersistenceRoot } from "../../src/infra/persistence-root.js";
import { SUPPORTED_SCHEMA_REVISION } from "../../src/config/schema-revision.js";
import {
  createTestApp,
  makeProject,
  makeTask,
  useTestRoot,
} from "../helpers.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";

describe("Task 1 runtime and SQLite schema", () => {
  it("initializes persistent layout, Task 1/2 tables and WAL", () => {
    const rootPath = useTestRoot();
    const root = new PersistenceRoot(rootPath, {
      appVersion: "0.1.0",
      schemaRevision: SUPPORTED_SCHEMA_REVISION,
    });
    const database = new Database(root.databasePath, {
      persistentRoot: root.root,
    });
    root.initializeDatabase(database);
    expect(root.manifestPath).toContain("manifest.json");
    expect(database.currentRevision()).toBe(SUPPORTED_SCHEMA_REVISION);
    expect(database.journalMode().toLowerCase()).toBe("wal");
    expect(database.tableNames()).toContain("projects");
    expect(database.tableNames()).toContain("domain_events");
    expect(database.checkSchema().writable).toBe(true);
    database.close();
  });

  it("keeps committed project/task data after reopening", () => {
    const rootPath = useTestRoot();
    const root = new PersistenceRoot(rootPath, {
      appVersion: "0.1.0",
      schemaRevision: SUPPORTED_SCHEMA_REVISION,
    });
    const first = new Database(root.databasePath, {
      persistentRoot: root.root,
    });
    root.initializeDatabase(first);
    const repository = new ProjectTaskRepository();
    const project = makeProject();
    const task = makeTask(project.id);
    first.transaction((connection) => {
      repository.createProject(connection, project);
      repository.createTask(connection, task);
    });
    first.close();
    const second = new Database(root.databasePath, {
      persistentRoot: root.root,
    });
    expect(repository.getProject(second.connection, project.id).name).toBe(
      project.name,
    );
    expect(repository.getTask(second.connection, task.id).status).toBe(
      "待处理",
    );
    second.close();
  });

  it("exposes all five readiness checks and blocks real execution without side effects", async () => {
    const rootPath = useTestRoot();
    const app = await createTestApp(rootPath);
    const readiness = await app.inject({
      method: "GET",
      url: "/api/v1/readiness",
    });
    const view = readiness.json() as {
      status: string;
      allowedActions: string[];
      checks: Record<
        string,
        { status: string; impact?: string; nextAction?: string }
      >;
    };
    expect(readiness.statusCode).toBe(200);
    expect(Object.keys(view.checks).sort()).toEqual([
      "docker",
      "model",
      "persistence",
      "research",
      "workspace",
    ]);
    expect(view.status).toBe("blocked");
    expect(view.allowedActions).toEqual([]);
    expect(view.checks.model.status).toBe("blocked");
    expect(view.checks.docker.status).toBe("blocked");
    expect(view.checks.research.status).toBe("blocked");
    for (const name of ["model", "docker", "research"])
      expect(
        view.checks[name]?.impact && view.checks[name]?.nextAction,
      ).toBeTruthy();
    const executionEventsBefore = app.runtime.database.executionEventCount();
    const error =
      await app.runtime.startupGate.tryAssertReady("tr_startup_guard");
    expect(error?.code).toBe("WORKFLOW_GUARD_BLOCKED");
    expect(app.runtime.database.executionEventCount()).toBe(
      executionEventsBefore,
    );
    await app.close();
  });

  it("returns blocked readiness, refuses non-loopback requests and audits the denial", async () => {
    const rootPath = useTestRoot();
    const app = await createTestApp(rootPath);
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/readiness",
      headers: { "x-test-remote-address": "192.0.2.10" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("POLICY_DENIED");
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_events WHERE event_type='SecurityAccessDenied'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    await app.close();
  });
});
