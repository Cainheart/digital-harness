import type BetterSqlite3 from "better-sqlite3";
import { INITIAL_ORGANIZATION } from "../domain/organization/definitions.js";

/** 与 PRD/概要设计冻结的项目状态值。 */
export const PROJECT_STATUSES = [
  "准备中",
  "运行中",
  "等待 Boss",
  "已暂停",
  "已阻塞",
  "结项中",
  "已结项",
  "已终止",
] as const;
/** 与 PRD/概要设计冻结的任务状态值。 */
export const TASK_STATUSES = [
  "待处理",
  "进行中",
  "等待 Review",
  "等待审批",
  "阻塞",
  "返工",
  "已完成",
  "已终止",
] as const;
/** 与 PRD 冻结的优先级值。 */
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
/** 已冻结的业务事实表顺序，迁移和 Schema readiness 共用。 */
export const DOMAIN_TABLE_ORDER = [
  "projects",
  "tasks",
  "task_dependencies",
  "artifacts",
  "artifact_versions",
  "approvals",
  "reviews",
  "test_cases",
  "test_runs",
  "defects",
  "execution_attempts",
  "model_calls",
  "tool_calls",
  "domain_events",
  "notifications",
  "outbox_messages",
  "idempotency_records",
  "trace_links",
  "project_deletion_audits",
] as const;
/** 运行骨架需要存在的基础表集合。 */
export const RUNTIME_TABLES = [
  "credential_configs",
  "runtime_events",
  "runtime_state",
  "worker_leases",
] as const;
/** 业务事实表的快速存在性查询集合。 */
export const DOMAIN_TABLES = new Set<string>(DOMAIN_TABLE_ORDER);
/** 组织、结构化消息和策略审计表；后续流程只通过这些稳定对象消费权限。 */
export const ORGANIZATION_TABLE_ORDER = [
  "organization_domains",
  "role_definitions",
  "organization_members",
  "structured_messages",
  "policy_decisions",
] as const;
/** 用于启动完整性检查的组织表集合。 */
export const ORGANIZATION_TABLES = new Set<string>(ORGANIZATION_TABLE_ORDER);
/** 组织、消息和策略审计依赖的复合查询索引。 */
export const ORGANIZATION_INDEX_DEFINITIONS = [
  [
    "structured_messages",
    "ix_structured_messages_project_task",
    "project_id,task_id",
  ],
  [
    "policy_decisions",
    "ix_policy_decisions_project_task",
    "project_id,task_id",
  ],
  ["organization_members", "ix_organization_members_role", "role_id"],
] as const;
/** 需要 project_id 索引和删除边界的业务表集合。 */
export const PROJECT_SCOPED_TABLES = [
  "tasks",
  "task_dependencies",
  "artifacts",
  "artifact_versions",
  "approvals",
  "reviews",
  "test_cases",
  "test_runs",
  "defects",
  "execution_attempts",
  "model_calls",
  "tool_calls",
  "notifications",
  "domain_events",
  "outbox_messages",
  "idempotency_records",
  "trace_links",
] as const;
/** 为项目范围表生成固定的 project_id 索引名，供 migration 和完整性检查共用。 */
export const PROJECT_ID_INDEX_NAMES = Object.fromEntries(
  [...PROJECT_SCOPED_TABLES, "project_deletion_audits"].map((name) => [
    name,
    `ix_${name}_project_id`,
  ]),
) as Record<string, string>;

