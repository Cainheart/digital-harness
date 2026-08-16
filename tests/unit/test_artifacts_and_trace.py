from pathlib import Path

import pytest

from app.infra.artifacts import FileArtifactStore
from app.observability.trace import TraceContext


def test_trace_context_child_keeps_parent_link():
    root = TraceContext.new()

    child = root.child()

    assert root.trace_id
    assert root.span_id
    assert child.trace_id == root.trace_id
    assert child.span_id != root.span_id
    assert child.parent_span_id == root.span_id


@pytest.mark.asyncio
async def test_artifact_store_round_trips_and_verifies_sha256(tmp_path: Path):
    store = FileArtifactStore(tmp_path / "artifacts")

    reference = await store.put(
        b"approved evidence",
        media_type="text/plain",
        metadata={"projectId": "project-1", "kind": "test-output"},
    )
    content = await store.get(reference)
    verification = await store.verify(reference)

    assert content == b"approved evidence"
    assert reference.size == len(content)
    assert len(reference.sha256) == 64
    assert verification.valid is True


@pytest.mark.asyncio
async def test_artifact_store_rejects_project_path_traversal(tmp_path: Path):
    store = FileArtifactStore(tmp_path / "artifacts")

    with pytest.raises(ValueError, match="projectId"):
        await store.put(
            b"evidence",
            media_type="text/plain",
            metadata={"projectId": "../outside"},
        )


def test_application_runtime_exposes_artifact_store_and_trace_factory(tmp_path: Path):
    from app.bootstrap.application import build_runtime

    runtime = build_runtime(tmp_path)

    assert isinstance(runtime.artifact_store, FileArtifactStore)
    assert runtime.trace_context_factory().trace_id
    runtime.database.close()
