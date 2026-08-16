import json
from pathlib import Path

from app.infra.persistence_root import PersistenceRoot


def test_initialize_creates_task1_data_boundaries(tmp_path: Path):
    root = PersistenceRoot(
        tmp_path,
        app_version="0.1.0",
        # 修改说明：Task 2 Schema 基线统一为 0002，同时保护 Task 1 持久化目录行为。
        schema_revision="0002_task2_domain_foundation",
    )

    manifest = root.initialize()

    for name in ("artifacts", "traces", "workspaces", "backups"):
        assert (tmp_path / name).is_dir()
    assert (tmp_path / "manifest.json").is_file()
    # 修改说明：Task 2 Schema 基线升级到 0002，保护 Task 1 manifest 生成行为。
    assert manifest["schemaRevision"] == "0002_task2_domain_foundation"
    assert "secret" not in (tmp_path / "manifest.json").read_text()


def test_initialize_is_idempotent_and_does_not_move_existing_database(tmp_path: Path):
    database = tmp_path / "company.db"
    database.write_bytes(b"existing")
    root = PersistenceRoot(
        tmp_path,
        app_version="0.1.0",
        # 修改说明：Task 2 Schema 基线统一为 0002，同时保护 Task 1 manifest 幂等行为。
        schema_revision="0002_task2_domain_foundation",
    )

    root.initialize()
    before_manifest = (tmp_path / "manifest.json").read_bytes()
    root.initialize()

    assert database.read_bytes() == b"existing"
    assert (tmp_path / "manifest.json").read_bytes() == before_manifest


def test_manifest_is_valid_json_and_lists_only_persistent_data_directories(tmp_path: Path):
    root = PersistenceRoot(
        tmp_path,
        app_version="0.1.0",
        # 修改说明：Task 2 Schema 基线统一为 0002，同时保护 Task 1 manifest 目录合同。
        schema_revision="0002_task2_domain_foundation",
    )

    root.initialize()

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["directories"] == ["artifacts", "traces", "workspaces", "backups"]
    assert "credentials" not in manifest["directories"]