/** 为不可变事件和 ArtifactVersion 完整性状态生成单一来源的 SQLite trigger SQL。 */
export function renderImmutableTrigger(
  name: string,
  table: "domain_events" | "artifact_versions",
  action: "UPDATE" | "DELETE",
): string {
  if (table === "artifact_versions" && action === "UPDATE") {
    const immutableColumns = [
      "id",
      "artifact_id",
      "project_id",
      "task_id",
      "version_number",
      "parent_version_id",
      "change_reason",
      "store_ref",
      "sha256",
      "media_type",
      "size_bytes",
      "relative_path",
      "created_at",
      "created_by",
    ];
    const changed = immutableColumns
      .map((column) => `NEW.${column} IS NOT OLD.${column}`)
      .join(" OR ");
    return [
      `CREATE TRIGGER ${name}`,
      "BEFORE UPDATE ON artifact_versions",
      "WHEN task2_purge_guard(OLD.project_id) = 0",
      "AND NOT (NEW.integrity_status IS NOT OLD.integrity_status",
      `AND NOT (${changed}))`,
      "BEGIN SELECT RAISE(ABORT, 'artifact_versions are immutable'); END;",
    ].join(" ");
  }
  return [
    `CREATE TRIGGER ${name}`,
    `BEFORE ${action} ON ${table}`,
    `BEGIN SELECT CASE WHEN task2_purge_guard(OLD.project_id) = 0 THEN RAISE(ABORT, '${table} are immutable') END; END;`,
  ].join(" ");
}
/** 为 TraceLink 生成项目范围和多态端点检查 trigger。 */
export function renderTraceLinkTrigger(
  name: string,
  action: "INSERT" | "UPDATE",
): string {
  const entityChecks = [
    "WHEN NEW.source_type = 'project' AND NEW.source_id != NEW.project_id THEN RAISE(ABORT, 'trace_links source project mismatch')",
    "WHEN NEW.target_type = 'project' AND NEW.target_id != NEW.project_id THEN RAISE(ABORT, 'trace_links target project mismatch')",
    ...(
      [
        "task",
        "artifact",
        "artifact_version",
        "approval",
        "review",
        "test_case",
        "test_run",
        "defect",
        "execution_attempt",
        "model_call",
        "tool_call",
        "notification",
        "domain_event",
      ] as const
    ).flatMap((type) => [
      renderTraceEndpointCheck(type, "source"),
      renderTraceEndpointCheck(type, "target"),
    ]),
  ];
  const allowed = [
    "requirement",
    "acceptance_criterion",
    "project",
    "task",
    "artifact",
    "artifact_version",
    "approval",
    "review",
    "test_case",
    "test_run",
    "defect",
    "execution_attempt",
    "model_call",
    "tool_call",
    "notification",
    "domain_event",
    "evidence",
  ]
    .map((value) => `'${value}'`)
    .join(",");
  const sourceChecks = entityChecks.join(" ");
  const targetChecks = entityChecks
    .map((condition) => condition.replaceAll("source", "target"))
    .join(" ");
  return [
    `CREATE TRIGGER ${name}`,
    `BEFORE ${action} ON trace_links`,
    "BEGIN",
    `SELECT CASE ${sourceChecks} WHEN NEW.source_type NOT IN (${allowed}) THEN RAISE(ABORT, 'trace_links source type unsupported') END;`,
    `SELECT CASE ${targetChecks} WHEN NEW.target_type NOT IN (${allowed}) THEN RAISE(ABORT, 'trace_links target type unsupported') END;`,
    "END;",
  ].join(" ");
}

/** 生成一个 TraceLink 端点的项目范围存在性检查。 */
function renderTraceEndpointCheck(
  type: string,
  endpoint: "source" | "target",
): string {
  const idColumn = type === "domain_event" ? "event_id" : "id";
  const table = typeTable(type);
  const endpointId = `NEW.${endpoint}_id`;
  return `WHEN NEW.${endpoint}_type = '${type}' AND NOT EXISTS (SELECT 1 FROM ${table} WHERE project_id = NEW.project_id AND ${idColumn} = ${endpointId}) THEN RAISE(ABORT, 'trace_links ${endpoint} ${type} mismatch')`;
}

function typeTable(type: string): string {
  return type === "artifact"
    ? "artifacts"
    : type === "artifact_version"
      ? "artifact_versions"
      : type === "test_case"
        ? "test_cases"
        : type === "test_run"
          ? "test_runs"
          : type === "execution_attempt"
            ? "execution_attempts"
            : type === "model_call"
              ? "model_calls"
              : type === "tool_call"
                ? "tool_calls"
                : type === "notification"
                  ? "notifications"
                  : type === "domain_event"
                    ? "domain_events"
                    : `${type}s`;
}

