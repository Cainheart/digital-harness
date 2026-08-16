"""Task 2 的 SQLAlchemy Core Schema 合同。

本模块只描述表、列、外键、索引和数据库级不变量；领域仓储在后续任务中
复用这些 Table 对象，避免各仓储重复声明字段或约束。
"""

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    text,
)


# 共享元数据容器，供 Alembic 迁移和后续 SQLAlchemy Core 仓储使用。
metadata = MetaData()

# Task 1 已创建的租约表声明只用于解析 Task 2 外键；0002 不负责创建或修改它。
worker_leases = Table(
    "worker_leases",
    metadata,
    Column("worker_id", String(128), primary_key=True),
)

# 项目主状态集合，数据库 CHECK 与后续 Python 状态枚举必须保持一致。
PROJECT_STATUSES = (
    "准备中",
    "运行中",
    "等待 Boss",
    "已暂停",
    "已阻塞",
    "结项中",
    "已结项",
    "已终止",
)

# 任务主状态集合，数据库 CHECK 与后续 Python 状态枚举必须保持一致。
TASK_STATUSES = (
    "待处理",
    "进行中",
    "等待 Review",
    "等待审批",
    "阻塞",
    "返工",
    "已完成",
    "已终止",
)

# PRD/Task 2 冻结的优先级集合；表级 CHECK 从这些 tuple 生成，避免 SQL 文本漂移。
PRIORITIES = ("P0", "P1", "P2", "P3")

# 公共约束名称，后续仓储和迁移测试可通过稳定名称定位数据库不变量。
PROJECT_STATUS_CONSTRAINT_NAME = "ck_projects_status"
TASK_STATUS_CONSTRAINT_NAME = "ck_tasks_status"
DOMAIN_EVENT_AGGREGATE_UNIQUE_CONSTRAINT = "uq_domain_events_aggregate_version"
OUTBOX_EVENT_UNIQUE_CONSTRAINT = "uq_outbox_messages_event_id"
IDEMPOTENCY_KEY_UNIQUE_CONSTRAINT = "uq_idempotency_records_key"
TRACE_LINK_UNIQUE_CONSTRAINT = "uq_trace_links_relation"
ARTIFACT_VERSION_UNIQUE_CONSTRAINT = "uq_artifact_versions_artifact_version"
TASK_DEPENDENCY_UNIQUE_CONSTRAINT = "uq_task_dependencies_pair"
DOMAIN_EVENT_GLOBAL_SEQUENCE_UNIQUE_CONSTRAINT = "uq_domain_events_global_sequence"
PROJECT_OBJECT_UNIQUE_CONSTRAINTS = {
    "tasks": "uq_tasks_project_id_id",
    "artifacts": "uq_artifacts_project_id_id",
    "artifact_versions": "uq_artifact_versions_project_id_id",
    "test_cases": "uq_test_cases_project_id_id",
    "test_runs": "uq_test_runs_project_id_id",
    "execution_attempts": "uq_execution_attempts_project_id_id",
    "domain_events": "uq_domain_events_project_id_event_id",
}

# SQLite 触发器名称，确保 DomainEvent 的历史正文只能追加、不能改写或删除。
DOMAIN_EVENTS_IMMUTABLE_UPDATE_TRIGGER = "trg_domain_events_immutable_update"
DOMAIN_EVENTS_IMMUTABLE_DELETE_TRIGGER = "trg_domain_events_immutable_delete"
ARTIFACT_VERSIONS_IMMUTABLE_UPDATE_TRIGGER = "trg_artifact_versions_immutable_update"
ARTIFACT_VERSIONS_IMMUTABLE_DELETE_TRIGGER = "trg_artifact_versions_immutable_delete"
TRACE_LINKS_PROJECT_INSERT_TRIGGER = "trg_trace_links_project_scope_insert"
TRACE_LINKS_PROJECT_UPDATE_TRIGGER = "trg_trace_links_project_scope_update"

