from datetime import datetime, timedelta, timezone
from hashlib import sha256

import pytest
from pydantic import ValidationError

from app.domain.common import Actor, ProjectStatus, TaskStatus
from app.domain.entities import (
    Approval,
    Artifact,
    ArtifactRef,
    ArtifactVersion,
    Defect,
    ExecutionAttempt,
    ModelCall,
    Notification,
    Project,
    Review,
    Task,
    TestCase,
    TestRun,
    ToolCall,
    TraceLink,
)
from app.domain.events import AppendResult, DomainEvent, DomainEventDraft


NOW = datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc)
SHA = sha256(b"task2-evidence").hexdigest()


def test_project_and_task_are_minimal_complete_traceable_contracts():
    project = Project(
        id="project_test",
        name="项目管理小应用",
        business_goal="验证项目管理闭环",
        target_users="本地 Boss",
        priority="P0",
        deadline=NOW,
        constraints={"local_only": True},
        stage="立项",
        status=ProjectStatus.PREPARING,
        created_at=NOW,
        ended_at=None,
        version=1,
        read_only=False,
    )
    task = Task(
        id="task_test",
        project_id=project.id,
        title="实现领域模型",
        owner_role="backend_developer",
        specialist_tag="backend",
        assignment_reason="Task 2 domain foundation",
        priority="P0",
        dependencies=("task_previous",),
        expected_deliverables=("domain-contract",),
        status=TaskStatus.PENDING,
        created_at=NOW,
        started_at=None,
        ended_at=None,
        version=1,
    )

    assert project.status is ProjectStatus.PREPARING
    assert task.status is TaskStatus.PENDING
    assert task.project_id == project.id


def test_artifact_reference_requires_sha256_nonnegative_size_and_relative_path():
    reference = ArtifactRef(
        artifact_id="artifact_test",
        sha256=SHA,
        media_type="text/plain",
        size=16,
        created_at=NOW,
        relative_path="project_test/sha256/ab/evidence.txt",
    )

    assert reference.sha256 == SHA
    assert reference.size == 16

    with pytest.raises(ValidationError):
        ArtifactRef(
            artifact_id="artifact_test",
            sha256="not-a-sha256",
            media_type="text/plain",
            size=16,
            created_at=NOW,
            relative_path="project_test/evidence.txt",
        )
    with pytest.raises(ValidationError):
        ArtifactRef(
            artifact_id="artifact_test",
            sha256=SHA,
            media_type="text/plain",
            size=16,
            created_at=NOW,
            relative_path="../escape.txt",
        )


@pytest.mark.parametrize(
    "relative_path",
    ["project//artifact", "project/./artifact", "project/../artifact"],
)
def test_artifact_reference_rejects_raw_empty_dot_and_parent_path_segments(relative_path):
    with pytest.raises(ValidationError):
        ArtifactRef(
            artifact_id="artifact_test",
            sha256=SHA,
            media_type="text/plain",
            size=16,
            created_at=NOW,
            relative_path=relative_path,
        )


@pytest.mark.parametrize("node_type", ["artifact", "notification"])
def test_trace_link_domain_allowlist_rejects_nodes_outside_design_contract(node_type):
    with pytest.raises(ValidationError):
        TraceLink(
            id="trace_invalid_node",
            project_id="project_test",
            source_type="acceptance_criterion",
            source_id="AC-02",
            target_type=node_type,
            target_id="node",
            relation="covers",
            trace_id="trace_test",
            created_at=NOW,
        )


def test_datetime_fields_must_be_timezone_aware_and_versions_positive():
    with pytest.raises(ValidationError):
        Project(
            id="project_test",
            name="项目",
            business_goal="目标",
            target_users="用户",
            priority="P0",
            deadline=None,
            constraints={},
            stage="立项",
            status=ProjectStatus.PREPARING,
            created_at=datetime(2026, 8, 16),
            version=1,
        )
    with pytest.raises(ValidationError):
        Task(
            id="task_test",
            project_id="project_test",
            title="任务",
            owner_role="developer",
            specialist_tag="backend",
            assignment_reason="合同测试",
            priority="P0",
            dependencies=(),
            expected_deliverables=(),
            status=TaskStatus.PENDING,
            created_at=NOW,
            version=0,
        )