/**
 * 修改日期：2026-08-16
 * 修改原因：迁移实现已切换到 TypeScript/Drizzle 迁移日志，不能继续使用旧迁移工具的兼容表名。
 * 创建 Task 1 运行骨架和迁移版本表。
 */
export function migrateRuntimeSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drizzle_migrations (version_num TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_state (id INTEGER PRIMARY KEY, status TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_events (id INTEGER PRIMARY KEY, event_type TEXT NOT NULL, trace_id TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_leases (worker_id TEXT PRIMARY KEY, heartbeat_at TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credential_configs (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, secret_ref TEXT NOT NULL, config_version TEXT NOT NULL, connection_status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const current = db
    .prepare("SELECT version_num FROM drizzle_migrations LIMIT 1")
    .get() as { version_num: string } | undefined;
  if (!current)
    db.prepare("INSERT INTO drizzle_migrations (version_num) VALUES (?)").run(
      "0001_runtime_skeleton",
    );
}

/** 创建领域表、约束、索引和不可变/项目隔离 trigger。 */
export function migrateDomainSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, business_goal TEXT NOT NULL, target_users TEXT NOT NULL,
      priority TEXT NOT NULL CONSTRAINT ck_projects_priority CHECK (priority IN ('P0','P1','P2','P3')),
      deadline TEXT, constraints_json TEXT NOT NULL CONSTRAINT ck_projects_constraints_json CHECK (json_valid(constraints_json) = 1),
      stage TEXT NOT NULL, status TEXT NOT NULL CONSTRAINT ck_projects_status CHECK (status IN ('准备中','运行中','等待 Boss','已暂停','已阻塞','结项中','已结项','已终止')),
      created_at TEXT NOT NULL, ended_at TEXT, version INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_projects_version_nonnegative CHECK (version >= 0), read_only INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, owner_role TEXT NOT NULL,
      specialist_tag TEXT NOT NULL, assignment_reason TEXT NOT NULL, priority TEXT NOT NULL CONSTRAINT ck_tasks_priority CHECK (priority IN ('P0','P1','P2','P3')),
      dependencies_json TEXT NOT NULL CONSTRAINT ck_tasks_dependencies_json CHECK (json_valid(dependencies_json) = 1), expected_deliverables_json TEXT NOT NULL CONSTRAINT ck_tasks_expected_deliverables_json CHECK (json_valid(expected_deliverables_json) = 1),
      status TEXT NOT NULL CONSTRAINT ck_tasks_status CHECK (status IN ('待处理','进行中','等待 Review','等待审批','阻塞','返工','已完成','已终止')), started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_tasks_version_nonnegative CHECK (version >= 0), UNIQUE(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS task_dependencies (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, depends_on_task_id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,depends_on_task_id) REFERENCES tasks(project_id,id));
    CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, name TEXT NOT NULL, artifact_type TEXT NOT NULL, owner_role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id));
    CREATE TABLE IF NOT EXISTS artifact_versions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, version_number INTEGER NOT NULL CONSTRAINT ck_artifact_versions_version_nonnegative CHECK (version_number >= 0), parent_version_id TEXT, change_reason TEXT NOT NULL, store_ref TEXT NOT NULL, sha256 TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CONSTRAINT ck_artifact_versions_size_nonnegative CHECK (size_bytes >= 0), relative_path TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, integrity_status TEXT NOT NULL DEFAULT 'unknown' CONSTRAINT ck_artifact_versions_integrity_status CHECK (integrity_status IN ('unknown','verified','invalid')), UNIQUE(project_id,id), UNIQUE(artifact_id,version_number), FOREIGN KEY(project_id,artifact_id) REFERENCES artifacts(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,parent_version_id) REFERENCES artifact_versions(project_id,id));
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, approval_type TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, artifact_version_id TEXT, evidence_version_id TEXT, decision TEXT, direction TEXT, boss_id TEXT NOT NULL, status TEXT NOT NULL, response_task_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, version INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_approvals_version_nonnegative CHECK (version >= 0), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,artifact_version_id) REFERENCES artifact_versions(project_id,id), FOREIGN KEY(project_id,evidence_version_id) REFERENCES artifact_versions(project_id,id), FOREIGN KEY(project_id,response_task_id) REFERENCES tasks(project_id,id));
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, artifact_version_id TEXT NOT NULL, reviewer_role TEXT NOT NULL, reviewer_id TEXT NOT NULL, decision TEXT NOT NULL, comments TEXT NOT NULL, evidence_version_id TEXT, rework_task_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, version INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_reviews_version_nonnegative CHECK (version >= 0), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,artifact_version_id) REFERENCES artifact_versions(project_id,id), FOREIGN KEY(project_id,evidence_version_id) REFERENCES artifact_versions(project_id,id), FOREIGN KEY(project_id,rework_task_id) REFERENCES tasks(project_id,id));
    CREATE TABLE IF NOT EXISTS test_cases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, acceptance_criteria_json TEXT NOT NULL CONSTRAINT ck_test_cases_acceptance_criteria_json CHECK (json_valid(acceptance_criteria_json) = 1), preconditions TEXT NOT NULL, steps TEXT NOT NULL, expected_result TEXT NOT NULL, test_type TEXT NOT NULL, owner_role TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_test_cases_version_nonnegative CHECK (version >= 0), UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id));
    CREATE TABLE IF NOT EXISTS test_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, test_case_id TEXT NOT NULL, baseline_version_id TEXT, command_or_steps TEXT NOT NULL, environment_json TEXT NOT NULL CONSTRAINT ck_test_runs_environment_json CHECK (json_valid(environment_json) = 1), started_at TEXT NOT NULL, ended_at TEXT, actual_result TEXT NOT NULL, exit_code INTEGER, status TEXT NOT NULL, evidence_version_id TEXT, trace_id TEXT NOT NULL, UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,test_case_id) REFERENCES test_cases(project_id,id), FOREIGN KEY(project_id,baseline_version_id) REFERENCES artifact_versions(project_id,id), FOREIGN KEY(project_id,evidence_version_id) REFERENCES artifact_versions(project_id,id));
    CREATE TABLE IF NOT EXISTS defects (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, source_test_run_id TEXT NOT NULL, reproduction TEXT NOT NULL, severity TEXT NOT NULL, actual_result TEXT NOT NULL, expected_result TEXT NOT NULL, evidence_version_id TEXT, npi_owner_role TEXT NOT NULL, status TEXT NOT NULL, fixed_version_id TEXT, regression_test_run_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT, version INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_defects_version_nonnegative CHECK (version >= 0), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,source_test_run_id) REFERENCES test_runs(project_id,id), FOREIGN KEY(project_id,evidence_version_id) REFERENCES artifact_versions(project_id,id), FOREIGN KEY(project_id,fixed_version_id) REFERENCES artifact_versions(project_id,id), FOREIGN KEY(project_id,regression_test_run_id) REFERENCES test_runs(project_id,id));
    CREATE TABLE IF NOT EXISTS execution_attempts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, role TEXT NOT NULL, model_config_version TEXT NOT NULL, workspace_ref TEXT, worker_lease_id TEXT REFERENCES worker_leases(worker_id), status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, retry_of_attempt_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_execution_attempts_retry_nonnegative CHECK (retry_count >= 0), trace_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_execution_attempts_version_nonnegative CHECK (version >= 0), UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,retry_of_attempt_id) REFERENCES execution_attempts(project_id,id));
    CREATE TABLE IF NOT EXISTS model_calls (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, execution_attempt_id TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, summary TEXT NOT NULL, error_code TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_micros INTEGER, trace_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,execution_attempt_id) REFERENCES execution_attempts(project_id,id));
    CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, execution_attempt_id TEXT NOT NULL, role TEXT NOT NULL, tool_name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, summary TEXT NOT NULL, error_code TEXT, trace_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,execution_attempt_id) REFERENCES execution_attempts(project_id,id));
    CREATE TABLE IF NOT EXISTS domain_events (event_id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL CONSTRAINT ck_domain_events_aggregate_version_nonnegative CHECK (aggregate_version >= 0), global_sequence INTEGER NOT NULL CONSTRAINT ck_domain_events_global_sequence_nonnegative CHECK (global_sequence >= 0), occurred_at TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_domain_events_duration_nonnegative CHECK (duration_ms >= 0), actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, input_summary TEXT NOT NULL, output_summary TEXT NOT NULL, result TEXT NOT NULL, failure TEXT, retry_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_domain_events_retry_nonnegative CHECK (retry_count >= 0), trace_id TEXT NOT NULL, attempt_id TEXT, rejection_reason TEXT, redaction_reason TEXT, event_category TEXT NOT NULL DEFAULT 'ordinary' CONSTRAINT ck_domain_events_event_category CHECK (event_category IN ('ordinary','call','security')), payload_json TEXT NOT NULL CONSTRAINT ck_domain_events_payload_json CHECK (json_valid(payload_json) = 1), UNIQUE(aggregate_type,aggregate_id,aggregate_version), UNIQUE(project_id,event_id), UNIQUE(global_sequence));
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), event_id TEXT NOT NULL, notification_type TEXT NOT NULL, severity TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 1, pending INTEGER NOT NULL DEFAULT 1, handled_by TEXT, action TEXT, created_at TEXT NOT NULL, read_at TEXT, handled_at TEXT, FOREIGN KEY(project_id,event_id) REFERENCES domain_events(project_id,event_id));
    CREATE TABLE IF NOT EXISTS outbox_messages (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), event_id TEXT NOT NULL, topic TEXT NOT NULL, payload_json TEXT NOT NULL CONSTRAINT ck_outbox_messages_payload_json CHECK (json_valid(payload_json) = 1), created_at TEXT NOT NULL, published_at TEXT, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_outbox_messages_retry_nonnegative CHECK (retry_count >= 0), last_error TEXT, available_at TEXT, UNIQUE(event_id), FOREIGN KEY(project_id,event_id) REFERENCES domain_events(project_id,event_id));
    CREATE TABLE IF NOT EXISTS idempotency_records (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), idempotency_key TEXT NOT NULL UNIQUE, command_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL CONSTRAINT ck_idempotency_records_response_json CHECK (json_valid(response_json) = 1), event_id TEXT, created_at TEXT NOT NULL, FOREIGN KEY(project_id,event_id) REFERENCES domain_events(project_id,event_id));
    CREATE TABLE IF NOT EXISTS trace_links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), source_type TEXT NOT NULL, source_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_type,source_id,target_type,target_id,relation));
    CREATE TABLE IF NOT EXISTS project_deletion_audits (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, deleted_at TEXT NOT NULL, actor_id TEXT NOT NULL);
  `);
  for (const table of [...PROJECT_SCOPED_TABLES, "project_deletion_audits"])
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${PROJECT_ID_INDEX_NAMES[table]} ON ${table}(project_id)`,
    );
  const triggers = [
    renderImmutableTrigger(
      "trg_domain_events_immutable_update",
      "domain_events",
      "UPDATE",
    ),
    renderImmutableTrigger(
      "trg_domain_events_immutable_delete",
      "domain_events",
      "DELETE",
    ),
    renderImmutableTrigger(
      "trg_artifact_versions_immutable_update",
      "artifact_versions",
      "UPDATE",
    ),
    renderImmutableTrigger(
      "trg_artifact_versions_immutable_delete",
      "artifact_versions",
      "DELETE",
    ),
    renderTraceLinkTrigger("trg_trace_links_project_scope_insert", "INSERT"),
    renderTraceLinkTrigger("trg_trace_links_project_scope_update", "UPDATE"),
  ];
  for (const trigger of triggers) db.exec(trigger);
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0002_task2_domain_foundation",
  );
}