# TraceLink 的多态节点合同是迁移和 Schema integrity checker 的唯一来源。
TRACE_LINK_LOGICAL_NODE_TYPES = (
    "requirement",
    "acceptance_criterion",
    "evidence",
)
TRACE_LINK_PROJECT_ENTITY_CONTRACTS = (
    ("project", "projects", "id", "project"),
    ("task", "tasks", "id", "task"),
    ("artifact_version", "artifact_versions", "id", "artifact version"),
    ("approval", "approvals", "id", "approval"),
    ("review", "reviews", "id", "review"),
    ("test_case", "test_cases", "id", "test case"),
    ("test_run", "test_runs", "id", "test run"),
    ("defect", "defects", "id", "defect"),
    ("execution_attempt", "execution_attempts", "id", "attempt"),
    ("model_call", "model_calls", "id", "model call"),
    ("tool_call", "tool_calls", "id", "tool call"),
    ("domain_event", "domain_events", "event_id", "event"),
)
TRACE_LINK_ALLOWED_NODE_TYPES = (
    "requirement",
    "acceptance_criterion",
    "project",
    "task",
    "artifact_version",
    "approval",
    "review",
    "test_case",
    "test_run",
    "defect",
    "execution_attempt",
    "model_call",
    "tool_call",
    "domain_event",
    "evidence",
)


def render_domain_events_immutable_trigger_sql(trigger_name: str, event_name: str) -> str:
    """生成受控 purge guard 保护的不可变 DomainEvent trigger。"""
    if event_name not in {"UPDATE", "DELETE"}:
        raise ValueError("unsupported domain event trigger event")
    return f"""
        CREATE TRIGGER {trigger_name}
        BEFORE {event_name} ON domain_events
        BEGIN
            SELECT CASE
                WHEN task2_purge_guard(OLD.project_id) = 0
                THEN RAISE(ABORT, 'domain_events are immutable')
            END;
        END
    """


def render_artifact_versions_immutable_trigger_sql(
    trigger_name: str, event_name: str
) -> str:
    """生成受控 purge guard 保护的不可变 ArtifactVersion trigger。"""
    if event_name not in {"UPDATE", "DELETE"}:
        raise ValueError("unsupported artifact version trigger event")
    return f"""
        CREATE TRIGGER {trigger_name}
        BEFORE {event_name} ON artifact_versions
        BEGIN
            SELECT CASE
                WHEN task2_purge_guard(OLD.project_id) = 0
                THEN RAISE(ABORT, 'artifact_versions are immutable')
            END;
        END
    """


def render_trace_links_project_scope_trigger_sql(trigger_name: str, event_name: str) -> str:
    """生成完整 TraceLink 项目隔离 trigger；避免迁移/checker 各写一份 SQL。"""
    if event_name not in {"INSERT", "UPDATE"}:
        raise ValueError("unsupported trace link trigger event")

    def render_side(side: str) -> str:
        branches: list[str] = []
        # 逻辑节点没有独立父表，仍然必须拥有显式分支；它们的 project_id
        # 语义由 TraceLink 自身承载，不能落入“unsupported type”兜底分支。
        for node_type in TRACE_LINK_LOGICAL_NODE_TYPES:
            branches.append(
                f"WHEN NEW.{side}_type = '{node_type}' THEN NULL"
            )
        for node_type, table_name, id_column, label in TRACE_LINK_PROJECT_ENTITY_CONTRACTS:
            if node_type == "project":
                branches.append(
                    f"""WHEN NEW.{side}_type = 'project' AND NEW.{side}_id != NEW.project_id
                            THEN RAISE(ABORT, 'trace_links {side} project mismatch')"""
                )
            else:
                branches.append(
                    f"""WHEN NEW.{side}_type = '{node_type}' AND NOT EXISTS (
                            SELECT 1 FROM {table_name}
                            WHERE project_id = NEW.project_id AND {id_column} = NEW.{side}_id
                        ) THEN RAISE(ABORT, 'trace_links {side} {label} mismatch')"""
                )
        allowed = ", ".join(f"'{node_type}'" for node_type in TRACE_LINK_ALLOWED_NODE_TYPES)
        branches.append(
            f"""WHEN NEW.{side}_type NOT IN ({allowed})
                            THEN RAISE(ABORT, 'trace_links {side} type unsupported')"""
        )
        return "\n".join(branches)

    return f"""
        CREATE TRIGGER {trigger_name}
        BEFORE {event_name} ON trace_links
        BEGIN
            SELECT CASE
                {render_side('source')}
            END;
            SELECT CASE
                {render_side('target')}
            END;
        END
    """


