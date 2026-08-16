import pytest

from app.infra.database import Database
from app.infra.keychain import MemoryCredentialAdapter
from app.security.audit import AuditWriter


@pytest.mark.asyncio
async def test_credentials_store_plaintext_only_in_memory_adapter(tmp_path):
    adapter = MemoryCredentialAdapter()
    database = Database(tmp_path / "company.db")
    database.initialize()
    secret = "sk-test-task1-DoNotPersist"

    secret_ref = await adapter.save("openai", secret)
    database.save_credential_config("openai", "gpt-test", secret_ref)

    raw_database = b"".join(
        path.read_bytes()
        for path in (
            tmp_path / "company.db",
            tmp_path / "company.db-wal",
            tmp_path / "company.db-shm",
        )
        if path.exists()
    )
    assert secret.encode() not in raw_database
    assert secret_ref.encode() in raw_database
    assert secret == (await adapter.read(secret_ref)).value


@pytest.mark.asyncio
async def test_check_returns_status_without_returning_secret(tmp_path):
    adapter = MemoryCredentialAdapter()
    secret_ref = await adapter.save("deepseek", "sk-test-private")

    result = await adapter.check(secret_ref)

    assert result.available is True
    assert result.secret_ref == secret_ref
    assert not hasattr(result, "secret")


@pytest.mark.asyncio
async def test_audit_writer_redacts_secret_like_metadata(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    writer = AuditWriter(database)

    await writer.write(
        trace_id="tr-credential",
        event_type="CredentialCheckFailed",
        result="blocked",
        metadata={"error": "Bearer private-token"},
    )

    event_text = database.read_event_text()
    assert "private-token" not in event_text
    assert "[REDACTED]" in event_text