def test_aware_datetimes_normalize_to_utc_and_round_trip_without_wall_clock_drift():
    shanghai_time = datetime(2026, 8, 16, 8, 0, tzinfo=timezone(timedelta(hours=8)))
    expected_utc = datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc)

    project = Project(
        id="project_timezone",
        name="时区项目",
        business_goal="验证 UTC 归一化",
        target_users="测试用户",
        priority="P0",
        deadline=shanghai_time,
        constraints={},
        stage="立项",
        status=ProjectStatus.PREPARING,
        created_at=shanghai_time,
        version=1,
    )
    round_tripped = Project.model_validate(project.model_dump())

    assert project.created_at == expected_utc
    assert project.deadline == expected_utc
    assert project.created_at.tzinfo == timezone.utc
    assert project.deadline.tzinfo == timezone.utc
    assert round_tripped.created_at == expected_utc
    assert round_tripped.deadline == expected_utc
    assert round_tripped.created_at.tzinfo == timezone.utc
    assert round_tripped.deadline.tzinfo == timezone.utc


def test_domain_assignment_revalidates_status_and_version_without_breaking_materialized_store_ref():
    project = Project(
        id="project_test",
        name="项目",
        business_goal="目标",
        target_users="用户",
        priority="P0",
        deadline=None,
        constraints={},
        stage="立项",
        status=ProjectStatus.PREPARING,
        created_at=NOW,
        version=1,
    )
    with pytest.raises(ValidationError):
        project.version = 0
    with pytest.raises(ValidationError):
        project.status = "bogus"

    artifact_version = ArtifactVersion(
        id="artifact_version_test",
        artifact_id="artifact_test",
        project_id="project_test",
        version=1,
        change_reason="初版",
        content_ref=ArtifactRef(
            artifact_id="artifact_test",
            sha256=SHA,
            media_type="text/plain",
            size=16,
            created_at=NOW,
            relative_path="project_test/evidence.txt",
        ),
        created_at=NOW,
        created_by="pm-1",
    )
    assert artifact_version.store_ref == "project_test/evidence.txt"


def test_flat_artifact_version_normalization_accepts_created_at_and_createdAt():
    for created_key in ("created_at", "createdAt"):
        flat = {
            "id": "artifact_version_test",
            "artifact_id": "artifact_test",
            "project_id": "project_test",
            "version_number": 2,
            "sha256": SHA,
            "media_type": "text/plain",
            "size_bytes": 16,
            "relative_path": "project_test/evidence.txt",
            created_key: NOW,
            "created_by": "pm-1",
            "change_reason": "兼容旧扁平格式",
        }

        artifact_version = ArtifactVersion(**flat)

        assert artifact_version.version == 2
        assert artifact_version.created_at == NOW
        assert artifact_version.content_ref.created_at == NOW


@pytest.mark.parametrize("size_key", ["size_bytes", "sizeBytes", "size"])
def test_flat_artifact_version_normalization_accepts_mixed_camel_case_aliases(size_key):
    flat = {
        "id": "artifact_version_test",
        "artifactId": "artifact_test",
        "project_id": "project_test",
        "version_number": 3,
        "sha256": SHA,
        "mediaType": "text/plain",
        size_key: 16,
        "relativePath": "project_test/evidence.txt",
        "createdAt": NOW,
        "created_by": "pm-1",
        "change_reason": "混合旧格式",
    }

    artifact_version = ArtifactVersion(**flat)

    assert artifact_version.artifact_id == "artifact_test"
    assert artifact_version.version == 3
    assert artifact_version.content_ref.media_type == "text/plain"
    assert artifact_version.content_ref.size == 16
    assert artifact_version.content_ref.relative_path == "project_test/evidence.txt"
    assert artifact_version.created_at == NOW