def _allowed_values_check(column_name: str, values: tuple[str, ...], constraint_name: str) -> CheckConstraint:
    """生成基于冻结状态/优先级 tuple 的 SQLite CHECK。"""
    literals = ",".join("'" + value.replace("'", "''") + "'" for value in values)
    return CheckConstraint(f"{column_name} IN ({literals})", name=constraint_name)


def _json_check(column_name: str, constraint_name: str) -> CheckConstraint:
    """要求 SQLite JSON1 能解析结构化 JSON 字段，拒绝伪 JSON 文本。"""
    return CheckConstraint(f"json_valid({column_name}) = 1", name=constraint_name)


projects = Table(
    "projects",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("name", String(255), nullable=False),
    Column("business_goal", Text, nullable=False),
    Column("target_users", Text, nullable=False),
    Column("priority", String(16), nullable=False),
    Column("deadline", DateTime(timezone=True)),
    Column("constraints_json", Text, nullable=False),
    Column("stage", String(128), nullable=False),
    Column("status", String(64), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("ended_at", DateTime(timezone=True)),
    Column("version", Integer, nullable=False, server_default=text("1")),
    Column("read_only", Boolean, nullable=False, server_default=text("0")),
    _allowed_values_check("status", PROJECT_STATUSES, PROJECT_STATUS_CONSTRAINT_NAME),
    _allowed_values_check("priority", PRIORITIES, "ck_projects_priority"),
    CheckConstraint("version >= 0", name="ck_projects_version_nonnegative"),
    _json_check("constraints_json", "ck_projects_constraints_json"),
    # 父表主键本身是项目范围唯一；领域子表通过各自 (project_id, id) 唯一键引用。
)

tasks = Table(
    "tasks",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("title", String(255), nullable=False),
    Column("owner_role", String(128), nullable=False),
    Column("specialist_tag", String(128), nullable=False),
    Column("assignment_reason", Text, nullable=False),
    Column("priority", String(16), nullable=False),
    Column("dependencies_json", Text, nullable=False),
    Column("expected_deliverables_json", Text, nullable=False),
    Column("status", String(64), nullable=False),
    Column("started_at", DateTime(timezone=True)),
    Column("ended_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("version", Integer, nullable=False, server_default=text("1")),
    UniqueConstraint("project_id", "id", name=PROJECT_OBJECT_UNIQUE_CONSTRAINTS["tasks"]),
    _allowed_values_check("status", TASK_STATUSES, TASK_STATUS_CONSTRAINT_NAME),
    _allowed_values_check("priority", PRIORITIES, "ck_tasks_priority"),
    CheckConstraint("version >= 0", name="ck_tasks_version_nonnegative"),
    _json_check("dependencies_json", "ck_tasks_dependencies_json"),
    _json_check("expected_deliverables_json", "ck_tasks_expected_deliverables_json"),
)

task_dependencies = Table(
    "task_dependencies",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128), nullable=False),
    Column("depends_on_task_id", String(128), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    ForeignKeyConstraint(
        ["project_id", "task_id"],
        ["tasks.project_id", "tasks.id"],
        name="fk_task_dependencies_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "depends_on_task_id"],
        ["tasks.project_id", "tasks.id"],
        name="fk_task_dependencies_dependency_project",
    ),
    UniqueConstraint(
        "task_id",
        "depends_on_task_id",
        name=TASK_DEPENDENCY_UNIQUE_CONSTRAINT,
    ),
)

artifacts = Table(
    "artifacts",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("name", String(255), nullable=False),
    Column("artifact_type", String(128), nullable=False),
    Column("owner_role", String(128), nullable=False),
    Column("status", String(64), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("created_by", String(128), nullable=False),
    ForeignKeyConstraint(
        ["project_id", "task_id"],
        ["tasks.project_id", "tasks.id"],
        name="fk_artifacts_task_project",
    ),
    UniqueConstraint("project_id", "id", name=PROJECT_OBJECT_UNIQUE_CONSTRAINTS["artifacts"]),
)

artifact_versions = Table(
    "artifact_versions",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("artifact_id", String(128), nullable=False),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("version_number", Integer, nullable=False),
    Column("parent_version_id", String(128)),
    Column("change_reason", Text, nullable=False),
    Column("store_ref", String(1024), nullable=False),
    Column("sha256", String(64), nullable=False),
    Column("media_type", String(255), nullable=False),
    Column("size_bytes", Integer, nullable=False),
    Column("relative_path", String(1024), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("created_by", String(128), nullable=False),
    ForeignKeyConstraint(
        ["project_id", "artifact_id"],
        ["artifacts.project_id", "artifacts.id"],
        name="fk_artifact_versions_artifact_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "task_id"],
        ["tasks.project_id", "tasks.id"],
        name="fk_artifact_versions_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "parent_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_artifact_versions_parent_project",
    ),
    UniqueConstraint(
        "project_id",
        "id",
        name=PROJECT_OBJECT_UNIQUE_CONSTRAINTS["artifact_versions"],
    ),
    UniqueConstraint(
        "artifact_id",
        "version_number",
        name=ARTIFACT_VERSION_UNIQUE_CONSTRAINT,
    ),
    CheckConstraint("version_number >= 0", name="ck_artifact_versions_version_nonnegative"),
    CheckConstraint("size_bytes >= 0", name="ck_artifact_versions_size_nonnegative"),
)

approvals = Table(
    "approvals",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("approval_type", String(128), nullable=False),
    Column("subject_type", String(128), nullable=False),
    Column("subject_id", String(128), nullable=False),
    Column("artifact_version_id", String(128)),
    Column("evidence_version_id", String(128)),
    Column("decision", String(64)),
    Column("direction", Text),
    Column("boss_id", String(128), nullable=False),
    Column("status", String(64), nullable=False),
    Column("response_task_id", String(128)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("decided_at", DateTime(timezone=True)),
    Column("version", Integer, nullable=False, server_default=text("1")),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_approvals_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "artifact_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_approvals_artifact_version_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "evidence_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_approvals_evidence_version_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "response_task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_approvals_response_task_project",
    ),
    CheckConstraint("version >= 0", name="ck_approvals_version_nonnegative"),
)

reviews = Table(
    "reviews",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("artifact_version_id", String(128), nullable=False),
    Column("reviewer_role", String(128), nullable=False),
    Column("reviewer_id", String(128), nullable=False),
    Column("decision", String(64), nullable=False),
    Column("comments", Text, nullable=False),
    Column("evidence_version_id", String(128)),
    Column("rework_task_id", String(128)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("decided_at", DateTime(timezone=True)),
    Column("version", Integer, nullable=False, server_default=text("1")),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_reviews_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "artifact_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_reviews_artifact_version_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "evidence_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_reviews_evidence_version_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "rework_task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_reviews_rework_task_project",
    ),
    CheckConstraint("version >= 0", name="ck_reviews_version_nonnegative"),
)

test_cases = Table(
    "test_cases",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("acceptance_criteria_json", Text, nullable=False),
    Column("preconditions", Text, nullable=False),
    Column("steps", Text, nullable=False),
    Column("expected_result", Text, nullable=False),
    Column("test_type", String(128), nullable=False),
    Column("owner_role", String(128), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("version", Integer, nullable=False, server_default=text("1")),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_test_cases_task_project",
    ),
    UniqueConstraint("project_id", "id", name=PROJECT_OBJECT_UNIQUE_CONSTRAINTS["test_cases"]),
    CheckConstraint("version >= 0", name="ck_test_cases_version_nonnegative"),
    _json_check("acceptance_criteria_json", "ck_test_cases_acceptance_criteria_json"),
)

test_runs = Table(
    "test_runs",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("test_case_id", String(128), nullable=False),
    Column("baseline_version_id", String(128)),
    Column("command_or_steps", Text, nullable=False),
    Column("environment_json", Text, nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("ended_at", DateTime(timezone=True)),
    Column("actual_result", Text, nullable=False),
    Column("exit_code", Integer),
    Column("status", String(64), nullable=False),
    Column("evidence_version_id", String(128)),
    Column("trace_id", String(128), nullable=False),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_test_runs_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "test_case_id"], ["test_cases.project_id", "test_cases.id"],
        name="fk_test_runs_case_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "baseline_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_test_runs_baseline_version_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "evidence_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_test_runs_evidence_version_project",
    ),
    UniqueConstraint("project_id", "id", name=PROJECT_OBJECT_UNIQUE_CONSTRAINTS["test_runs"]),
    _json_check("environment_json", "ck_test_runs_environment_json"),
)

defects = Table(
    "defects",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("source_test_run_id", String(128), nullable=False),
    Column("reproduction", Text, nullable=False),
    Column("severity", String(64), nullable=False),
    Column("actual_result", Text, nullable=False),
    Column("expected_result", Text, nullable=False),
    Column("evidence_version_id", String(128)),
    Column("npi_owner_role", String(128), nullable=False),
    Column("status", String(64), nullable=False),
    Column("fixed_version_id", String(128)),
    Column("regression_test_run_id", String(128)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("resolved_at", DateTime(timezone=True)),
    Column("version", Integer, nullable=False, server_default=text("1")),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_defects_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "source_test_run_id"], ["test_runs.project_id", "test_runs.id"],
        name="fk_defects_source_test_run_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "evidence_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_defects_evidence_version_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "fixed_version_id"],
        ["artifact_versions.project_id", "artifact_versions.id"],
        name="fk_defects_fixed_version_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "regression_test_run_id"],
        ["test_runs.project_id", "test_runs.id"],
        name="fk_defects_regression_test_run_project",
    ),
    CheckConstraint("version >= 0", name="ck_defects_version_nonnegative"),
)

