"""Task 2 命令级事务协调，不包含 API、SSE 或工作流状态机。"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Sequence
from typing import Any

from sqlalchemy.engine import Connection

from app.domain.commands import CommandEnvelope, CommandResult, canonical_request_hash
from app.domain.common import new_object_id, utc_now
from app.domain.errors import InvalidArgumentError, VersionConflictError
from app.domain.events import AppendResult, DomainEventDraft
from app.infra.repositories.events import SqliteEventStore
from app.infra.repositories.idempotency import IdempotencyRecord, SqliteIdempotencyRepository
from app.infra.repositories._common import ensure_project_writable
from app.infra.repositories.project_task import ProjectTaskRepository
from app.infra.transactions import UnitOfWork


Callback = Callable[..., Any]


class Task2CommandService:
    """固定幂等、版本、状态、事件、元数据和结果提交顺序的 Task 2 命令服务。"""

    def __init__(
        self,
        database,
        *,
        project_task_repository: ProjectTaskRepository | None = None,
        event_store: SqliteEventStore | None = None,
        idempotency_repository: SqliteIdempotencyRepository | None = None,
    ) -> None:
        """注入低层仓储；服务本身不创建 API 或推进业务工作流。"""
        self.database = database
        self.project_task_repository = project_task_repository or ProjectTaskRepository()
        self.event_store = event_store or SqliteEventStore()
        self.idempotency_repository = idempotency_repository or SqliteIdempotencyRepository()

    def execute(
        self,
        command: CommandEnvelope,
        *,
        aggregate_type: str,
        state_writer: Callback,
        event_drafts: Sequence[DomainEventDraft] | Callback | None = None,
        events: Sequence[DomainEventDraft] | Callback | None = None,
        metadata_writer: Callback | None = None,
        trace_artifact_writer: Callback | None = None,
        result_factory: Callback | None = None,
    ) -> CommandResult:
        """在一个 UnitOfWork 中完成命令，并让任意后续异常整体回滚。"""
        if event_drafts is not None and events is not None:
            raise InvalidArgumentError(message="provide event_drafts or events, not both")
        drafts_source = event_drafts if event_drafts is not None else events
        if drafts_source is None:
            raise InvalidArgumentError(message="event_drafts are required")
        if metadata_writer is not None and trace_artifact_writer is not None:
            raise InvalidArgumentError(message="provide metadata_writer or trace_artifact_writer, not both")
        metadata_callback = metadata_writer or trace_artifact_writer
        request_hash = canonical_request_hash(command)

        with UnitOfWork(self.database) as unit:
            connection = unit.connection
            existing = self.idempotency_repository.get(connection, command.idempotency_key)
            if existing is not None:
                return self.idempotency_repository.assert_reusable(
                    existing,
                    request_hash,
                    trace_id=f"trace_{command.command_id}",
                )

            self._check_expected_version_and_project_scope(connection, command, aggregate_type)
            state_result = state_writer(connection)
            drafts = self._resolve_drafts(drafts_source, connection, state_result)
            appended = self.event_store.append(
                connection,
                aggregate_type=aggregate_type,
                aggregate_id=command.aggregate_id,
                expected_version=command.expected_version,
                events=drafts,
            )
            if not appended.events:
                raise InvalidArgumentError(message="a command must append at least one domain event")
            if metadata_callback is not None:
                self._call_callback(metadata_callback, ((connection, state_result, appended), (connection,)))
            command_result = self._make_result(command, appended, state_result, result_factory)
            project_id = self._project_id_after_write(connection, aggregate_type, command.aggregate_id)
            self.idempotency_repository.save(
                connection,
                IdempotencyRecord(
                    id=new_object_id("idempotency"),
                    project_id=project_id,
                    idempotency_key=command.idempotency_key,
                    command_id=command.command_id,
                    aggregate_type=aggregate_type,
                    aggregate_id=command.aggregate_id,
                    request_hash=request_hash,
                    command_result=command_result,
                    event_id=command_result.event_id,
                    created_at=utc_now(),
                ),
            )
            return command_result

    def _check_expected_version_and_project_scope(
        self,
        connection: Connection,
        command: CommandEnvelope,
        aggregate_type: str,
    ) -> None:
        """在状态 callback 前校验已知聚合版本和项目只读边界。"""
        if aggregate_type == "project":
            current = self.project_task_repository.find_project(connection, command.aggregate_id)
            if current is None:
                if command.expected_version != 0:
                    raise VersionConflictError(
                        data={"aggregateType": aggregate_type, "aggregateId": command.aggregate_id, "expectedVersion": command.expected_version, "actualVersion": 0}
                    )
                return
            self._check_current(connection, current.id, current.version, command)
            return
        if aggregate_type == "task":
            current_task = self.project_task_repository.find_task(connection, command.aggregate_id)
            if current_task is None:
                if command.expected_version != 0:
                    raise VersionConflictError(
                        data={"aggregateType": aggregate_type, "aggregateId": command.aggregate_id, "expectedVersion": command.expected_version, "actualVersion": 0}
                    )
                return
            project = self.project_task_repository.get_project(connection, current_task.project_id)
            self._check_current(connection, project.id, current_task.version, command)
            return
        raise InvalidArgumentError(message="unsupported aggregate type")

    @staticmethod
    def _check_current(
        connection: Connection,
        project_id: str,
        version: int,
        command: CommandEnvelope,
    ) -> None:
        """复用统一项目生命周期保护，再校验命令 expectedVersion。"""
        ensure_project_writable(connection, project_id)
        if version != command.expected_version:
            raise VersionConflictError(
                data={"aggregateId": command.aggregate_id, "expectedVersion": command.expected_version, "actualVersion": version}
            )

    def _resolve_drafts(self, source: Sequence[DomainEventDraft] | Callback, connection: Connection, state_result: Any) -> tuple[DomainEventDraft, ...]:
        """解析静态或依赖状态结果的事件草稿 callback。"""
        value = self._call_callback(source, ((state_result,), (connection, state_result), ())) if callable(source) else source
        return tuple(value)

    def _project_id_after_write(self, connection: Connection, aggregate_type: str, aggregate_id: str) -> str | None:
        """从状态写入后的对象恢复幂等记录项目范围。"""
        if aggregate_type == "project":
            return aggregate_id
        if aggregate_type == "task":
            return self.project_task_repository.get_task(connection, aggregate_id).project_id
        return None

    @staticmethod
    def _make_result(command: CommandEnvelope, appended: AppendResult, state_result: Any, factory: Callback | None) -> CommandResult:
        """使用调用方结果 factory 或生成最小稳定 CommandResult。"""
        if factory is not None:
            return Task2CommandService._call_callback(
                factory,
                ((command, appended, state_result), (appended, state_result), (appended,)),
            )
        event = appended.events[-1]
        return CommandResult(
            aggregateId=command.aggregate_id,
            version=appended.aggregate_version,
            eventId=event.event_id,
            allowedActions=("none",),
            traceId=event.trace_id,
        )

    @staticmethod
    def _call_callback(callback: Callback, candidates: tuple[tuple[Any, ...], ...]) -> Any:
        """按签名选择 callback 参数，避免吞掉 callback 内部真正抛出的 TypeError。"""
        try:
            signature = inspect.signature(callback)
        except (TypeError, ValueError):
            return callback(*candidates[0])
        for arguments in candidates:
            try:
                signature.bind(*arguments)
            except TypeError:
                continue
            return callback(*arguments)
        raise TypeError("callback signature does not match Task2CommandService contract")