/**
 * 修改日期：2026-08-16
 * 修改原因：补齐 Artifact 完整性状态，并重建包含 artifact/notification 节点的 TraceLink trigger，保持领域契约和数据库约束一致。
 * 执行领域完整性增量 Schema migration。
 */
export function migrateIntegritySchema(db: BetterSqlite3.Database): void {
  const columns = db.prepare("PRAGMA table_info(artifact_versions)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "integrity_status")) {
    db.exec(
      "ALTER TABLE artifact_versions ADD COLUMN integrity_status TEXT NOT NULL DEFAULT 'unknown' CHECK (integrity_status IN ('unknown','verified','invalid'))",
    );
  }
  const eventColumns = db.prepare("PRAGMA table_info(domain_events)").all() as {
    name: string;
  }[];
  for (const definition of [
    "attempt_id TEXT",
    "rejection_reason TEXT",
    "redaction_reason TEXT",
    "event_category TEXT NOT NULL DEFAULT 'ordinary' CHECK (event_category IN ('ordinary','call','security'))",
  ]) {
    const name = definition.split(" ", 1)[0];
    if (!eventColumns.some((column) => column.name === name))
      db.exec(`ALTER TABLE domain_events ADD COLUMN ${definition}`);
  }
  db.exec(
    "DROP TRIGGER IF EXISTS trg_artifact_versions_immutable_update; DROP TRIGGER IF EXISTS trg_trace_links_project_scope_insert; DROP TRIGGER IF EXISTS trg_trace_links_project_scope_update;",
  );
  db.exec(
    renderImmutableTrigger(
      "trg_artifact_versions_immutable_update",
      "artifact_versions",
      "UPDATE",
    ),
  );
  db.exec(
    renderTraceLinkTrigger("trg_trace_links_project_scope_insert", "INSERT"),
  );
  db.exec(
    renderTraceLinkTrigger("trg_trace_links_project_scope_update", "UPDATE"),
  );
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0003_task2_integrity_trace_fix",
  );
}