execution_attempts = Table(
    "execution_attempts",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128), nullable=False),
    Column("role", String(128), nullable=False),
    Column("model_config_version", String(128), nullable=False),
    Column("workspace_ref", String(1024)),
    Column("worker_lease_id", String(128), ForeignKey("worker_leases.worker_id")),
    Column("status", String(64), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("ended_at", DateTime(timezone=True)),
    Column("retry_of_attempt_id", String(128)),
    Column("retry_count", Integer, nullable=False, server_default=text("0")),
    Column("trace_id", String(128), nullable=False),
    Column("version", Integer, nullable=False, server_default=text("1")),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_execution_attempts_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "retry_of_attempt_id"],
        ["execution_attempts.project_id", "execution_attempts.id"],
        name="fk_execution_attempts_retry_project",
    ),
    CheckConstraint("retry_count >= 0", name="ck_execution_attempts_retry_nonnegative"),
    CheckConstraint("version >= 0", name="ck_execution_attempts_version_nonnegative"),
    UniqueConstraint("project_id", "id", name=PROJECT_OBJECT_UNIQUE_CONSTRAINTS["execution_attempts"]),
)

model_calls = Table(
    "model_calls",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("execution_attempt_id", String(128), nullable=False),
    Column("role", String(128), nullable=False),
    Column("provider", String(128), nullable=False),
    Column("model", String(128), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("ended_at", DateTime(timezone=True)),
    Column("duration_ms", Integer),
    Column("summary", Text, nullable=False),
    Column("error_code", String(128)),
    Column("input_tokens", Integer),
    Column("output_tokens", Integer),
    Column("cost_micros", Integer),
    Column("trace_id", String(128), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_model_calls_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "execution_attempt_id"],
        ["execution_attempts.project_id", "execution_attempts.id"],
        name="fk_model_calls_attempt_project",
    ),
    CheckConstraint("duration_ms IS NULL OR duration_ms >= 0", name="ck_model_calls_duration_nonnegative"),
    CheckConstraint("input_tokens IS NULL OR input_tokens >= 0", name="ck_model_calls_input_tokens_nonnegative"),
    CheckConstraint("output_tokens IS NULL OR output_tokens >= 0", name="ck_model_calls_output_tokens_nonnegative"),
    CheckConstraint("cost_micros IS NULL OR cost_micros >= 0", name="ck_model_calls_cost_nonnegative"),
)