def test_artifact_version_normalization_accepts_camel_case_content_ref():
    artifact_version = ArtifactVersion(
        id="artifact_version_test",
        artifactId="artifact_test",
        project_id="project_test",
        version_number=4,
        contentRef={
            "artifactId": "artifact_test",
            "sha256": SHA,
            "mediaType": "text/plain",
            "size": 16,
            "createdAt": NOW,
            "relativePath": "project_test/evidence.txt",
        },
        createdAt=NOW,
        created_by="pm-1",
        change_reason="camel contentRef",
    )

    assert artifact_version.version == 4
    assert artifact_version.content_ref.artifact_id == "artifact_test"
    assert artifact_version.content_ref.created_at == NOW


def test_artifact_version_normalization_accepts_complete_mixed_camel_and_snake_aliases():
    artifact_version = ArtifactVersion(
        id="artifact_version_test",
        artifactId="artifact_test",
        projectId="project_test",
        task_id="task_test",
        versionNumber=5,
        sha256=SHA,
        mediaType="text/plain",
        sizeBytes=16,
        relativePath="project_test/evidence.txt",
        createdAt=NOW,
        parentVersionId="artifact_version_parent",
        changeReason="完整混合旧格式",
        created_by="pm-1",
        storeRef="artifact-store/project_test/evidence.txt",
    )

    assert artifact_version.artifact_id == "artifact_test"
    assert artifact_version.project_id == "project_test"
    assert artifact_version.task_id == "task_test"
    assert artifact_version.version == 5
    assert artifact_version.parent_version_id == "artifact_version_parent"
    assert artifact_version.change_reason == "完整混合旧格式"
    assert artifact_version.created_by == "pm-1"
    assert artifact_version.store_ref == "artifact-store/project_test/evidence.txt"
    assert artifact_version.content_ref.media_type == "text/plain"
    assert artifact_version.content_ref.size == 16


def test_artifact_version_model_dump_by_alias_uses_complete_camel_case_contract():
    artifact_version = ArtifactVersion(
        id="artifact_version_test",
        artifact_id="artifact_test",
        project_id="project_test",
        task_id="task_test",
        version=6,
        content_ref=ArtifactRef(
            artifact_id="artifact_test",
            sha256=SHA,
            media_type="text/plain",
            size=16,
            created_at=NOW,
            relative_path="project_test/evidence.txt",
        ),
        parent_version_id="artifact_version_parent",
        change_reason="alias output",
        created_by="pm-1",
        store_ref="artifact-store/project_test/evidence.txt",
        created_at=NOW,
    )

    serialized = artifact_version.model_dump(mode="json", by_alias=True)

    assert serialized["artifactId"] == "artifact_test"
    assert serialized["projectId"] == "project_test"
    assert serialized["taskId"] == "task_test"
    assert serialized["versionNumber"] == 6
    assert serialized["contentRef"]["artifactId"] == "artifact_test"
    assert serialized["parentVersionId"] == "artifact_version_parent"
    assert serialized["changeReason"] == "alias output"
    assert serialized["createdBy"] == "pm-1"
    assert serialized["storeRef"] == "artifact-store/project_test/evidence.txt"
    assert serialized["createdAt"] == NOW.isoformat().replace("+00:00", "Z")
    assert "artifact_id" not in serialized
    assert "project_id" not in serialized
    assert "version" not in serialized
    assert "content_ref" not in serialized


