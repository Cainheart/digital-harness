from __future__ import annotations

from app.api.errors import RuntimeBoundaryError
from app.infra.database import Database
from app.readiness.models import CheckStatus, CheckView


class PersistenceReadinessChecker:
    """检查数据库 Schema 兼容性和 SQLite WAL 持久化能力。"""

    name = "persistence"

    def __init__(self, database: Database) -> None:
        """绑定数据库；兼容基线由 Database 的唯一常量决定。"""
        self.database = database

    async def check(self) -> CheckView:
        """执行数据库版本与 journal mode 检查，不修改业务数据。"""
        try:
            schema = self.database.check_schema()
            journal_mode = self.database.journal_mode() if schema.writable else "blocked-read-only"
            details = {
                "journalMode": journal_mode,
                "schemaRevision": schema.revision,
                "persistentRoot": "configured",
            }
        except RuntimeBoundaryError as error:
            return CheckView(
                status=CheckStatus.BLOCKED,
                message=error.message,
                code=error.code,
                impact=error.impact,
                dataPreserved=error.data_preserved,
                schemaRevision=error.schema_revision,
                nextAction=error.next_action,
                details={"persistentRoot": "configured"},
            )
        if not schema.writable or journal_mode != "wal":
            return CheckView(
                status=CheckStatus.BLOCKED,
                message=schema.message if not schema.writable else "SQLite WAL 未启用",
                code=schema.code if not schema.writable else "PERSISTENCE_UNAVAILABLE",
                impact="业务数据无法安全持久化",
                dataPreserved=schema.data_preserved,
                schemaRevision=schema.revision,
                nextAction=schema.next_action or "检查 SQLite 数据库和持久化根目录",
                details=details,
            )
        return CheckView(
            status=CheckStatus.READY,
            message="持久化根目录和数据库可用",
            schemaRevision=schema.revision,
            details=details,
        )
