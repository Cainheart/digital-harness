from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from app.domain.common import utc_now
from app.domain.entities import Artifact, ArtifactRef, ArtifactVersion
from app.infra.artifacts import FileArtifactStore
from app.infra.database import Database
from app.infra.repositories.evidence import EvidenceRepository
from app.infra.task2_schema import artifact_versions, artifacts, projects


def _database(tmp_path: Path) -> Database:
    database = Database(tmp_path / "company.db")
    database.initialize()
    with database.transaction() as connection:
        connection.execute(
            projects.insert().values(
                id="project_test",
                name="测试项目",
                business_goal="验证证据持久化",
                target_users="本地 Boss",
                priority="P0",
                deadline=None,
                constraints_json="{}",
                stage="验证",
                status="运行中",
                created_at=utc_now(),
                version=1,
                read_only=False,
            )
        )
    return database


@pytest.mark.asyncio
async def test_artifact_store_uses_sha256_addressed_path_and_round_trips(tmp_path: Path):
    store = FileArtifactStore(tmp_path / "artifacts", max_size_bytes=1024)

    reference = await store.put(
        b"evidence",
        media_type="text/plain",
        metadata={"projectId": "project_test", "kind": "test-output"},
    )

    assert reference.relative_path == (
        f"project_test/sha256/{reference.sha256[:2]}/{reference.sha256}"
    )
    assert (store.root / reference.relative_path).is_file()
    assert await store.get(reference) == b"evidence"


@pytest.mark.asyncio
async def test_artifact_store_rejects_tampering_size_and_invalid_reference(tmp_path: Path):
    store = FileArtifactStore(tmp_path / "artifacts", max_size_bytes=4)
    reference = await store.put(
        b"data", media_type="text/plain", metadata={"projectId": "project_test"}
    )
    (store.root / reference.relative_path).write_bytes(b"changed")

    verification = await store.verify(reference)

    assert verification.valid is False
    assert verification.reason in {"sha256 mismatch", "size mismatch"}
    with pytest.raises(ValueError, match="size"):
        await store.put(
            b"12345", media_type="text/plain", metadata={"projectId": "project_test"}
        )
    with pytest.raises(ValueError, match="root|reference"):
        await store.get(
            reference.__class__(
                artifact_id=reference.artifact_id,
                sha256=reference.sha256,
                media_type=reference.media_type,
                size=reference.size,
                created_at=reference.created_at,
                relative_path="../outside",
            )
        )


def test_artifact_versions_are_append_only_and_keep_v1_content(tmp_path: Path):
    database = _database(tmp_path)
    store = FileArtifactStore(tmp_path / "artifacts")
    repository = EvidenceRepository()
    now = utc_now()
    import asyncio

    v1_ref = asyncio.run(
        store.put(b"v1", media_type="text/plain", metadata={"projectId": "project_test"})
    )
    v2_ref = asyncio.run(
        store.put(b"v2", media_type="text/plain", metadata={"projectId": "project_test"})
    )
    artifact = Artifact(
        id="artifact_test",
        project_id="project_test",
        name="证据",
        artifact_type="test-output",
        owner_role="agent_b",
        status="active",
        created_at=now,
        created_by="agent_b",
    )
    version_one = ArtifactVersion(
        id="artifact_version_v1",
        artifactId=artifact.id,
        projectId=artifact.project_id,
        versionNumber=1,
        contentRef=ArtifactRef(
            artifactId=artifact.id, sha256=v1_ref.sha256, mediaType=v1_ref.media_type,
            size=v1_ref.size, createdAt=v1_ref.created_at, relativePath=v1_ref.relative_path,
        ),
        changeReason="初版",
        createdAt=now,
        createdBy="agent_b",
    )
    version_two = ArtifactVersion(
        id="artifact_version_v2",
        artifactId=artifact.id,
        projectId=artifact.project_id,
        versionNumber=2,
        parentVersionId=version_one.id,
        contentRef=ArtifactRef(
            artifactId=artifact.id, sha256=v2_ref.sha256, mediaType=v2_ref.media_type,
            size=v2_ref.size, createdAt=v2_ref.created_at, relativePath=v2_ref.relative_path,
        ),
        changeReason="review requested",
        createdAt=now,
        createdBy="agent_b",
    )

    with database.transaction() as connection:
        repository.create_artifact(connection, artifact)
        repository.create_artifact_version(connection, version_one)
        repository.create_artifact_version(connection, version_two)

    with database.read_connection() as connection:
        stored_v1 = repository.get_artifact_version(connection, version_one.id)
        stored_v2 = repository.get_artifact_version(connection, version_two.id)

    assert stored_v1.version_number == 1
    assert stored_v2.version_number == 2
    assert stored_v2.parent_version_id == stored_v1.id
    assert asyncio.run(store.get(stored_v1.content_ref)) == b"v1"
    assert asyncio.run(store.get(stored_v2.content_ref)) == b"v2"
    database.close()


