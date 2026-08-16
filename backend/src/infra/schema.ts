import type BetterSqlite3 from "better-sqlite3";
import {
  INITIAL_ORGANIZATION,
  ORGANIZATION_DOMAIN_IDS,
} from "../domain/organization/definitions.js";

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
  "workflow_pauses",
  "workflow_leases",
  "workflow_risks",
  "workflow_checkpoints",
  "termination_confirmations",
] as const;
/** 运行骨架需要存在的基础表集合。 */
export const RUNTIME_TABLES = [
  "credential_configs",
  "runtime_events",
  "runtime_state",
  "worker_leases",
] as const;
/** Task 5 模型配置和配置变更审计表。 */
export const MODEL_GATEWAY_TABLES = [
  "model_configs",
  "model_config_changes",
] as const;
/** Task 5 模型调用字段和查询索引的固定合同。 */
export const MODEL_GATEWAY_INDEX_DEFINITIONS = [
  [
    "model_config_changes",
    "ix_model_config_changes_domain_created",
    "domain,created_at",
  ],
  ["model_calls", "ix_model_calls_domain_model", "domain,model"],
  ["model_calls", "ix_model_calls_trace_id", "trace_id"],
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
/** Task 4 工作流事实表；状态恢复、租约和风险不能只保存在内存。 */
export const WORKFLOW_TABLE_ORDER = [
  "workflow_pauses",
  "workflow_leases",
  "workflow_risks",
  "workflow_checkpoints",
  "termination_confirmations",
  "archive_deletion_confirmations",
] as const;
/** 用于启动完整性检查的工作流表集合。 */
export const WORKFLOW_TABLES = new Set<string>(WORKFLOW_TABLE_ORDER);
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
/** 工作流查询和并发领取使用的固定索引。 */
export const WORKFLOW_INDEX_DEFINITIONS = [
  ["workflow_pauses", "ix_workflow_pauses_project", "project_id,created_at"],
  ["workflow_leases", "ix_workflow_leases_task_status", "task_id,status"],
  ["workflow_risks", "ix_workflow_risks_project_status", "project_id,status"],
  [
    "workflow_checkpoints",
    "ix_workflow_checkpoints_attempt_created",
    "attempt_id,created_at",
  ],
  [
    "termination_confirmations",
    "ix_termination_confirmations_project_status",
    "project_id,status",
  ],
] as const;
/** Task 9 历史删除确认的项目/状态查询索引。 */
export const ARCHIVE_INDEX_DEFINITIONS = [
  [
    "archive_deletion_confirmations",
    "ix_archive_deletion_confirmations_project_status",
    "project_id,status",
  ],
] as const;
/** 工作流并发领取必须存在的部分唯一索引；它禁止同一任务出现两个 active lease。 */
export const WORKFLOW_REQUIRED_INDEX_NAMES = [
  "ux_workflow_leases_active_task",
] as const;
/** Task 6 调研、来源、结论、指标和双 PM 评审事实表。 */
export const RESEARCH_TABLE_ORDER = [
  "research_grants",
  "research_runs",
  "research_sources",
  "research_reports",
  "research_conclusions",
  "research_source_validations",
  "research_conflicts",
  "product_success_metrics",
  "prd_versions",
  "pm_peer_reviews",
  "research_security_events",
] as const;
/** 用于启动完整性检查的 Task 6 表集合。 */
export const RESEARCH_TABLES = new Set<string>(RESEARCH_TABLE_ORDER);
/** Task 7 编码会话、动作、观察、验证和交接事实表。 */
export const CODING_TABLE_ORDER = [
  "coding_sessions",
  "coding_actions",
  "coding_observations",
  "coding_checkpoints",
  "coding_verification_runs",
  "coding_handoffs",
] as const;
/** 用于启动完整性检查的 Task 7 表集合。 */
export const CODING_TABLES = new Set<string>(CODING_TABLE_ORDER);
/** Task 8 质量闭环的任务规格、Review、测试策略、NPI 和回归事实表。 */
export const QUALITY_TABLE_ORDER = [
  "task_quality_specs",
  "test_strategies",
  "quality_reviews",
  "npi_analyses",
  "defect_fix_requests",
  "regression_requests",
  "regression_results",
  "quality_idempotency",
] as const;
/** 用于启动完整性检查的 Task 8 表集合。 */
export const QUALITY_TABLES = new Set<string>(QUALITY_TABLE_ORDER);
/** Task 10 评分卡历史快照；原始证据仍由上游事实表保存。 */
export const SCORECARD_TABLE_ORDER = ["scorecard_snapshots"] as const;
/** 用于启动完整性检查的 Task 10 评估表集合。 */
export const SCORECARD_TABLES = new Set<string>(SCORECARD_TABLE_ORDER);
/** Task 7 按 Attempt、会话和项目查询证据的固定索引。 */
export const CODING_INDEX_DEFINITIONS = [
  [
    "coding_sessions",
    "ix_coding_sessions_project_updated",
    "project_id,updated_at",
  ],
  ["coding_sessions", "ix_coding_sessions_attempt", "attempt_id"],
  ["coding_actions", "ix_coding_actions_session_seq", "session_id,seq"],
  [
    "coding_observations",
    "ix_coding_observations_session_created",
    "session_id,created_at",
  ],
  [
    "coding_checkpoints",
    "ix_coding_checkpoints_session_created",
    "session_id,created_at",
  ],
  [
    "coding_verification_runs",
    "ix_coding_verification_session_created",
    "session_id,created_at",
  ],
  ["coding_handoffs", "ix_coding_handoffs_session", "session_id"],
] as const;
/** Task 8 按项目、任务、策略、缺陷和幂等键查询的固定索引。 */
export const QUALITY_INDEX_DEFINITIONS = [
  ["task_quality_specs", "ix_task_quality_specs_project_task", "project_id,task_id"],
  ["test_strategies", "ix_test_strategies_project_created", "project_id,created_at"],
  ["quality_reviews", "ix_quality_reviews_project_task", "project_id,task_id"],
  ["npi_analyses", "ix_npi_analyses_defect_created", "defect_id,created_at"],
  ["defect_fix_requests", "ix_defect_fix_requests_defect_created", "defect_id,created_at"],
  ["regression_requests", "ix_regression_requests_defect_status", "defect_id,status"],
  ["regression_results", "ix_regression_results_defect_created", "defect_id,created_at"],
] as const;
/** Task 8 复合外键依赖的唯一父键索引；旧 defects 表只有单列主键，需补齐项目隔离父键。 */
export const QUALITY_REQUIRED_INDEX_DEFINITIONS = [
  ["defects", "ux_defects_project_id_id", "project_id,id"],
] as const;
/** Task 10 评分卡按项目和版本回看的固定索引。 */
export const SCORECARD_INDEX_DEFINITIONS = [
  ["scorecard_snapshots", "ix_scorecard_snapshots_project_id", "project_id"],
  [
    "scorecard_snapshots",
    "ix_scorecard_snapshots_project_version",
    "project_id,version_number",
  ],
] as const;
/** Task 6 查询使用的固定复合索引。 */
export const RESEARCH_INDEX_DEFINITIONS = [
  ["research_grants", "ix_research_grants_project_task", "project_id,task_id"],
  [
    "research_runs",
    "ix_research_runs_project_created",
    "project_id,created_at",
  ],
  [
    "research_sources",
    "ix_research_sources_project_created",
    "project_id,created_at",
  ],
  [
    "research_conclusions",
    "ix_research_conclusions_project_status",
    "project_id,status",
  ],
  [
    "product_success_metrics",
    "ix_product_success_metrics_project_status",
    "project_id,status",
  ],
  [
    "prd_versions",
    "ix_prd_versions_project_version",
    "project_id,version_number",
  ],
  [
    "pm_peer_reviews",
    "ix_pm_peer_reviews_prd_created",
    "prd_version_id,created_at",
  ],
  [
    "research_security_events",
    "ix_research_security_events_project_created",
    "project_id,created_at",
  ],
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
/** Task 6 表单独维护，避免基础 migration 在表创建前创建索引。 */
export const RESEARCH_PROJECT_SCOPED_TABLES = RESEARCH_TABLE_ORDER;
/** 全部项目范围表的 project_id 索引名来源。 */
export const ALL_PROJECT_SCOPED_TABLES = [
  ...PROJECT_SCOPED_TABLES,
  ...RESEARCH_PROJECT_SCOPED_TABLES,
  ...CODING_TABLE_ORDER,
  ...QUALITY_TABLE_ORDER.filter((table) => table !== "quality_idempotency"),
  ...SCORECARD_TABLE_ORDER,
] as const;
/** 为项目范围表生成固定的 project_id 索引名，供 migration 和完整性检查共用。 */
export const PROJECT_ID_INDEX_NAMES = Object.fromEntries(
  [...ALL_PROJECT_SCOPED_TABLES, "project_deletion_audits"].map((name) => [
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
  includeResearch = false,
  includeQuality = false,
): string {
  const baseTypes = [
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
  ] as const;
  const researchTypes = [
    "research_grant",
    "research_run",
    "research_source",
    "research_report",
    "research_conclusion",
    "research_source_validation",
    "research_conflict",
    "product_success_metric",
    "prd_version",
    "pm_peer_review",
    "research_security_event",
  ] as const;
  const qualityTypes = [
    "quality_review",
    "npi_analysis",
    "fix_request",
    "regression_request",
    "regression_result",
  ] as const;
  const endpointTypes = [
    ...baseTypes,
    ...(includeResearch ? researchTypes : []),
    ...(includeQuality ? qualityTypes : []),
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
    ...(includeResearch ? researchTypes : []),
    ...(includeQuality ? qualityTypes : []),
  ]
    .map((value) => `'${value}'`)
    .join(",");
  const sourceChecks = [
    "WHEN NEW.source_type = 'project' AND NEW.source_id != NEW.project_id THEN RAISE(ABORT, 'trace_links source project mismatch')",
    ...endpointTypes.map((type) => renderTraceEndpointCheck(type, "source")),
  ].join(" ");
  const targetChecks = [
    "WHEN NEW.target_type = 'project' AND NEW.target_id != NEW.project_id THEN RAISE(ABORT, 'trace_links target project mismatch')",
    ...endpointTypes.map((type) => renderTraceEndpointCheck(type, "target")),
  ].join(" ");
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
  const researchTables: Record<string, string> = {
    research_grant: "research_grants",
    research_run: "research_runs",
    research_source: "research_sources",
    research_report: "research_reports",
    research_conclusion: "research_conclusions",
    research_source_validation: "research_source_validations",
    research_conflict: "research_conflicts",
    product_success_metric: "product_success_metrics",
    prd_version: "prd_versions",
    pm_peer_review: "pm_peer_reviews",
    research_security_event: "research_security_events",
  };
  const qualityTables: Record<string, string> = {
    quality_review: "quality_reviews",
    npi_analysis: "npi_analyses",
    fix_request: "defect_fix_requests",
    regression_request: "regression_requests",
    regression_result: "regression_results",
  };
  if (qualityTables[type]) return qualityTables[type];
  return researchTables[type]
    ? researchTables[type]
    : type === "artifact"
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
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), event_id TEXT NOT NULL, notification_type TEXT NOT NULL, severity TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 1, pending INTEGER NOT NULL DEFAULT 1, handled_by TEXT, action TEXT, created_at TEXT NOT NULL, read_at TEXT, handled_at TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), FOREIGN KEY(project_id,event_id) REFERENCES domain_events(project_id,event_id));
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

/**
 * 创建 Task 4 的工作流控制事实表；暂停、租约、风险、检查点和终止确认必须可恢复、可审计。
 */
export function migrateWorkflowSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_pauses (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      reason TEXT NOT NULL,
      impact_scope_json TEXT NOT NULL CHECK (json_valid(impact_scope_json) = 1),
      waiting_for TEXT NOT NULL,
      available_actions_json TEXT NOT NULL CHECK (json_valid(available_actions_json) = 1),
      recovery_condition TEXT NOT NULL,
      previous_status TEXT NOT NULL,
      previous_stage TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','resolved')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
    );
    CREATE TABLE IF NOT EXISTS workflow_leases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      role_id TEXT NOT NULL,
      task_version INTEGER NOT NULL CHECK (task_version >= 1),
      workspace_ref TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      grant_expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','released','expired')),
      release_result TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS workflow_risks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT,
      severity TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
      reason TEXT NOT NULL,
      impact_scope_json TEXT NOT NULL CHECK (json_valid(impact_scope_json) = 1),
      evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) = 1),
      recommendation TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','resolved')),
      approval_id TEXT,
      response_task_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id),
      FOREIGN KEY(approval_id) REFERENCES approvals(id)
    );
    CREATE TABLE IF NOT EXISTS workflow_checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT,
      attempt_id TEXT,
      project_status TEXT NOT NULL,
      project_stage TEXT NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json) = 1),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id),
      FOREIGN KEY(project_id,attempt_id) REFERENCES execution_attempts(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS termination_confirmations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      token_hash TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
      actor_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('previewed','confirmed','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_leases_active_task
      ON workflow_leases(task_id) WHERE status = 'active';
  `);
  for (const [table, index, columns] of WORKFLOW_INDEX_DEFINITIONS)
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0005_task4_workflow",
  );
}

/** 为已有 Task 4 数据库补齐租约原始期限和一般风险响应任务关联。 */
export function migrateWorkflowHardeningSchema(
  db: BetterSqlite3.Database,
): void {
  const leaseColumns = db
    .prepare("PRAGMA table_info(workflow_leases)")
    .all() as { name: string }[];
  if (!leaseColumns.some((column) => column.name === "grant_expires_at"))
    db.exec(
      "ALTER TABLE workflow_leases ADD COLUMN grant_expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
    );
  db.exec(
    "UPDATE workflow_leases SET grant_expires_at=expires_at WHERE grant_expires_at='1970-01-01T00:00:00.000Z'",
  );
  const riskColumns = db.prepare("PRAGMA table_info(workflow_risks)").all() as {
    name: string;
  }[];
  if (!riskColumns.some((column) => column.name === "response_task_id"))
    db.exec("ALTER TABLE workflow_risks ADD COLUMN response_task_id TEXT");
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0006_task4_workflow_hardening",
  );
}

/**
 * 创建五领域模型配置、配置变更审计并补齐模型调用观测字段。
 * 修改日期：2026-08-16。
 * 修改原因：Task 5 要求配置版本、凭据引用、模型调用生命周期和脱敏摘要具备可恢复的持久化合同。
 */
export function migrateModelGatewaySchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_configs (
      domain TEXT PRIMARY KEY CHECK (domain IN (${ORGANIZATION_DOMAIN_IDS.map((domain) => `'${domain}'`).join(",")})),
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      config_version INTEGER NOT NULL CHECK (config_version >= 0),
      secret_ref TEXT,
      credential_status TEXT NOT NULL CHECK (credential_status IN ('configured','missing')),
      connection_status TEXT NOT NULL CHECK (connection_status IN ('unknown','ready','unavailable','blocked')),
      last_error_code TEXT,
      last_error_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_config_changes (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL CHECK (domain IN (${ORGANIZATION_DOMAIN_IDS.map((domain) => `'${domain}'`).join(",")})),
      previous_config_json TEXT NOT NULL CHECK (json_valid(previous_config_json) = 1),
      next_config_json TEXT NOT NULL CHECK (json_valid(next_config_json) = 1),
      expected_config_version INTEGER NOT NULL CHECK (expected_config_version >= 0),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  for (const definition of [
    "model_domain TEXT",
    "model_provider TEXT",
    "model_name TEXT",
    "model_secret_ref TEXT",
    "model_timeout_ms INTEGER",
    "model_retry_max_attempts INTEGER",
  ]) {
    const name = definition.split(" ", 1)[0];
    const columns = db
      .prepare("PRAGMA table_info(execution_attempts)")
      .all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE execution_attempts ADD COLUMN ${definition}`);
    }
  }
  for (const definition of [
    "domain TEXT NOT NULL DEFAULT 'product'",
    "config_version TEXT NOT NULL DEFAULT '0'",
    "span_id TEXT NOT NULL DEFAULT ''",
    "input_summary TEXT NOT NULL DEFAULT ''",
    "output_summary TEXT NOT NULL DEFAULT ''",
    "timeout_ms INTEGER",
    "timed_out INTEGER NOT NULL DEFAULT 0",
    "retry_count INTEGER NOT NULL DEFAULT 0",
    "artifact_ref TEXT",
    "redaction_status TEXT NOT NULL DEFAULT 'passed'",
    "final_status TEXT NOT NULL DEFAULT 'started'",
    "total_tokens INTEGER",
  ]) {
    const name = definition.split(" ", 1)[0];
    const columns = db.prepare("PRAGMA table_info(model_calls)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE model_calls ADD COLUMN ${definition}`);
    }
  }
  const changeColumns = db
    .prepare("PRAGMA table_info(model_config_changes)")
    .all() as {
    name: string;
  }[];
  if (!changeColumns.some((column) => column.name === "request_hash")) {
    db.exec(
      "ALTER TABLE model_config_changes ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''",
    );
  }
  for (const domain of ORGANIZATION_DOMAIN_IDS) {
    db.prepare(
      "INSERT OR IGNORE INTO model_configs (domain,provider,model_name,config_version,secret_ref,credential_status,connection_status,last_error_code,last_error_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      domain,
      "unconfigured",
      "unconfigured",
      0,
      null,
      "missing",
      "blocked",
      "CREDENTIAL_UNAVAILABLE",
      null,
      new Date().toISOString(),
    );
  }
  for (const [table, index, columns] of MODEL_GATEWAY_INDEX_DEFINITIONS) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  }
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0007_task5_model_gateway",
  );
}

