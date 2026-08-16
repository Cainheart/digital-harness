from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import text

from app.domain.entities import (
    Approval,
    Artifact,
    ArtifactVersion,
    Defect,
    ExecutionAttempt,
    ModelCall,
    Review,
    TestCase,
    TestRun,
    ToolCall,
)
from app.domain.common import utc_now
from app.domain.errors import ReadOnlyProjectError
from app.infra.database import Database
from app.infra.repositories.evidence import EvidenceRepository
from app.infra.repositories.execution import ExecutionRepository
from app.infra.task2_schema import projects, tasks


def _database(tmp_path: Path) -> Database:
    database = Database(tmp_path / "company.db")
    database.initialize()
    now = utc_now()
    with database.transaction() as connection:
        connection.execute(
            projects.insert().values(
                id="project_test", name="项目", business_goal="目标", target_users="用户",
                priority="P0", deadline=None, constraints_json="{}", stage="验证",
                status="运行中", created_at=now, version=1, read_only=False,
            )
        )
        connection.execute(
            tasks.insert().values(
                id="task_test", project_id="project_test", title="任务", owner_role="agent_b",
                specialist_tag="backend", assignment_reason="测试", priority="P0",
                dependencies_json="[]", expected_deliverables_json="[]", status="进行中",
                created_at=now, version=1,
            )
        )
    return database


def _entities():
    now = utc_now()
    approval = Approval(
        id="approval_test", project_id="project_test", task_id="task_test",
        approval_type="release", subject_type="artifact_version", subject_id="artifact_version_v1",
        evidence_version_id=None, boss_id="boss-local", status="pending", created_at=now, version=1,
    )
    review = Review(
        id="review_test", project_id="project_test", task_id="task_test",
        artifact_version_id="artifact_version_v1", reviewer_role="reviewer", reviewer_id="reviewer-1",
        decision="approved", comments="通过", created_at=now, version=1,
    )
    test_case = TestCase(
        id="test_case_test", project_id="project_test", task_id="task_test",
        acceptance_criteria=("AC-02",), preconditions="数据库已初始化", steps="执行测试",
        expected_result="v1 不被覆盖", test_type="integration", owner_role="agent_b", created_at=now, version=1,
    )
    test_run = TestRun(
        id="test_run_test", project_id="project_test", task_id="task_test", test_case_id=test_case.id,
        command_or_steps="pytest", environment={"python": "3.12"}, started_at=now,
        actual_result="passed", status="passed", trace_id="trace_test", version=1,
    )
    defect = Defect(
        id="defect_test", project_id="project_test", task_id="task_test", source_test_run_id=test_run.id,
        reproduction="重现步骤", severity="P1", actual_result="失败", expected_result="通过",
        npi_owner_role="agent_b", status="open", created_at=now, version=1,
    )
    attempt = ExecutionAttempt(
        id="attempt_test", project_id="project_test", task_id="task_test", role="agent_b",
        model_config_version="model-config-v1", status="completed", started_at=now,
        retry_count=0, trace_id="trace_test", version=1,
    )
    model_call = ModelCall(
        id="model_call_test", project_id="project_test", task_id="task_test",
        execution_attempt_id=attempt.id, role="agent_b", provider="local", model="test-model",
        started_at=now, summary="脱敏摘要", trace_id="trace_test", version=1,
    )
    tool_call = ToolCall(
        id="tool_call_test", project_id="project_test", task_id="task_test",
        execution_attempt_id=attempt.id, role="agent_b", tool_name="pytest", started_at=now,
        summary="运行指定测试", trace_id="trace_test",
    )
    return approval, review, test_case, test_run, defect, attempt, model_call, tool_call


def test_evidence_and_execution_entities_keep_upstream_links(tmp_path: Path):
    database = _database(tmp_path)
    evidence = EvidenceRepository()
    execution = ExecutionRepository()
    approval, review, test_case, test_run, defect, attempt, model_call, tool_call = _entities()

    # Build the minimal artifact-version prerequisite in the same frozen tables.
    with database.transaction() as connection:
        connection.execute(
            text("INSERT INTO artifacts (id, project_id, name, artifact_type, owner_role, status, created_at, created_by) "
            "VALUES ('artifact_test', 'project_test', '证据', 'test-output', 'agent_b', 'active', :now, 'agent_b')",
            ),
            {"now": utc_now()},
        )
        connection.execute(
            text("INSERT INTO artifact_versions (id, artifact_id, project_id, task_id, version_number, parent_version_id, "
            "change_reason, store_ref, sha256, media_type, size_bytes, relative_path, created_at, created_by) "
            "VALUES ('artifact_version_v1', 'artifact_test', 'project_test', 'task_test', 1, NULL, '初版', 'ref', "
            " :sha, 'text/plain', 0, :path, :now, 'agent_b')"),
            {"sha": "0" * 64, "path": "project_test/sha256/00/" + "0" * 64, "now": utc_now()},
        )
    with database.transaction() as connection:
        evidence.create_approval(connection, approval)
        evidence.create_review(connection, review)
        evidence.create_test_case(connection, test_case)
        evidence.create_test_run(connection, test_run)
        evidence.create_defect(connection, defect)
        execution.create_attempt(connection, attempt)
        execution.create_model_call(connection, model_call)
        execution.create_tool_call(connection, tool_call)

    with database.read_connection() as connection:
        assert evidence.get_test_run(connection, test_run.id).test_case_id == test_case.id
        assert evidence.get_defect(connection, defect.id).source_test_run_id == test_run.id
        assert execution.get_model_call(connection, model_call.id).execution_attempt_id == attempt.id
        assert execution.get_tool_call(connection, tool_call.id).tool_name == "pytest"
    database.close()