def test_artifact_version_rows_are_immutable_under_direct_sql(tmp_path: Path):
    database = _database(tmp_path)
    now = utc_now()
    with database.transaction() as connection:
        connection.execute(
            artifacts.insert().values(
                id="artifact_immutable", project_id="project_test", task_id=None,
                name="证据", artifact_type="test-output", owner_role="agent_b",
                status="active", created_at=now, created_by="agent_b",
            )
        )
        connection.execute(
            artifact_versions.insert().values(
                id="artifact_version_immutable", artifact_id="artifact_immutable",
                project_id="project_test", task_id=None, version_number=1,
                parent_version_id=None, change_reason="初版", store_ref="ref",
                sha256="0" * 64, media_type="text/plain", size_bytes=0,
                relative_path="project_test/sha256/00/" + "0" * 64,
                created_at=now, created_by="agent_b",
            )
        )
        with pytest.raises(IntegrityError):
            connection.execute(
                artifact_versions.update()
                .where(artifact_versions.c.id == "artifact_version_immutable")
                .values(change_reason="篡改")
            )
        with pytest.raises(IntegrityError):
            connection.execute(
                artifact_versions.delete().where(
                    artifact_versions.c.id == "artifact_version_immutable"
                )
            )
    database.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("symlink_level", ["project", "sha256", "prefix"])
async def test_artifact_store_rejects_symlink_at_every_content_path_level(
    tmp_path: Path, symlink_level: str
):
    store = FileArtifactStore(tmp_path / "artifacts")
    outside_project = store.root / "project_b"
    (outside_project / "sha256" / "ab").mkdir(parents=True)
    payload = b"symlink-protected"
    digest = __import__("hashlib").sha256(payload).hexdigest()
    (outside_project / "sha256" / digest[:2]).mkdir(parents=True)
    (outside_project / "sha256" / digest[:2] / digest).write_bytes(payload)

    project_a = store.root / "project_a"
    project_a.mkdir()
    if symlink_level == "project":
        project_a.rmdir()
        project_a.symlink_to(outside_project, target_is_directory=True)
    elif symlink_level == "sha256":
        (project_a / "sha256").symlink_to(
            outside_project / "sha256", target_is_directory=True
        )
    else:
        (project_a / "sha256").mkdir()
        (project_a / "sha256" / digest[:2]).symlink_to(
            outside_project / "sha256" / digest[:2], target_is_directory=True
        )

    with pytest.raises(ValueError, match="symlink|special|safe"):
        await store.put(
            payload, media_type="text/plain", metadata={"projectId": "project_a"}
        )
    with pytest.raises(ValueError, match="symlink|special|safe"):
        await store.delete_for_project("project_a")
    assert (outside_project / "sha256" / digest[:2] / digest).read_bytes() == payload


def test_artifact_store_rejects_symlink_root(tmp_path: Path):
    real_root = tmp_path / "real-artifacts"
    real_root.mkdir()
    linked_root = tmp_path / "artifacts"
    linked_root.symlink_to(real_root, target_is_directory=True)

    with pytest.raises(ValueError, match="symlink|special|safe"):
        FileArtifactStore(linked_root)


@pytest.mark.asyncio
async def test_artifact_reference_path_must_bind_project_sha_prefix_and_digest(
    tmp_path: Path,
):
    store = FileArtifactStore(tmp_path / "artifacts")
    reference = await store.put(
        b"strict-reference",
        media_type="text/plain",
        metadata={"projectId": "project_test"},
    )

    with pytest.raises(ValueError, match="reference|sha|project|path"):
        await store.get(
            reference.__class__(
                artifact_id=reference.artifact_id,
                sha256=reference.sha256,
                media_type=reference.media_type,
                size=reference.size,
                created_at=reference.created_at,
                relative_path=(
                    f"other_project/sha256/{reference.sha256[:2]}/{reference.sha256}"
                ),
                project_id="project_test",
            )
        )
    with pytest.raises(ValueError, match="reference|sha|project|path"):
        await store.get(
            reference.__class__(
                artifact_id=reference.artifact_id,
                sha256=reference.sha256,
                media_type=reference.media_type,
                size=reference.size,
                created_at=reference.created_at,
                relative_path=(
                    f"project_test/sha256/ff/{reference.sha256}"
                ),
                project_id="project_test",
            )
        )
    verification = await store.verify(
        reference.__class__(
            artifact_id=reference.artifact_id,
            sha256=reference.sha256,
            media_type=reference.media_type,
            size=reference.size,
            created_at=reference.created_at,
            relative_path=f"project_test/sha256/ff/{reference.sha256}",
            project_id="project_test",
        )
    )
    assert verification.valid is False
    assert verification.actual_sha256 is None
    assert verification.reason is not None