/**
 * 修改日期：2026-08-16
 * 修改原因：组织、岗位版本、结构化消息和策略判断必须纳入同一持久化边界，避免角色权限只存在内存中而无法审计或恢复。
 * 创建组织与策略的增量 Schema migration。
 */
export function migrateOrganizationSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_domains (
      domain_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, office_zone TEXT NOT NULL, group_name TEXT NOT NULL,
      responsibilities_json TEXT NOT NULL CHECK (json_valid(responsibilities_json) = 1), version INTEGER NOT NULL CHECK (version >= 1), enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS role_definitions (
      role_id TEXT PRIMARY KEY, domain_id TEXT NOT NULL REFERENCES organization_domains(domain_id), title TEXT NOT NULL, objective TEXT NOT NULL,
      responsibilities_json TEXT NOT NULL CHECK (json_valid(responsibilities_json) = 1), inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json) = 1), outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json) = 1),
      allowed_tools_json TEXT NOT NULL CHECK (json_valid(allowed_tools_json) = 1), visible_objects_json TEXT NOT NULL CHECK (json_valid(visible_objects_json) = 1), allowed_objects_json TEXT NOT NULL CHECK (json_valid(allowed_objects_json) = 1), forbidden_actions_json TEXT NOT NULL CHECK (json_valid(forbidden_actions_json) = 1),
      object_actions_json TEXT NOT NULL CHECK (json_valid(object_actions_json) = 1), path_policy_json TEXT NOT NULL CHECK (json_valid(path_policy_json) = 1), command_policy_json TEXT NOT NULL CHECK (json_valid(command_policy_json) = 1), role_version INTEGER NOT NULL CHECK (role_version >= 1), enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_members (
      instance_id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES role_definitions(role_id), display_name TEXT NOT NULL, specialist_tag TEXT NOT NULL, office_zone TEXT NOT NULL, desk_group TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('available','busy','blocked')), role_version INTEGER NOT NULL CHECK (role_version >= 1), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS structured_messages (
      message_id TEXT PRIMARY KEY, sender_role TEXT NOT NULL, sender_instance_id TEXT NOT NULL, receiver_role TEXT NOT NULL, receiver_instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, message_type TEXT NOT NULL CHECK (message_type IN ('task_assignment','feasibility_opinion','approval_direction','review_feedback','defect_handoff','regression_request','risk_escalation','coordination_item')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1), created_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','acknowledged','handled','rejected')), handled_at TEXT, handled_by TEXT,
      source_object_type TEXT, source_object_id TEXT, response_object_type TEXT, response_object_id TEXT, trace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), request_hash TEXT NOT NULL,
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS policy_decisions (
      decision_id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, attempt_id TEXT, role_id TEXT NOT NULL, role_version INTEGER NOT NULL CHECK (role_version >= 1), action_kind TEXT NOT NULL, object_type TEXT, object_id TEXT, tool_name TEXT,
      decision TEXT NOT NULL CHECK (decision IN ('allow','reject','approval_required')), reason TEXT NOT NULL, risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')), trace_id TEXT NOT NULL, action_json TEXT NOT NULL CHECK (json_valid(action_json) = 1), created_at TEXT NOT NULL
    );
  `);
  const attemptColumns = db
    .prepare("PRAGMA table_info(execution_attempts)")
    .all() as { name: string }[];
  if (!attemptColumns.some((column) => column.name === "role_version"))
    db.exec(
      "ALTER TABLE execution_attempts ADD COLUMN role_version INTEGER NOT NULL DEFAULT 1 CHECK (role_version >= 1)",
    );
  if (!attemptColumns.some((column) => column.name === "policy_snapshot_json"))
    db.exec(
      "ALTER TABLE execution_attempts ADD COLUMN policy_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_snapshot_json) = 1)",
    );
  for (const [table, index, columns] of ORGANIZATION_INDEX_DEFINITIONS)
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  seedOrganization(db);
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0004_task3_organization_policy",
  );
}

/** 将版本化初始化组织写入数据库；INSERT OR IGNORE 保留用户后续调整的岗位版本。 */
function seedOrganization(db: BetterSqlite3.Database): void {
  const now = new Date().toISOString();
  const insertDomain = db.prepare(
    "INSERT OR IGNORE INTO organization_domains (domain_id,display_name,office_zone,group_name,responsibilities_json,version,enabled) VALUES (?,?,?,?,?,?,1)",
  );
  for (const domain of INITIAL_ORGANIZATION.domains)
    insertDomain.run(
      domain.domainId,
      domain.displayName,
      domain.officeZone,
      domain.groupName,
      JSON.stringify(domain.responsibilities),
      domain.version,
    );
  const insertRole = db.prepare(
    "INSERT OR IGNORE INTO role_definitions (role_id,domain_id,title,objective,responsibilities_json,inputs_json,outputs_json,allowed_tools_json,visible_objects_json,allowed_objects_json,forbidden_actions_json,object_actions_json,path_policy_json,command_policy_json,role_version,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const role of INITIAL_ORGANIZATION.roles)
    insertRole.run(
      role.roleId,
      role.domain,
      role.title,
      role.objective,
      JSON.stringify(role.responsibilities),
      JSON.stringify(role.inputs),
      JSON.stringify(role.outputs),
      JSON.stringify(role.allowedTools),
      JSON.stringify(role.visibleObjects),
      JSON.stringify(role.allowedObjects),
      JSON.stringify(role.forbiddenActions),
      JSON.stringify(role.objectActions),
      JSON.stringify(role.pathPolicy),
      JSON.stringify(role.commandPolicy),
      role.roleVersion,
      role.enabled ? 1 : 0,
      now,
      now,
    );
  const insertMember = db.prepare(
    "INSERT OR IGNORE INTO organization_members (instance_id,role_id,display_name,specialist_tag,office_zone,desk_group,status,role_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (const member of INITIAL_ORGANIZATION.members)
    insertMember.run(
      member.instanceId,
      member.roleId,
      member.displayName,
      member.specialistTag,
      member.officeZone,
      member.deskGroup,
      member.status,
      member.roleVersion,
      now,
    );
}