/**
 * 创建 Task 6 的调研、来源治理、指标和 PM 评审持久化合同。
 * 修改日期：2026-08-17。
 * 修改原因：网页证据和 Boss 审批前置条件不能只存在内存或 Artifact 文本中，必须可恢复、可追踪且可删除。
 */
export function migrateResearchSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_grants (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, role TEXT NOT NULL,
      allowed_domains_json TEXT NOT NULL CHECK (json_valid(allowed_domains_json) = 1), allowed_urls_json TEXT NOT NULL CHECK (json_valid(allowed_urls_json) = 1),
      max_pages INTEGER NOT NULL CHECK (max_pages BETWEEN 1 AND 100), timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 300),
      evidence_policy TEXT NOT NULL CHECK (evidence_policy = 'source_metadata_and_quote'), network TEXT NOT NULL CHECK (network = 'public_web_only'),
      expires_at TEXT NOT NULL, trace_id TEXT NOT NULL, pages_used INTEGER NOT NULL DEFAULT 0 CHECK (pages_used >= 0),
      status TEXT NOT NULL CHECK (status IN ('active','exhausted','expired')), created_at TEXT NOT NULL, UNIQUE(project_id,id),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES research_grants(id),
      query TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running','completed','blocked','failed')),
      trace_id TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(project_id,id),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS research_sources (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, run_id TEXT, title TEXT NOT NULL, url TEXT NOT NULL,
      publisher TEXT, published_at TEXT, visited_at TEXT NOT NULL, source_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accessed','failed','blocked','pending')), http_status INTEGER, accessible INTEGER NOT NULL CHECK (accessible IN (0,1)),
      supports_conclusions_json TEXT NOT NULL CHECK (json_valid(supports_conclusions_json) = 1), quote TEXT NOT NULL, summary TEXT NOT NULL,
      content_hash TEXT, snapshot_artifact_ref TEXT, verified_by TEXT, verified_at TEXT,
      verification_result TEXT NOT NULL CHECK (verification_result IN ('unverified','supported','unsupported','conflicted')),
      independent INTEGER, conflict_evidence_json TEXT NOT NULL CHECK (json_valid(conflict_evidence_json) = 1), trace_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,run_id) REFERENCES research_runs(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS research_reports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_ref TEXT NOT NULL,
      summary TEXT NOT NULL, source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json) = 1), conclusion_ids_json TEXT NOT NULL CHECK (json_valid(conclusion_ids_json) = 1),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id),
      FOREIGN KEY(project_id,run_id) REFERENCES research_runs(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS research_conclusions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, run_id TEXT, conclusion_type TEXT NOT NULL,
      statement TEXT NOT NULL, source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json) = 1), independence_declaration INTEGER NOT NULL CHECK (independence_declaration IN (0,1)),
      status TEXT NOT NULL CHECK (status IN ('pending','accepted_for_prd','hypothesis_only','rejected')), required_sources INTEGER NOT NULL CHECK (required_sources >= 1),
      valid_independent_sources INTEGER NOT NULL CHECK (valid_independent_sources >= 0), conflicts_json TEXT NOT NULL CHECK (json_valid(conflicts_json) = 1),
      assumption_label TEXT, reviewer TEXT, evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json) = 1), created_at TEXT NOT NULL, validated_at TEXT,
      UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,run_id) REFERENCES research_runs(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS research_source_validations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), conclusion_id TEXT NOT NULL, source_id TEXT NOT NULL, reviewer_role TEXT NOT NULL,
      reviewer_id TEXT NOT NULL, accessible INTEGER NOT NULL CHECK (accessible IN (0,1)), supports_statement INTEGER NOT NULL CHECK (supports_statement IN (0,1)),
      independent INTEGER NOT NULL CHECK (independent IN (0,1)), result TEXT NOT NULL CHECK (result IN ('supported','unsupported','conflicted')), rationale TEXT NOT NULL,
      conflict_ids_json TEXT NOT NULL CHECK (json_valid(conflict_ids_json) = 1), trace_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,id),
      FOREIGN KEY(project_id,conclusion_id) REFERENCES research_conclusions(project_id,id), FOREIGN KEY(project_id,source_id) REFERENCES research_sources(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS research_conflicts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), conclusion_id TEXT NOT NULL, source_a_id TEXT NOT NULL, source_b_id TEXT NOT NULL,
      statement TEXT NOT NULL, evidence_a TEXT NOT NULL, evidence_b TEXT NOT NULL, judgment_reason TEXT, status TEXT NOT NULL CHECK (status IN ('unresolved','resolved')),
      created_at TEXT NOT NULL, UNIQUE(project_id,id), FOREIGN KEY(project_id,conclusion_id) REFERENCES research_conclusions(project_id,id),
      FOREIGN KEY(project_id,source_a_id) REFERENCES research_sources(project_id,id), FOREIGN KEY(project_id,source_b_id) REFERENCES research_sources(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS product_success_metrics (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, name TEXT NOT NULL, target_value TEXT NOT NULL,
      measurement_definition TEXT NOT NULL, verification_method TEXT NOT NULL, owner_role TEXT NOT NULL, reviewer_role TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','pending_review','reviewed','rejected')), evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json) = 1),
      review_id TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS prd_versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, version_number INTEGER NOT NULL CHECK (version_number >= 1),
      content_artifact_ref TEXT NOT NULL, source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json) = 1), conclusion_ids_json TEXT NOT NULL CHECK (json_valid(conclusion_ids_json) = 1),
      metric_ids_json TEXT NOT NULL CHECK (json_valid(metric_ids_json) = 1), peer_review_ids_json TEXT NOT NULL CHECK (json_valid(peer_review_ids_json) = 1),
      dispute_refs_json TEXT NOT NULL CHECK (json_valid(dispute_refs_json) = 1), status TEXT NOT NULL CHECK (status IN ('draft','ready_for_approval','approved','rejected')),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,id), UNIQUE(project_id,version_number), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS pm_peer_reviews (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, prd_version_id TEXT NOT NULL, reviewer_role TEXT NOT NULL,
      reviewer_id TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')), source_validation_summary TEXT NOT NULL,
      conflict_ids_json TEXT NOT NULL CHECK (json_valid(conflict_ids_json) = 1), comments TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,prd_version_id) REFERENCES prd_versions(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS research_security_events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, run_id TEXT, source_id TEXT, categories_json TEXT NOT NULL CHECK (json_valid(categories_json) = 1),
      result TEXT NOT NULL CHECK (result IN ('continued_with_untrusted_text','skipped','blocked')), redaction_reason TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id), FOREIGN KEY(project_id,run_id) REFERENCES research_runs(project_id,id), FOREIGN KEY(project_id,source_id) REFERENCES research_sources(project_id,id)
    );
  `);
  for (const table of RESEARCH_PROJECT_SCOPED_TABLES)
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${PROJECT_ID_INDEX_NAMES[table]} ON ${table}(project_id)`,
    );
  for (const [table, index, columns] of RESEARCH_INDEX_DEFINITIONS)
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  db.exec(
    "DROP TRIGGER IF EXISTS trg_trace_links_project_scope_insert; DROP TRIGGER IF EXISTS trg_trace_links_project_scope_update;",
  );
  db.exec(
    renderTraceLinkTrigger(
      "trg_trace_links_project_scope_insert",
      "INSERT",
      true,
    ),
  );
  db.exec(
    renderTraceLinkTrigger(
      "trg_trace_links_project_scope_update",
      "UPDATE",
      true,
    ),
  );
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0008_task6_research",
  );
}