@pytest.mark.parametrize("reference_shape", ["wrong_prefix", "wrong_digest", "extra_segment", "store_ref"])
def test_evidence_repository_rejects_non_addressed_artifact_version_references(
    tmp_path: Path, reference_shape: str
):
    database = _database(tmp_path)
    store = FileArtifactStore(tmp_path / "artifacts")
    repository = EvidenceRepository()
    import asyncio

    stored = asyncio.run(
        store.put(b"strict-version", media_type="text/plain", metadata={"projectId": "project_test"})
    )
    canonical = f"project_test/sha256/{stored.sha256[:2]}/{stored.sha256}"
    wrong_prefix = "00" if stored.sha256[:2] != "00" else "11"
    relative_path = {
        "wrong_prefix": f"project_test/sha256/{wrong_prefix}/{stored.sha256}",
        "wrong_digest": f"project_test/sha256/{stored.sha256[:2]}/{'0' * 64}",
        "extra_segment": f"{canonical}/extra",
        "store_ref": canonical,
    }[reference_shape]
    store_ref = "external-store-ref" if reference_shape == "store_ref" else None
    artifact = Artifact(
        id="artifact_path_guard", project_id="project_test", name="路径证据",
        artifact_type="test-output", owner_role="agent_b", status="active",
        created_at=utc_now(), created_by="agent_b",
    )
    version = ArtifactVersion(
        id=f"artifact_version_path_{reference_shape}", artifactId=artifact.id,
        projectId=artifact.project_id, versionNumber=1,
        contentRef=ArtifactRef(
            artifactId=artifact.id, sha256=stored.sha256, mediaType=stored.media_type,
            size=stored.size, createdAt=stored.created_at, relativePath=relative_path,
        ),
        storeRef=store_ref, changeReason="路径校验", createdAt=utc_now(), createdBy="agent_b",
    )

    with database.transaction() as connection:
        repository.create_artifact(connection, artifact)
        with pytest.raises(ValueError, match="content address|reference|path|store_ref"):
            repository.create_artifact_version(connection, version)
    database.close()


def test_artifact_version_verification_marks_tampered_artifact_unavailable(
    tmp_path: Path,
):
    database = _database(tmp_path)
    store = FileArtifactStore(tmp_path / "artifacts")
    repository = EvidenceRepository()
    import asyncio

    stored = asyncio.run(
        store.put(b"verified-content", media_type="text/plain", metadata={"projectId": "project_test"})
    )
    artifact = Artifact(
        id="artifact_verify", project_id="project_test", name="可验证证据",
        artifact_type="test-output", owner_role="agent_b", status="active",
        created_at=utc_now(), created_by="agent_b",
    )
    version = ArtifactVersion(
        id="artifact_version_verify", artifactId=artifact.id, projectId=artifact.project_id,
        versionNumber=1,
        contentRef=ArtifactRef(
            artifactId=artifact.id, sha256=stored.sha256, mediaType=stored.media_type,
            size=stored.size, createdAt=stored.created_at, relativePath=stored.relative_path,
        ),
        changeReason="完整性验证", createdAt=utc_now(), createdBy="agent_b",
    )
    with database.transaction() as connection:
        repository.create_artifact(connection, artifact)
        repository.create_artifact_version(connection, version)

    (store.root / stored.relative_path).write_bytes(b"tampered-content")
    with database.transaction() as connection:
        verification = repository.verify_artifact_version(connection, version.id, store)
    assert verification.valid is False

    with database.read_connection() as connection:
        unavailable = repository.get_artifact(connection, artifact.id)
    assert unavailable.status == "unavailable"
    assert unavailable.content_ref is None

    with database.transaction() as connection:
        repeated = repository.verify_artifact_version(connection, version.id, store)
    assert repeated.valid is False
    assert repeated.reason == "artifact is unavailable"
    database.close()
