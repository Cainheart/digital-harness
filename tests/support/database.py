"""为测试构造 revision/Task 1 数据的最小内部迁移 helper。"""

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import text
from sqlalchemy.engine import Connection


@contextmanager
def migration_connection(database) -> Iterator[Connection]:
    """测试专用写连接，复用 Database 的内部 Alembic migration capability。"""
    with database._migration_connection() as connection:
        yield connection


def set_revision_for_test(database, revision: str) -> None:
    """仅在测试中注入 unknown/future revision，不作为生产 API。"""
    with migration_connection(database) as connection:
        connection.execute(
            text("UPDATE alembic_version SET version_num = :revision"),
            {"revision": revision},
        )