def test_execution_repository_rejects_credentials_even_if_summary_bypasses_model_validation(tmp_path: Path):
    database = _database(tmp_path)
    execution = ExecutionRepository()
    attempt = _entities()[5]
    with database.transaction() as connection:
        execution.create_attempt(connection, attempt)
        with pytest.raises(ValueError, match="credential"):
            execution.create_model_call(
                connection,
                ModelCall.model_construct(
                    id="model_call_secret", project_id="project_test", task_id="task_test",
                    execution_attempt_id=attempt.id, role="agent_b", provider="local", model="test-model",
                    started_at=utc_now(), summary="api_key=sk-secret", trace_id="trace_test", version=1,
                ),
            )
    database.close()


def test_all_evidence_and_execution_creates_reject_completed_read_only_projects(tmp_path: Path):
    database = _database(tmp_path)
    evidence = EvidenceRepository()
    execution = ExecutionRepository()
    approval, review, test_case, test_run, defect, attempt, model_call, tool_call = _entities()
    with database.transaction() as connection:
        connection.execute(
            projects.update()
            .where(projects.c.id == "project_test")
            .values(status="已结项", read_only=True)
        )
    with database.transaction() as connection:
        for operation in (
            lambda: evidence.create_artifact(connection, __import__("app.domain.entities", fromlist=["Artifact"]).Artifact(
                id="artifact_read_only", project_id="project_test", name="证据",
                artifact_type="test-output", owner_role="agent_b", status="active",
                created_at=utc_now(), created_by="agent_b",
            )),
            lambda: evidence.create_artifact_version(connection, __import__("app.domain.entities", fromlist=["ArtifactVersion"]).ArtifactVersion(
                id="artifact_version_read_only", artifactId="artifact_read_only",
                projectId="project_test", versionNumber=1,
                contentRef={"artifactId": "artifact_read_only", "sha256": "0" * 64,
                    "mediaType": "text/plain", "size": 0, "createdAt": utc_now(),
                    "relativePath": "project_test/sha256/00/" + "0" * 64},
                changeReason="初版", createdAt=utc_now(), createdBy="agent_b",
            )),
            lambda: evidence.create_approval(connection, approval),
            lambda: evidence.create_review(connection, review),
            lambda: evidence.create_test_case(connection, test_case),
            lambda: evidence.create_test_run(connection, test_run),
            lambda: evidence.create_defect(connection, defect),
            lambda: execution.create_attempt(connection, attempt),
            lambda: execution.create_model_call(connection, model_call),
            lambda: execution.create_tool_call(connection, tool_call),
        ):
            with pytest.raises(ReadOnlyProjectError):
                operation()
    database.close()


def test_all_evidence_and_execution_creates_reject_active_read_only_projects(tmp_path: Path):
    database = _database(tmp_path)
    evidence = EvidenceRepository()
    execution = ExecutionRepository()
    approval, review, test_case, test_run, defect, attempt, model_call, tool_call = _entities()
    with database.transaction() as connection:
        connection.execute(
            projects.update()
            .where(projects.c.id == "project_test")
            .values(read_only=True)
        )
    with database.transaction() as connection:
        for operation in (
            lambda: evidence.create_artifact(connection, Artifact(
                id="artifact_active_read_only", project_id="project_test", name="证据",
                artifact_type="test-output", owner_role="agent_b", status="active",
                created_at=utc_now(), created_by="agent_b",
            )),
            lambda: evidence.create_artifact_version(connection, ArtifactVersion(
                id="artifact_version_active_read_only", artifactId="artifact_active_read_only",
                projectId="project_test", versionNumber=1,
                contentRef={"artifactId": "artifact_active_read_only", "sha256": "0" * 64,
                    "mediaType": "text/plain", "size": 0, "createdAt": utc_now(),
                    "relativePath": "project_test/sha256/00/" + "0" * 64},
                changeReason="初版", createdAt=utc_now(), createdBy="agent_b",
            )),
            lambda: evidence.create_approval(connection, approval),
            lambda: evidence.create_review(connection, review),
            lambda: evidence.create_test_case(connection, test_case),
            lambda: evidence.create_test_run(connection, test_run),
            lambda: evidence.create_defect(connection, defect),
            lambda: execution.create_attempt(connection, attempt),
            lambda: execution.create_model_call(connection, model_call),
            lambda: execution.create_tool_call(connection, tool_call),
        ):
            with pytest.raises(ReadOnlyProjectError):
                operation()
    database.close()
