"""Task 2 的 SQLite 工作单元边界。"""

from __future__ import annotations

from types import TracebackType
from sqlalchemy.engine import Connection

from app.infra.database import Database


class UnitOfWork:
    """把一组领域状态、事件、Outbox 和幂等写入绑定到一个事务。"""

    def __init__(self, database: Database) -> None:
        """绑定 Database，但延迟打开连接，避免构造阶段产生写副作用。"""
        self.database = database
        self.connection: Connection | None = None
        self._transaction_context = None

    # 修改说明：开发工作区仍提供 Python 3.9 的 .venv，使用字符串前向注解保持
    # 测试工具可导入；运行时正式基线仍由 backend/pyproject.toml 声明为 Python 3.12。
    def __enter__(self) -> "UnitOfWork":
        """打开 Database 提供的 SQLite 事务，并把同一连接交给全部仓储。"""
        self._transaction_context = self.database.transaction()
        try:
            self.connection = self._transaction_context.__enter__()
        except BaseException:
            self._transaction_context = None
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        """无异常提交、异常回滚，并始终释放连接；异常继续向调用方传播。"""
        transaction_context = self._transaction_context
        try:
            if transaction_context is not None:
                transaction_context.__exit__(exc_type, exc, traceback)
        finally:
            self.connection = None
            self._transaction_context = None
        return False


class AsyncUnitOfWork:
    """为异步领域服务提供 async with 外观，内部仍复用同步 SQLite UnitOfWork。"""

    def __init__(self, database: Database) -> None:
        """绑定 Database，并延迟创建同步工作单元直到 async with 进入。"""
        self.database = database
        self.connection: Connection | None = None
        self._sync_unit: UnitOfWork | None = None

    async def __aenter__(self) -> "AsyncUnitOfWork":
        """进入同步事务并暴露同一连接，供 await 适配器使用。"""
        self._sync_unit = UnitOfWork(self.database)
        self._sync_unit.__enter__()
        self.connection = self._sync_unit.connection
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        """把异步上下文的异常交给同步工作单元执行提交或回滚。"""
        sync_unit = self._sync_unit
        try:
            if sync_unit is not None:
                return sync_unit.__exit__(exc_type, exc, traceback)
            return False
        finally:
            self.connection = None
            self._sync_unit = None