/**
 * 创建 Task 7 编码 Agent 的持久化合同；原始动作/观察和检查点不可被投影覆盖。
 * 修改日期：2026-08-17。
 * 修改原因：NativeCodingHarness 必须在进程重启、暂停和 Worker 崩溃后恢复，不能只依赖内存状态。
 */
export function migrateCodingSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coding_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('CREATED','CONTEXT_BUILDING','PLAN_READY','POLICY_PENDING','IMPLEMENTING','VERIFYING','DIAGNOSING','REVIEW_REQUESTED','PAUSED','BLOCKED','CANCELLED','COMPLETED')),
      spec_json TEXT NOT NULL CHECK (json_valid(spec_json) = 1),
      grant_json TEXT NOT NULL CHECK (json_valid(grant_json) = 1),
      plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json) = 1),
      workspace_path TEXT NOT NULL,
      baseline_manifest_json TEXT NOT NULL CHECK (json_valid(baseline_manifest_json) = 1),
      current_diff_summary TEXT NOT NULL,
      next_action TEXT NOT NULL,
      failure_diagnoses_json TEXT NOT NULL CHECK (json_valid(failure_diagnoses_json) = 1),
      verification_ids_json TEXT NOT NULL CHECK (json_valid(verification_ids_json) = 1),
      patch_seq_json TEXT NOT NULL CHECK (json_valid(patch_seq_json) = 1),
      read_files_json TEXT NOT NULL CHECK (json_valid(read_files_json) = 1),
      changed_files_json TEXT NOT NULL CHECK (json_valid(changed_files_json) = 1),
      version INTEGER NOT NULL CHECK (version >= 1),
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id,id),
      UNIQUE(project_id,attempt_id),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id),
      FOREIGN KEY(project_id,attempt_id) REFERENCES execution_attempts(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS coding_actions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      type TEXT NOT NULL,
      action_json TEXT NOT NULL CHECK (json_valid(action_json) = 1),
      reason TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('proposed','running','succeeded','failed','rejected')),
      observation_id TEXT,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id,seq),
      FOREIGN KEY(project_id,session_id) REFERENCES coding_sessions(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS coding_observations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('succeeded','failed','rejected')),
      rejection_reason TEXT,
      result_json TEXT NOT NULL CHECK (json_valid(result_json) = 1),
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,session_id) REFERENCES coding_sessions(project_id,id),
      FOREIGN KEY(action_id) REFERENCES coding_actions(id)
    );
    CREATE TABLE IF NOT EXISTS coding_checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      patch_seq INTEGER NOT NULL CHECK (patch_seq >= 0),
      state_json TEXT NOT NULL CHECK (json_valid(state_json) = 1),
      workspace_snapshot TEXT NOT NULL,
      reason TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,session_id) REFERENCES coding_sessions(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS coding_verification_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('succeeded','failed','blocked')),
      steps_json TEXT NOT NULL CHECK (json_valid(steps_json) = 1),
      failure_class TEXT,
      retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,session_id) REFERENCES coding_sessions(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS coding_handoffs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('review_requested','approved','changes_requested','blocked')),
      package_json TEXT NOT NULL CHECK (json_valid(package_json) = 1),
      review_decision TEXT,
      review_comments TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      UNIQUE(project_id,id),
      UNIQUE(session_id),
      FOREIGN KEY(project_id,session_id) REFERENCES coding_sessions(project_id,id)
    );
  `);
  for (const [table, index, columns] of CODING_INDEX_DEFINITIONS) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  }
  for (const table of CODING_TABLE_ORDER) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS ix_${table}_project_id ON ${table} (project_id)`,
    );
  }
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0009_task7_coding",
  );
}

