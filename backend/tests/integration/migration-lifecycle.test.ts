import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../src/infra/database.js";
import {
  migrateDomainSchema,
  migrateRuntimeSchema,
} from "../../src/infra/schema.js";
import { SUPPORTED_SCHEMA_REVISION } from "../../src/config/schema-revision.js";
import { ApplicationLifecycle } from "../../src/lifecycle/service.js";
import { WorkerLeaseStore } from "../../src/lifecycle/worker-lease.js";
import { createTestApp, useTestRoot } from "../helpers.js";

describe("migration, schema guard and lifecycle", () => {
  it("creates a byte-identical verified migration backup before upgrading 0001", () => {
    const root = useTestRoot();
    mkdirSync(join(root, "artifacts"), { recursive: true });
    const first = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    migrateRuntimeSchema(first.connection);
    first.close();
    const original = readFileSync(join(root, "company.db"));
    const second = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    second.initialize();
    expect(second.currentRevision()).toBe(SUPPORTED_SCHEMA_REVISION);
    const backupName = readdirSync(join(root, "backups")).find((name) =>
      name.startsWith("migration-"),
    );
    expect(backupName).toBeDefined();
    expect(
      readFileSync(
        join(root, "backups", backupName as string, "database", "company.db"),
      ),
    ).toEqual(original);
    second.close();
  });

  it("upgrades the previous Task 2 schema and repairs its trigger contract", () => {
    const root = useTestRoot();
    const first = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    migrateRuntimeSchema(first.connection);
    migrateDomainSchema(first.connection);
    first.close();
    const second = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    second.initialize();
    expect(second.currentRevision()).toBe(SUPPORTED_SCHEMA_REVISION);
    expect(
      (
        second.connection
          .prepare("PRAGMA table_info(artifact_versions)")
          .all() as { name: string }[]
      ).some((column) => column.name === "integrity_status"),
    ).toBe(true);
    second.close();
  });

  it("upgrades a Task 4 database with the workflow hardening columns missing", () => {
    const root = useTestRoot();
    const first = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    first.initialize();
    first.connection.exec(
      "ALTER TABLE workflow_leases DROP COLUMN grant_expires_at; ALTER TABLE workflow_risks DROP COLUMN response_task_id; UPDATE drizzle_migrations SET version_num='0005_task4_workflow'",
    );
    first.close();

    const second = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    second.initialize();
    expect(second.currentRevision()).toBe(SUPPORTED_SCHEMA_REVISION);
    expect(
      (
        second.connection
          .prepare("PRAGMA table_info(workflow_leases)")
          .all() as { name: string }[]
      ).some((column) => column.name === "grant_expires_at"),
    ).toBe(true);
    expect(
      (
        second.connection
          .prepare("PRAGMA table_info(workflow_risks)")
          .all() as { name: string }[]
      ).some((column) => column.name === "response_task_id"),
    ).toBe(true);
    second.close();
  });

  it("upgrades a Task 4 hardening database to the Task 5 model gateway schema", () => {
    const root = useTestRoot();
    const first = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    first.initialize();
    first.connection.exec(
      "DROP INDEX ix_model_config_changes_domain_created; DROP INDEX ix_model_calls_domain_model; DROP INDEX ix_model_calls_trace_id; DROP TABLE model_config_changes; DROP TABLE model_configs; UPDATE drizzle_migrations SET version_num='0006_task4_workflow_hardening'",
    );
    first.close();

    const second = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    second.initialize();
    expect(second.currentRevision()).toBe(SUPPORTED_SCHEMA_REVISION);
    expect(
      (
        second.connection
          .prepare("SELECT COUNT(*) AS count FROM model_configs")
          .get() as { count: number }
      ).count,
    ).toBe(5);
    expect(
      (
        second.connection
          .prepare("PRAGMA table_info(model_calls)")
          .all() as { name: string }[]
      ).some((column) => column.name === "redaction_status"),
    ).toBe(true);
    second.close();
  });

  it("blocks a structurally incomplete database without treating it as ready", () => {
    const root = useTestRoot();
    const database = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    database.initialize();
    database.connection.prepare("DROP INDEX ix_tasks_project_id").run();
    const result = database.checkSchema();
    expect(result.writable).toBe(false);
    expect(result.code).toBe("SCHEMA_INTEGRITY_CONFLICT");
    database.close();
  });

  it("blocks a Task 3 database when a message trace index is missing", () => {
    const root = useTestRoot();
    const database = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    database.initialize();
    database.connection
      .prepare("DROP INDEX ix_structured_messages_project_task")
      .run();
    const result = database.checkSchema();
    expect(result.writable).toBe(false);
    expect(result.code).toBe("SCHEMA_INTEGRITY_CONFLICT");
    database.close();
  });

  it("records ApplicationStarted/ApplicationStopped through Fastify lifecycle hooks", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_events WHERE event_type='ApplicationStarted'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    await app.close();
    const reopened = new Database(join(root, "company.db"), {
      persistentRoot: root,
    });
    expect(
      (
        reopened.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_events WHERE event_type='ApplicationStopped'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    reopened.close();
  });

  it("persists lifecycle state and expires worker leases", async () => {
    const root = useTestRoot();
    const app = await createTestApp(root);
    const leases = new WorkerLeaseStore(app.runtime.database, 1);
    const lifecycle = new ApplicationLifecycle(app.runtime.database, leases);
    lifecycle.recordRuntimeStateSync("等待 Boss", "approval required");
    expect(lifecycle.currentStateSync()).toBe("等待 Boss");
    leases.registerSync(
      "worker-old",
      new Date(Date.now() - 5000).toISOString(),
    );
    expect(lifecycle.checkWorkerLeasesSync()[0]?.status).toBe("expired");
    await app.close();
  });
});
