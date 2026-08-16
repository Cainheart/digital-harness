from tests.support.database import set_revision_for_test
from app.infra.database import Database


def test_unknown_revision_blocks_writable_start_without_mutating_database(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    set_revision_for_test(database, "9999_future_revision")
    before = database.file_digest()

    result = database.check_schema()

    assert result.writable is False
    assert result.code == "VERSION_CONFLICT"
    assert database.file_digest() == before