/** 创建 Task 8 质量闭环事实；历史 Review、失败、修复和回归记录只追加不覆盖。 */
export function migrateQualityFlowSchema(db: BetterSqlite3.Database): void {
  for (const [table, index, columns] of QUALITY_REQUIRED_INDEX_DEFINITIONS) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_quality_specs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      task_version INTEGER NOT NULL CHECK (task_version >= 1),
      goal TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json) = 1),
      expected_artifact_types_json TEXT NOT NULL CHECK (json_valid(expected_artifact_types_json) = 1),
      workspace_policy TEXT NOT NULL,
      verification_profile TEXT NOT NULL,
      stack_profile TEXT NOT NULL,
      baseline_commit TEXT NOT NULL,
      allowed_paths_json TEXT NOT NULL CHECK (json_valid(allowed_paths_json) = 1),
      forbidden_paths_json TEXT NOT NULL CHECK (json_valid(forbidden_paths_json) = 1),
      conversion_note TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id,id),
      UNIQUE(project_id,task_id,task_version),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS test_strategies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      scope TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json) = 1),
      test_types_json TEXT NOT NULL CHECK (json_valid(test_types_json) = 1),
      environment_json TEXT NOT NULL CHECK (json_valid(environment_json) = 1),
      owner_role TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','ready')),
      created_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      UNIQUE(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS quality_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      session_id TEXT,
      handoff_id TEXT,
      artifact_version_id TEXT,
      decision TEXT NOT NULL CHECK (decision IN ('approved','changes_requested','blocked')),
      comments TEXT NOT NULL,
      reviewer_role TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      evidence_version INTEGER,
      task_version INTEGER NOT NULL CHECK (task_version >= 1),
      rework_task_id TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id),
      FOREIGN KEY(project_id,artifact_version_id) REFERENCES artifact_versions(project_id,id),
      FOREIGN KEY(project_id,rework_task_id) REFERENCES tasks(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS npi_analyses (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      defect_id TEXT NOT NULL,
      reproduction TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      impact TEXT NOT NULL,
      recommended_fix TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,defect_id) REFERENCES defects(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS defect_fix_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      defect_id TEXT NOT NULL,
      fix_description TEXT NOT NULL,
      fixed_version_id TEXT,
      fix_artifact_ref TEXT,
      submitted_by TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('submitted','awaiting_regression')),
      created_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,defect_id) REFERENCES defects(project_id,id),
      FOREIGN KEY(project_id,fixed_version_id) REFERENCES artifact_versions(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS regression_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      defect_id TEXT NOT NULL,
      fix_request_id TEXT NOT NULL,
      test_case_id TEXT,
      scope TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','running','passed','failed','blocked')),
      created_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,defect_id) REFERENCES defects(project_id,id),
      FOREIGN KEY(project_id,fix_request_id) REFERENCES defect_fix_requests(project_id,id),
      FOREIGN KEY(project_id,test_case_id) REFERENCES test_cases(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS regression_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      defect_id TEXT NOT NULL,
      regression_request_id TEXT NOT NULL,
      test_run_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed','failed','blocked')),
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json) = 1),
      actual_result TEXT NOT NULL,
      executed_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,defect_id) REFERENCES defects(project_id,id),
      FOREIGN KEY(project_id,regression_request_id) REFERENCES regression_requests(project_id,id),
      FOREIGN KEY(project_id,test_run_id) REFERENCES test_runs(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS quality_idempotency (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json) = 1),
      created_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(
    db,
    "test_cases",
    "strategy_id",
    "TEXT REFERENCES test_strategies(id)",
  );
  addColumnIfMissing(db, "test_runs", "baseline_review_id", "TEXT");
  addColumnIfMissing(
    db,
    "test_runs",
    "evidence_refs_json",
    "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json) = 1)",
  );
  addColumnIfMissing(db, "test_runs", "executed_by_role", "TEXT");

  for (const [table, index, columns] of QUALITY_INDEX_DEFINITIONS) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  }
  for (const table of QUALITY_TABLE_ORDER) {
    if (table === "quality_idempotency") continue;
    db.exec(
      `CREATE INDEX IF NOT EXISTS ix_${table}_project_id ON ${table} (project_id)`,
    );
  }
  migrateQualityTraceLinkTriggers(db);
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0010_task8_quality_flow",
  );
}

