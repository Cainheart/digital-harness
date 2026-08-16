"""ExecutionAttempt、ModelCall、ToolCall 和 Notification 的最小仓储。"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.domain.entities import ExecutionAttempt, ModelCall, Notification, ToolCall
from app.domain.errors import NotFoundError
from app.infra.task2_schema import (
    domain_events,
    execution_attempts,
    model_calls,
    notifications,
    tool_calls,
)

from ._common import (
    ensure_project_child,
    ensure_project_writable,
    model_data,
    reject_sensitive_summary,
    utc_datetime,
)


class ExecutionRepository:
    """保存执行尝试及调用/通知的可追踪脱敏摘要。"""

    def create_attempt(self, connection: Any, attempt: ExecutionAttempt) -> None:
        """插入一次执行尝试，并校验项目、任务和重试父项。"""
        data = model_data(attempt)
        ensure_project_writable(connection, data["project_id"])
        from app.infra.task2_schema import tasks

        ensure_project_child(connection, tasks, data["project_id"], data["task_id"], label="task")
        if data["retry_of_attempt_id"] is not None:
            ensure_project_child(
                connection, execution_attempts, data["project_id"],
                data["retry_of_attempt_id"], label="retry attempt",
            )
        connection.execute(
            execution_attempts.insert().values(
                id=data["id"], project_id=data["project_id"], task_id=data["task_id"],
                role=data["role"], model_config_version=data["model_config_version"],
                workspace_ref=data["workspace_ref"], worker_lease_id=data["worker_lease_id"],
                status=data["status"], started_at=data["started_at"], ended_at=data["ended_at"],
                retry_of_attempt_id=data["retry_of_attempt_id"], retry_count=data["retry_count"],
                trace_id=data["trace_id"], version=data["version"],
            )
        )

    def create_model_call(self, connection: Any, call: ModelCall) -> None:
        """插入模型调用摘要，拒绝凭据、完整提示词和原始秘密。"""
        data = model_data(call)
        summary = reject_sensitive_summary(data["summary"])
        if data["error_code"] is not None:
            reject_sensitive_summary(data["error_code"])
        ensure_project_writable(connection, data["project_id"])
        self._ensure_attempt(connection, data["project_id"], data["execution_attempt_id"])
        self._ensure_optional_task(connection, data["project_id"], data["task_id"])
        connection.execute(
            model_calls.insert().values(
                id=data["id"], project_id=data["project_id"], task_id=data["task_id"],
                execution_attempt_id=data["execution_attempt_id"], role=data["role"],
                provider=data["provider"], model=data["model"], started_at=data["started_at"],
                ended_at=data["ended_at"], duration_ms=data["duration_ms"], summary=summary,
                error_code=data["error_code"], input_tokens=data["input_tokens"],
                output_tokens=data["output_tokens"], cost_micros=data["cost_micros"],
                trace_id=data["trace_id"], created_at=data["started_at"],
            )
        )

    def create_tool_call(self, connection: Any, call: ToolCall) -> None:
        """插入工具调用摘要，拒绝凭据和不可审计的原始输入。"""
        data = model_data(call)
        summary = reject_sensitive_summary(data["summary"])
        if data["error_code"] is not None:
            reject_sensitive_summary(data["error_code"])
        ensure_project_writable(connection, data["project_id"])
        self._ensure_attempt(connection, data["project_id"], data["execution_attempt_id"])
        self._ensure_optional_task(connection, data["project_id"], data["task_id"])
        connection.execute(
            tool_calls.insert().values(
                id=data["id"], project_id=data["project_id"], task_id=data["task_id"],
                execution_attempt_id=data["execution_attempt_id"], role=data["role"],
                tool_name=data["tool_name"], started_at=data["started_at"], ended_at=data["ended_at"],
                duration_ms=data["duration_ms"], summary=summary, error_code=data["error_code"],
                trace_id=data["trace_id"], created_at=data["started_at"],
            )
        )

    def create_notification(self, connection: Any, notification: Notification) -> None:
        """插入与已提交 DomainEvent 绑定的通知。"""
        data = model_data(notification)
        ensure_project_writable(connection, data["project_id"])
        if connection.execute(
            select(notifications.c.id).where(notifications.c.id == data["id"])
        ).first() is not None:
            raise ValueError("notification already exists")
        if connection.execute(
            select(domain_events.c.event_id).where(domain_events.c.event_id == data["event_id"])
        ).first() is None:
            raise NotFoundError(f"event {data['event_id']} was not found")
        connection.execute(notifications.insert().values(**data))

    def get_attempt(self, connection: Any, attempt_id: str) -> ExecutionAttempt:
        """读取执行尝试。"""
        row = connection.execute(select(execution_attempts).where(execution_attempts.c.id == attempt_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"attempt {attempt_id} was not found")
        return ExecutionAttempt(**{key: utc_datetime(value) if key.endswith("_at") else value for key, value in dict(row).items()})

    def get_model_call(self, connection: Any, call_id: str) -> ModelCall:
        """读取模型调用摘要。"""
        row = connection.execute(select(model_calls).where(model_calls.c.id == call_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"model call {call_id} was not found")
        values = dict(row)
        values["started_at"] = utc_datetime(values["started_at"])
        values["ended_at"] = utc_datetime(values["ended_at"])
        values.pop("created_at", None)
        values["version"] = 1
        return ModelCall(**values)

    def get_tool_call(self, connection: Any, call_id: str) -> ToolCall:
        """读取工具调用摘要。"""
        row = connection.execute(select(tool_calls).where(tool_calls.c.id == call_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"tool call {call_id} was not found")
        values = dict(row)
        values["started_at"] = utc_datetime(values["started_at"])
        values["ended_at"] = utc_datetime(values["ended_at"])
        values.pop("created_at", None)
        values["version"] = 1
        return ToolCall(**values)

    def get_notification(self, connection: Any, notification_id: str) -> Notification:
        """读取通知处理状态。"""
        row = connection.execute(select(notifications).where(notifications.c.id == notification_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"notification {notification_id} was not found")
        values = dict(row)
        for key in ("created_at", "read_at", "handled_at"):
            values[key] = utc_datetime(values[key])
        values["version"] = 1
        return Notification(**values)

    def _ensure_attempt(self, connection: Any, project_id: str, attempt_id: str) -> None:
        ensure_project_child(connection, execution_attempts, project_id, attempt_id, label="execution attempt")

    def _ensure_optional_task(self, connection: Any, project_id: str, task_id: str | None) -> None:
        if task_id is not None:
            from app.infra.task2_schema import tasks

            ensure_project_child(connection, tasks, project_id, task_id, label="task")