def test_all_task2_entities_have_forbid_extra_and_project_scope():
    models = [
        Artifact(
            id="artifact_test",
            project_id="project_test",
            name="报告",
            artifact_type="report",
            owner_role="pm",
            status="created",
            created_at=NOW,
            created_by="pm-1",
        ),
        ArtifactVersion(
            id="artifact_version_test",
            artifact_id="artifact_test",
            project_id="project_test",
            version=1,
            change_reason="初版",
            content_ref=ArtifactRef(
                artifact_id="artifact_test",
                sha256=SHA,
                media_type="text/plain",
                size=16,
                created_at=NOW,
                relative_path="project_test/evidence.txt",
            ),
            created_at=NOW,
            created_by="pm-1",
        ),
        Approval(
            id="approval_test",
            project_id="project_test",
            approval_type="prd",
            subject_type="artifact_version",
            subject_id="artifact_version_test",
            boss_id="boss-local",
            status="pending",
            created_at=NOW,
            version=1,
        ),
        Review(
            id="review_test",
            project_id="project_test",
            artifact_version_id="artifact_version_test",
            reviewer_role="developer_representative",
            reviewer_id="dev-lead",
            decision="approved",
            comments="通过",
            created_at=NOW,
            version=1,
        ),
        TestCase(
            id="test_case_test",
            project_id="project_test",
            acceptance_criteria=("AC-01",),
            preconditions=("应用已启动",),
            steps=("执行测试",),
            expected_result="通过",
            test_type="unit",
            owner_role="tester",
            created_at=NOW,
            version=1,
        ),
        TestRun(
            id="test_run_test",
            project_id="project_test",
            test_case_id="test_case_test",
            command_or_steps="pytest",
            environment={"python": "3.12"},
            started_at=NOW,
            actual_result="passed",
            exit_code=0,
            status="passed",
            trace_id="trace_test",
            version=1,
        ),
        Defect(
            id="defect_test",
            project_id="project_test",
            source_test_run_id="test_run_test",
            reproduction="重现步骤",
            severity="P1",
            actual_result="失败",
            expected_result="通过",
            npi_owner_role="npi_backend",
            status="open",
            created_at=NOW,
            version=1,
        ),
        ExecutionAttempt(
            id="attempt_test",
            project_id="project_test",
            task_id="task_test",
            role="backend_developer",
            model_config_version="model-config-v1",
            status="created",
            started_at=NOW,
            retry_count=0,
            trace_id="trace_test",
            version=1,
        ),
        ModelCall(
            id="model_call_test",
            project_id="project_test",
            execution_attempt_id="attempt_test",
            role="backend_developer",
            provider="openai",
            model="configured-model",
            started_at=NOW,
            summary="生成结构化计划摘要",
            input_tokens=10,
            output_tokens=20,
            cost_micros=3,
            trace_id="trace_test",
            version=1,
        ),
        ToolCall(
            id="tool_call_test",
            project_id="project_test",
            execution_attempt_id="attempt_test",
            role="backend_developer",
            tool_name="run_verification",
            started_at=NOW,
            summary="运行领域单元测试",
            trace_id="trace_test",
            version=1,
        ),
        Notification(
            id="notification_test",
            project_id="project_test",
            event_id="event_test",
            notification_type="approval_required",
            severity="P0",
            subject_type="approval",
            subject_id="approval_test",
            created_at=NOW,
            version=1,
        ),
        TraceLink(
            id="trace_link_test",
            project_id="project_test",
            source_type="acceptance_criterion",
            source_id="AC-01",
            target_type="task",
            target_id="task_test",
            relation="verifies",
            trace_id="trace_test",
            created_at=NOW,
            version=1,
        ),
    ]

    assert all(model.model_config["extra"] == "forbid" for model in models)
    for model in models:
        with pytest.raises(ValidationError):
            model.__class__(**model.model_dump(), unexpected_field="nope")


@pytest.mark.parametrize(
    "model_type, field_name",
    [
        (ModelCall, "cost_micros"),
        (ToolCall, "duration_ms"),
        (ExecutionAttempt, "retry_count"),
    ],
)
def test_numeric_contracts_reject_negative_values(model_type, field_name):
    base = {
        "id": "object_test",
        "project_id": "project_test",
        "execution_attempt_id": "attempt_test",
        "role": "developer",
        "provider": "openai",
        "model": "configured-model",
        "started_at": NOW,
        "summary": "safe summary",
        "trace_id": "trace_test",
    }
    if model_type is ToolCall:
        base = {
            "id": "tool_call_test",
            "project_id": "project_test",
            "execution_attempt_id": "attempt_test",
            "role": "developer",
            "tool_name": "read_file",
            "started_at": NOW,
            "summary": "safe summary",
            "trace_id": "trace_test",
        }
    if model_type is ExecutionAttempt:
        base = {
            "id": "attempt_test",
            "project_id": "project_test",
            "task_id": "task_test",
            "role": "developer",
            "model_config_version": "model-v1",
            "status": "created",
            "started_at": NOW,
            "trace_id": "trace_test",
        }
    base[field_name] = -1

    with pytest.raises(ValidationError):
        model_type(**base)