/** 重建 TraceLink trigger，使 Task 8 的 Review、NPI、修复和回归对象纳入项目隔离校验。 */
export function migrateQualityTraceLinkTriggers(
  db: BetterSqlite3.Database,
): void {
  db.exec(
    "DROP TRIGGER IF EXISTS trg_trace_links_project_scope_insert; DROP TRIGGER IF EXISTS trg_trace_links_project_scope_update;",
  );
  db.exec(
    renderTraceLinkTrigger(
      "trg_trace_links_project_scope_insert",
      "INSERT",
      true,
      true,
    ),
  );
  db.exec(
    renderTraceLinkTrigger(
      "trg_trace_links_project_scope_update",
      "UPDATE",
      true,
      true,
    ),
  );
}

/** 创建 Task 9 历史删除二次确认事实；确认 token 只保存哈希并可在重启后继续校验。 */
export function migrateArchiveConsoleSchema(
  db: BetterSqlite3.Database,
): void {
  addColumnIfMissing(
    db,
    "notifications",
    "version",
    "INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_deletion_confirmations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      token_hash TEXT NOT NULL UNIQUE,
      expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
      actor_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('previewed','confirmed','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      UNIQUE(project_id, id)
    );
  `);
  for (const [table, index, columns] of ARCHIVE_INDEX_DEFINITIONS)
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0011_task9_archive_console",
  );
}

/** 创建 Task 10 评分卡不可变快照；数据不足时 overall_score 保留 NULL 而不是伪造 0 分。 */
export function migrateTask10Schema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scorecard_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      version_number INTEGER NOT NULL CHECK (version_number >= 1),
      rule_version TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      overall_score INTEGER CHECK (overall_score >= 0 AND overall_score <= 100),
      release_status TEXT NOT NULL CHECK (release_status IN ('PASS','BLOCKED','NEEDS_REMEDIATION','DATA_INSUFFICIENT')),
      dimensions_json TEXT NOT NULL CHECK (json_valid(dimensions_json) = 1),
      hard_gates_json TEXT NOT NULL CHECK (json_valid(hard_gates_json) = 1),
      recommendations_json TEXT NOT NULL CHECK (json_valid(recommendations_json) = 1),
      source_data_version TEXT NOT NULL,
      UNIQUE(project_id,version_number)
    );
  `);
  for (const [table, index, columns] of SCORECARD_INDEX_DEFINITIONS) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
  }
  db.prepare("UPDATE drizzle_migrations SET version_num = ?").run(
    "0012_task10_observability_ops",
  );
}

/** 为已存在的 Task 2 表补充可选 Task 8 字段，避免重复迁移破坏历史数据。 */
function addColumnIfMissing(
  db: BetterSqlite3.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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
