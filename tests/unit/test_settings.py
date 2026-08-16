from pathlib import Path

import pytest

from app.config.settings import Settings
from app.main import create_app


def test_settings_defaults_to_localhost_and_derives_persistent_paths(tmp_path: Path):
    settings = Settings(persistent_root=tmp_path)

    assert settings.host == "127.0.0.1"
    assert settings.database_path == tmp_path / "company.db"
    assert settings.artifact_path == tmp_path / "artifacts"
    assert settings.trace_path == tmp_path / "traces"
    assert settings.workspace_path == tmp_path / "workspaces"
    assert settings.backup_path == tmp_path / "backups"


def test_settings_rejects_non_localhost_bind_address(tmp_path: Path):
    with pytest.raises(ValueError, match="127.0.0.1"):
        Settings(persistent_root=tmp_path, host="0.0.0.0")


def test_settings_accepts_keychain_model_reference_from_environment(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DIGITAL_HARNESS_MODEL_PROVIDER", "openai")
    monkeypatch.setenv("DIGITAL_HARNESS_MODEL_NAME", "gpt-4o")
    monkeypatch.setenv("DIGITAL_HARNESS_MODEL_SECRET_REF", "keyring://openai/default")

    settings = Settings(persistent_root=tmp_path)

    assert settings.model_provider == "openai"
    assert settings.model_name == "gpt-4o"
    assert settings.model_secret_ref == "keyring://openai/default"


def test_production_app_uses_configured_model_reference(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DIGITAL_HARNESS_MODEL_PROVIDER", "openai")
    monkeypatch.setenv("DIGITAL_HARNESS_MODEL_NAME", "gpt-4o")
    monkeypatch.setenv("DIGITAL_HARNESS_MODEL_SECRET_REF", "keyring://openai/default")

    app = create_app(persistent_root=tmp_path, initialize_runtime=False)
    checker = app.state.readiness.checkers[0]

    assert checker.provider == "openai"
    assert checker.model == "gpt-4o"
    assert checker.secret_ref == "keyring://openai/default"