@pytest.mark.parametrize(
    "unsafe_summary",
    ["Authorization: Bearer secret-token", "sk-proj-secret", "token=secret-token"],
)
def test_model_and_tool_calls_reject_sensitive_fields_and_prompt_content(unsafe_summary):
    common = {
        "id": "model_call_test",
        "project_id": "project_test",
        "execution_attempt_id": "attempt_test",
        "role": "developer",
        "provider": "openai",
        "model": "configured-model",
        "started_at": NOW,
        "summary": "safe summary",
        "trace_id": "trace_test",
    }
    with pytest.raises(ValidationError):
        ModelCall(**common, api_key="sk-secret")
    with pytest.raises(ValidationError):
        ModelCall(**{**common, "summary": unsafe_summary})

    tool = {
        "id": "tool_call_test",
        "project_id": "project_test",
        "execution_attempt_id": "attempt_test",
        "role": "developer",
        "tool_name": "read_file",
        "started_at": NOW,
        "summary": "safe summary",
        "trace_id": "trace_test",
    }
    with pytest.raises(ValidationError):
        ToolCall(**tool, full_prompt="do not persist")


def test_event_payload_and_structured_summaries_reuse_sensitive_checks():
    base = {
        "event_type": "TaskCreated",
        "aggregate_type": "task",
        "aggregate_id": "task_test",
        "aggregate_version": 1,
        "occurred_at": NOW,
        "trace_id": "trace_test",
    }

    with pytest.raises(ValidationError):
        DomainEventDraft(**base, input_summary={"raw": "sk-proj-secret"})
    with pytest.raises(ValidationError):
        DomainEventDraft(**base, output_summary={"raw": "token=secret-token"})
    with pytest.raises(ValidationError):
        DomainEventDraft(**base, payload={"nested": {"raw": "token=secret-token"}})


def test_domain_event_payload_and_structured_summaries_are_deeply_immutable():
    draft = DomainEventDraft(
        event_type="TaskCreated",
        aggregate_type="task",
        aggregate_id="task_test",
        aggregate_version=1,
        occurred_at=NOW,
        trace_id="trace_test",
        payload={"nested": {"value": "payload", "items": [{"value": "item"}]}},
        input_summary={"nested": {"value": "input"}},
        output_summary={"nested": {"value": "output"}},
    )

    for value in (draft.payload, draft.input_summary, draft.output_summary):
        with pytest.raises(TypeError):
            value["nested"]["value"] = "changed"
    with pytest.raises(TypeError):
        draft.payload["nested"]["items"][0]["value"] = "changed"
    with pytest.raises((TypeError, ValidationError)):
        draft.payload |= {"new": "must not persist"}
    assert "new" not in draft.payload

    event = DomainEvent(
        event_id="event_test",
        **draft.model_dump(),
    )
    with pytest.raises(TypeError):
        event.payload["nested"]["value"] = "changed"
    with pytest.raises(TypeError):
        event.input_summary["nested"]["value"] = "changed"


def test_append_result_validates_empty_event_version_sequence():
    with pytest.raises(ValidationError):
        AppendResult(
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=1,
            aggregate_version=2,
            events=(),
        )


def test_domain_event_draft_and_event_are_immutable_and_traceable():
    draft = DomainEventDraft(
        event_type="TaskCreated",
        aggregate_type="task",
        aggregate_id="task_test",
        aggregate_version=1,
        occurred_at=NOW,
        duration_ms=0,
        actor=Actor(type="developer", id="dev-1"),
        input_summary="创建任务",
        output_summary="任务已建立",
        result="success",
        failure=None,
        retry_count=0,
        trace_id="trace_test",
        payload={"taskId": "task_test"},
    )
    event = DomainEvent(event_id="event_test", global_sequence=1, **draft.model_dump())

    assert event.aggregate_id == "task_test"
    with pytest.raises(ValidationError):
        event.result = "changed"