tool_calls = Table(
    "tool_calls",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("task_id", String(128)),
    Column("execution_attempt_id", String(128), nullable=False),
    Column("role", String(128), nullable=False),
    Column("tool_name", String(255), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("ended_at", DateTime(timezone=True)),
    Column("duration_ms", Integer),
    Column("summary", Text, nullable=False),
    Column("error_code", String(128)),
    Column("trace_id", String(128), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    ForeignKeyConstraint(
        ["project_id", "task_id"], ["tasks.project_id", "tasks.id"],
        name="fk_tool_calls_task_project",
    ),
    ForeignKeyConstraint(
        ["project_id", "execution_attempt_id"],
        ["execution_attempts.project_id", "execution_attempts.id"],
        name="fk_tool_calls_attempt_project",
    ),
    CheckConstraint("duration_ms IS NULL OR duration_ms >= 0", name="ck_tool_calls_duration_nonnegative"),
)

domain_events = Table(
    "domain_events",
    metadata,
    Column("event_id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id")),
    Column("event_type", String(128), nullable=False),
    Column("aggregate_type", String(128), nullable=False),
    Column("aggregate_id", String(128), nullable=False),
    Column("aggregate_version", Integer, nullable=False),
    Column("global_sequence", Integer, nullable=False),
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    # SR-EVT-001 要求事件事实可直接查询耗时；瞬时事件用 0 毫秒表达。
    Column("duration_ms", Integer, nullable=False, server_default=text("0")),
    Column("actor_type", String(128), nullable=False),
    Column("actor_id", String(128), nullable=False),
    Column("input_summary", Text, nullable=False),
    Column("output_summary", Text, nullable=False),
    Column("result", String(64), nullable=False),
    Column("failure", Text),
    Column("retry_count", Integer, nullable=False, server_default=text("0")),
    Column("trace_id", String(128), nullable=False),
    Column("payload_json", Text, nullable=False),
    UniqueConstraint(
        "aggregate_type",
        "aggregate_id",
        "aggregate_version",
        name=DOMAIN_EVENT_AGGREGATE_UNIQUE_CONSTRAINT,
    ),
    UniqueConstraint(
        "project_id",
        "event_id",
        name=PROJECT_OBJECT_UNIQUE_CONSTRAINTS["domain_events"],
    ),
    UniqueConstraint(
        "global_sequence",
        name=DOMAIN_EVENT_GLOBAL_SEQUENCE_UNIQUE_CONSTRAINT,
    ),
    CheckConstraint("aggregate_version >= 0", name="ck_domain_events_aggregate_version_nonnegative"),
    CheckConstraint("global_sequence >= 0", name="ck_domain_events_global_sequence_nonnegative"),
    CheckConstraint("duration_ms >= 0", name="ck_domain_events_duration_nonnegative"),
    CheckConstraint("retry_count >= 0", name="ck_domain_events_retry_nonnegative"),
    _json_check("payload_json", "ck_domain_events_payload_json"),
)

notifications = Table(
    "notifications",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("event_id", String(128), nullable=False),
    Column("notification_type", String(128), nullable=False),
    Column("severity", String(64), nullable=False),
    Column("subject_type", String(128), nullable=False),
    Column("subject_id", String(128), nullable=False),
    Column("unread", Boolean, nullable=False, server_default=text("1")),
    Column("pending", Boolean, nullable=False, server_default=text("1")),
    Column("handled_by", String(128)),
    Column("action", Text),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("read_at", DateTime(timezone=True)),
    Column("handled_at", DateTime(timezone=True)),
    ForeignKeyConstraint(
        ["project_id", "event_id"],
        ["domain_events.project_id", "domain_events.event_id"],
        name="fk_notifications_event_project",
    ),
)

outbox_messages = Table(
    "outbox_messages",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id")),
    Column("event_id", String(128), nullable=False),
    Column("topic", String(255), nullable=False),
    Column("payload_json", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("published_at", DateTime(timezone=True)),
    Column("status", String(64), nullable=False),
    Column("retry_count", Integer, nullable=False, server_default=text("0")),
    Column("last_error", Text),
    Column("available_at", DateTime(timezone=True)),
    UniqueConstraint("event_id", name=OUTBOX_EVENT_UNIQUE_CONSTRAINT),
    ForeignKeyConstraint(
        ["project_id", "event_id"],
        ["domain_events.project_id", "domain_events.event_id"],
        name="fk_outbox_messages_event_project",
    ),
    CheckConstraint("retry_count >= 0", name="ck_outbox_messages_retry_nonnegative"),
    _json_check("payload_json", "ck_outbox_messages_payload_json"),
)

idempotency_records = Table(
    "idempotency_records",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id")),
    Column("idempotency_key", String(255), nullable=False),
    Column("command_id", String(128), nullable=False),
    Column("aggregate_type", String(128), nullable=False),
    Column("aggregate_id", String(128), nullable=False),
    Column("request_hash", String(64), nullable=False),
    Column("response_json", Text, nullable=False),
    Column("event_id", String(128)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("idempotency_key", name=IDEMPOTENCY_KEY_UNIQUE_CONSTRAINT),
    ForeignKeyConstraint(
        ["project_id", "event_id"],
        ["domain_events.project_id", "domain_events.event_id"],
        name="fk_idempotency_records_event_project",
    ),
    _json_check("response_json", "ck_idempotency_records_response_json"),
)

trace_links = Table(
    "trace_links",
    metadata,
    Column("id", String(128), primary_key=True),
    Column("project_id", String(128), ForeignKey("projects.id"), nullable=False),
    Column("source_type", String(128), nullable=False),
    Column("source_id", String(128), nullable=False),
    Column("target_type", String(128), nullable=False),
    Column("target_id", String(128), nullable=False),
    Column("relation", String(128), nullable=False),
    Column("trace_id", String(128), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint(
        "source_type",
        "source_id",
        "target_type",
        "target_id",
        "relation",
        name=TRACE_LINK_UNIQUE_CONSTRAINT,
    ),
)

project_deletion_audits = Table(
    "project_deletion_audits",
    metadata,
    Column("id", Integer, primary_key=True),
    # 不建立 projects 外键：项目删除后仍需保留最小三字段审计记录。
    Column("project_id", String(128), nullable=False),
    Column("deleted_at", DateTime(timezone=True), nullable=False),
    Column("actor_id", String(128), nullable=False),
)


# 需要 project_id 过滤的表统一暴露索引名，保证查询仓储可预测地使用项目范围索引。
PROJECT_SCOPED_TABLE_NAMES = (
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
)

# 项目删除审计的主键已提供等价查找能力，仍显式建立命名 project_id 索引便于结构验收。
PROJECT_ID_INDEX_NAMES = {
    table_name: f"ix_{table_name}_project_id"
    for table_name in (*PROJECT_SCOPED_TABLE_NAMES, "project_deletion_audits")
}

# 所有项目范围索引的 SQLAlchemy 对象，迁移和仓储可复用同一组定义。
PROJECT_ID_INDEXES = tuple(
    Index(PROJECT_ID_INDEX_NAMES[table_name], metadata.tables[table_name].c.project_id)
    for table_name in (*PROJECT_SCOPED_TABLE_NAMES, "project_deletion_audits")
)

# 迁移按依赖顺序创建/按逆序删除的 Task 2 表名。
TASK2_TABLE_ORDER = (
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
)

# Task 2 迁移创建的完整表名集合，供 readiness/测试/后续仓储做结构断言。
TASK2_TABLES = frozenset(TASK2_TABLE_ORDER)


def _schema_unique_contracts() -> tuple[tuple[str, str, tuple[str, ...]], ...]:
    """从唯一 Schema 合同生成 Inspector 需要验证的表、名称和列映射。"""
    contracts: list[tuple[str, str, tuple[str, ...]]] = []
    for table_name in TASK2_TABLE_ORDER:
        table = metadata.tables[table_name]
        for constraint in table.constraints:
            if isinstance(constraint, UniqueConstraint) and constraint.name:
                contracts.append(
                    (table_name, constraint.name, tuple(column.name for column in constraint.columns))
                )
    return tuple(sorted(contracts))


def _schema_foreign_key_contracts() -> tuple[
    tuple[str, str, tuple[str, ...], str, tuple[str, ...]], ...
]:
    """从 SQLAlchemy Table 合同生成完整的 Inspector 复合 FK 映射。"""
    contracts: list[tuple[str, str, tuple[str, ...], str, tuple[str, ...]]] = []
    for table_name in TASK2_TABLE_ORDER:
        table = metadata.tables[table_name]
        for constraint in table.constraints:
            if not isinstance(constraint, ForeignKeyConstraint):
                continue
            elements = tuple(constraint.elements)
            if not elements:
                continue
            contracts.append(
                (
                    table_name,
                    constraint.name or "",
                    tuple(constraint.column_keys),
                    elements[0].column.table.name,
                    tuple(element.column.name for element in elements),
                )
            )
    return tuple(sorted(contracts))


def _schema_check_contracts() -> tuple[tuple[str, str, str], ...]:
    """从 Table 合同生成状态、优先级、JSON 和非负 CHECK 映射。"""
    contracts: list[tuple[str, str, str]] = []
    for table_name in TASK2_TABLE_ORDER:
        table = metadata.tables[table_name]
        for constraint in table.constraints:
            if isinstance(constraint, CheckConstraint) and constraint.name:
                contracts.append((table_name, constraint.name, str(constraint.sqltext)))
    return tuple(sorted(contracts))


# Schema integrity checker 使用这些只读合同验证真实 SQLite 结构，不仅检查名称存在。
SCHEMA_UNIQUE_CONTRACTS = _schema_unique_contracts()
SCHEMA_FOREIGN_KEY_CONTRACTS = _schema_foreign_key_contracts()
SCHEMA_CHECK_CONTRACTS = _schema_check_contracts()
SCHEMA_INDEX_CONTRACTS = tuple(
    (table_name, index_name, ("project_id",))
    for table_name, index_name in sorted(PROJECT_ID_INDEX_NAMES.items())
)

# 六个关键 trigger 的完整规范 SQL，迁移和 integrity checker 只消费这一份合同。
# 修改说明：T2-AC-03 要求项目隔离逻辑不能通过同名弱化 trigger 绕过，故这里
# 保留完整 SQL 生成器作为单一来源，checker 还会在临时 SQLite 副本执行探针。
TRIGGER_SQL_CONTRACTS = {
    DOMAIN_EVENTS_IMMUTABLE_UPDATE_TRIGGER: render_domain_events_immutable_trigger_sql(
        DOMAIN_EVENTS_IMMUTABLE_UPDATE_TRIGGER,
        "UPDATE",
    ),
    DOMAIN_EVENTS_IMMUTABLE_DELETE_TRIGGER: render_domain_events_immutable_trigger_sql(
        DOMAIN_EVENTS_IMMUTABLE_DELETE_TRIGGER,
        "DELETE",
    ),
    ARTIFACT_VERSIONS_IMMUTABLE_UPDATE_TRIGGER: render_artifact_versions_immutable_trigger_sql(
        ARTIFACT_VERSIONS_IMMUTABLE_UPDATE_TRIGGER,
        "UPDATE",
    ),
    ARTIFACT_VERSIONS_IMMUTABLE_DELETE_TRIGGER: render_artifact_versions_immutable_trigger_sql(
        ARTIFACT_VERSIONS_IMMUTABLE_DELETE_TRIGGER,
        "DELETE",
    ),
    TRACE_LINKS_PROJECT_INSERT_TRIGGER: render_trace_links_project_scope_trigger_sql(
        TRACE_LINKS_PROJECT_INSERT_TRIGGER,
        "INSERT",
    ),
    TRACE_LINKS_PROJECT_UPDATE_TRIGGER: render_trace_links_project_scope_trigger_sql(
        TRACE_LINKS_PROJECT_UPDATE_TRIGGER,
        "UPDATE",
    ),
}