def test_domain_event_draft_accepts_and_serializes_bima_camel_case_boundary():
    draft = DomainEventDraft(
        eventType="TaskCreated",
        aggregateType="task",
        aggregateId="task_test",
        aggregateVersion=1,
        occurredAt=NOW,
        traceId="trace_test",
    )

    assert draft.event_type == "TaskCreated"
    assert draft.aggregate_type == "task"
    assert draft.aggregate_id == "task_test"
    assert draft.aggregate_version == 1
    assert draft.occurred_at == NOW
    assert draft.trace_id == "trace_test"

    serialized = draft.model_dump(mode="json", by_alias=True)
    assert serialized["eventType"] == "TaskCreated"
    assert serialized["aggregateType"] == "task"
    assert serialized["aggregateId"] == "task_test"
    assert serialized["aggregateVersion"] == 1
    assert datetime.fromisoformat(serialized["occurredAt"].replace("Z", "+00:00")) == NOW
    assert serialized["traceId"] == "trace_test"
    assert "event_type" not in serialized


@pytest.mark.parametrize(
    "event_type,event_category",
    [("InvocationCompleted", "call"), ("PolicyUpdated", "security")],
)
def test_registered_or_explicit_context_event_requires_attempt_actor_and_reasons(
    event_type, event_category
):
    event = DomainEvent(
        eventId="event_security_test",
        eventType=event_type,
        eventCategory=event_category,
        aggregateType="task",
        aggregateId="task_test",
        aggregateVersion=1,
        attemptId="attempt_test",
        actor={"type": "system", "id": "policy-gateway"},
        rejectionReason="policy denied an unauthorized operation",
        redactionReason="credential-shaped output was removed",
        occurredAt=NOW,
        traceId="trace_test",
    )

    assert event.attempt_id == "attempt_test"
    assert event.event_category == event_category
    assert event.rejection_reason == "policy denied an unauthorized operation"
    assert event.redaction_reason == "credential-shaped output was removed"
    serialized = event.model_dump(mode="json", by_alias=True)
    assert serialized["attemptId"] == "attempt_test"
    assert serialized["eventCategory"] == event_category
    assert serialized["rejectionReason"] == "policy denied an unauthorized operation"
    assert serialized["redactionReason"] == "credential-shaped output was removed"


@pytest.mark.parametrize(
    "missing_field",
    ["attemptId", "actor", "rejectionReason", "redactionReason"],
)
def test_registered_invocation_event_rejects_missing_required_context(missing_field):
    values = {
        "eventType": "InvocationCompleted",
        "aggregateType": "task",
        "aggregateId": "task_test",
        "aggregateVersion": 1,
        "attemptId": "attempt_test",
        "actor": {"type": "system", "id": "policy-gateway"},
        "rejectionReason": "policy denied an unauthorized operation",
        "redactionReason": "credential-shaped output was removed",
        "occurredAt": NOW,
        "traceId": "trace_test",
    }
    values.pop(missing_field)

    with pytest.raises(ValidationError):
        DomainEventDraft(**values)


@pytest.mark.parametrize("event_type", ["PolicyUpdated", "TaskCreated"])
def test_ordinary_event_remains_compatible_without_attempt_or_reasons(event_type):
    event = DomainEventDraft(
        eventType=event_type,
        aggregateType="task",
        aggregateId="task_test",
        aggregateVersion=1,
        occurredAt=NOW,
        traceId="trace_test",
    )

    assert event.event_category == "ordinary"
    assert event.attempt_id is None
    assert event.rejection_reason is None
    assert event.redaction_reason is None


@pytest.mark.parametrize("unsafe_reason", ["sk-proj-secret", "token=secret-token"])
def test_marked_event_reasons_use_safe_summary_validation(unsafe_reason):
    with pytest.raises(ValidationError):
        DomainEventDraft(
            eventType="ToolCallSecurityBlocked",
            aggregateType="task",
            aggregateId="task_test",
            aggregateVersion=1,
            attemptId="attempt_test",
            actor={"type": "system", "id": "policy-gateway"},
            rejectionReason=unsafe_reason,
            redactionReason="safe redaction reason",
            occurredAt=NOW,
            traceId="trace_test",
        )
