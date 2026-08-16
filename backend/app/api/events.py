"""Task 2 已提交领域事件的本机 SSE 查询边界。

事件读取只通过现有 EventStore 的只读快照完成；本模块不写业务表、不读取
Outbox，也不把尚未提交的事务内容暴露给客户端。过滤器只使用事件表已有的
稳定字段或明确约定的 payload 关联字段，未知参数会被拒绝而不是被忽略。
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Iterable
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.domain.errors import InvalidArgumentError, Task2DomainError
from app.domain.events import DomainEvent
from app.infra.repositories.events import SqliteEventStore
from app.security.local_access import assert_local_request


_ALLOWED_QUERY_PARAMETERS = frozenset(
    {
        "after",
        "projectId",
        "taskId",
        "artifactId",
        "traceId",
        "actor",
        "from",
        "to",
        "limit",
    }
)
_DEFAULT_PAGE_LIMIT = 100
_MAX_PAGE_LIMIT = 500
# API 受限文件内只能复用既有 EventStore 的内存后过滤；超过该扫描窗口时显式
# 拒绝请求，避免把未下推的过滤器变成无界内存读取或静默漏掉后续匹配事件。
_MAX_FILTER_SCAN = 10_000
_EMPTY_STREAM_COMMENT = ": no committed events\n\n"


class _EventQuery:
    """保存已校验的事件流游标和过滤条件，避免生成器重复解释请求参数。"""

    def __init__(
        self,
        *,
        after: str | None,
        project_id: str | None,
        task_id: str | None,
        artifact_id: str | None,
        trace_id: str | None,
        actor: str | None,
        occurred_from: datetime | None,
        occurred_to: datetime | None,
        limit: int,
    ) -> None:
        """保存过滤值；所有时间已经归一化为 UTC，limit 已通过上限校验。"""
        self.after = after
        self.project_id = project_id
        self.task_id = task_id
        self.artifact_id = artifact_id
        self.trace_id = trace_id
        self.actor = actor
        self.occurred_from = occurred_from
        self.occurred_to = occurred_to
        self.limit = limit


def _invalid(message: str, *, data: dict[str, object] | None = None, trace_id: str) -> InvalidArgumentError:
    """构造带请求 traceId 的参数错误，供 API 层沿用 Task 2 错误载荷。"""
    return InvalidArgumentError(message=message, data=data, trace_id=trace_id)


def _single_query_value(request: Request, name: str, *, trace_id: str) -> str | None:
    """读取单值查询参数；重复参数显式拒绝，避免游标/过滤语义不确定。"""
    values = request.query_params.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise _invalid(
            f"query parameter {name} must appear at most once",
            data={"parameter": name},
            trace_id=trace_id,
        )
    value = values[0].strip()
    if not value:
        raise _invalid(
            f"query parameter {name} must not be empty",
            data={"parameter": name},
            trace_id=trace_id,
        )
    return value


def _parse_utc(value: str | None, *, parameter: str, trace_id: str) -> datetime | None:
    """解析带时区 ISO-8601 时间，并统一到 UTC 以避免本地时区漂移。"""
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise _invalid(
            f"query parameter {parameter} must be an ISO-8601 datetime",
            data={"parameter": parameter},
            trace_id=trace_id,
        ) from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _invalid(
            f"query parameter {parameter} must include a timezone offset",
            data={"parameter": parameter},
            trace_id=trace_id,
        )
    return parsed.astimezone(timezone.utc)


def _parse_query(request: Request, *, trace_id: str) -> _EventQuery:
    """校验游标、过滤器、时间范围和分页上限，并拒绝未支持的参数。"""
    unknown = sorted(set(request.query_params) - _ALLOWED_QUERY_PARAMETERS)
    if unknown:
        raise _invalid(
            "unsupported event query parameter",
            data={"parameters": unknown},
            trace_id=trace_id,
        )

    after = _single_query_value(request, "after", trace_id=trace_id)
    last_event_id = request.headers.get("Last-Event-ID")
    if last_event_id is not None:
        last_event_id = last_event_id.strip()
        if not last_event_id:
            raise _invalid("Last-Event-ID must not be empty", data={"header": "Last-Event-ID"}, trace_id=trace_id)
        if after is not None and after != last_event_id:
            raise _invalid(
                "after and Last-Event-ID must identify the same cursor",
                data={"parameter": "after", "header": "Last-Event-ID"},
                trace_id=trace_id,
            )
    cursor = after or last_event_id

    project_id = _single_query_value(request, "projectId", trace_id=trace_id)
    task_id = _single_query_value(request, "taskId", trace_id=trace_id)
    artifact_id = _single_query_value(request, "artifactId", trace_id=trace_id)
    event_trace_id = _single_query_value(request, "traceId", trace_id=trace_id)
    actor = _single_query_value(request, "actor", trace_id=trace_id)
    occurred_from = _parse_utc(
        _single_query_value(request, "from", trace_id=trace_id),
        parameter="from",
        trace_id=trace_id,
    )
    occurred_to = _parse_utc(
        _single_query_value(request, "to", trace_id=trace_id),
        parameter="to",
        trace_id=trace_id,
    )
    if occurred_from is not None and occurred_to is not None and occurred_from > occurred_to:
        raise _invalid(
            "from must not be later than to",
            data={"parameter": "from", "relatedParameter": "to"},
            trace_id=trace_id,
        )

    raw_limit = _single_query_value(request, "limit", trace_id=trace_id)
    try:
        limit = _DEFAULT_PAGE_LIMIT if raw_limit is None else int(raw_limit)
    except ValueError as error:
        raise _invalid("limit must be an integer", data={"parameter": "limit"}, trace_id=trace_id) from error
    if not 1 <= limit <= _MAX_PAGE_LIMIT:
        raise _invalid(
            f"limit must be between 1 and {_MAX_PAGE_LIMIT}",
            data={"parameter": "limit", "max": _MAX_PAGE_LIMIT},
            trace_id=trace_id,
        )

    return _EventQuery(
        after=cursor,
        project_id=project_id,
        task_id=task_id,
        artifact_id=artifact_id,
        trace_id=event_trace_id,
        actor=actor,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        limit=limit,
    )


def _payload_identifier(event: DomainEvent, *names: str) -> str | None:
    """从受领域层脱敏的扁平 payload 中读取已约定的关联 ID。"""
    if not isinstance(event.payload, dict):
        return None
    for name in names:
        value = event.payload.get(name)
        if isinstance(value, str):
            return value
    return None


def _matches(event: DomainEvent, query: _EventQuery) -> bool:
    """按事件表稳定列和明确 payload 关联字段执行全部请求过滤。"""
    if query.task_id is not None:
        task_match = (
            event.aggregate_type == "task" and event.aggregate_id == query.task_id
        ) or _payload_identifier(event, "taskId", "task_id") == query.task_id
        if not task_match:
            return False
    if query.artifact_id is not None:
        artifact_match = (
            event.aggregate_type in {"artifact", "artifact_version"}
            and event.aggregate_id == query.artifact_id
        ) or _payload_identifier(event, "artifactId", "artifact_id") == query.artifact_id
        if not artifact_match:
            return False
    if query.trace_id is not None and event.trace_id != query.trace_id:
        return False
    if query.actor is not None:
        actor_match = event.actor.id == query.actor or event.actor.type == query.actor
        if ":" in query.actor:
            actor_type, actor_id = query.actor.split(":", 1)
            actor_match = event.actor.type == actor_type and event.actor.id == actor_id
        if not actor_match:
            return False
    if query.occurred_from is not None and event.occurred_at < query.occurred_from:
        return False
    if query.occurred_to is not None and event.occurred_at > query.occurred_to:
        return False
    return True


def _serialize_event(event: DomainEvent) -> str:
    """将已脱敏 DomainEvent 序列化为单行 SSE data，保留稳定字段别名。"""
    return json.dumps(
        event.model_dump(by_alias=True, mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _sse_lines(events: Iterable[DomainEvent]) -> Iterable[str]:
    """渲染已提交事件；空快照只发一次注释后结束，避免空轮询忙循环。"""
    emitted = False
    for event in events:
        emitted = True
        yield f"id: {event.event_id}\n"
        yield "event: domain_event\n"
        yield f"data: {_serialize_event(event)}\n\n"
    if not emitted:
        yield _EMPTY_STREAM_COMMENT


async def _read_events(request: Request, query: _EventQuery) -> list[DomainEvent]:
    """通过 EventStore 只读快照读取游标后的 committed DomainEvent，再应用过滤。"""
    store = SqliteEventStore()
    # project_id 传入 EventStore 可直接使用其现有索引；其他过滤器在恢复后的
    # DomainEvent 上执行，避免 API 绕过事务边界自行拼接业务 SQL。
    has_post_filter = any(
        value is not None
        for value in (
            query.task_id,
            query.artifact_id,
            query.trace_id,
            query.actor,
            query.occurred_from,
            query.occurred_to,
        )
    )
    scan_limit = _MAX_FILTER_SCAN + 1 if has_post_filter else query.limit
    with request.app.state.database.read_connection() as connection:
        events = store.list_after(
            connection,
            query.after,
            project_id=query.project_id,
            limit=scan_limit,
        )
    if has_post_filter and len(events) > _MAX_FILTER_SCAN:
        raise InvalidArgumentError(
            message="event filter scan exceeds the safe limit; narrow the cursor or project scope",
            data={"maxScan": _MAX_FILTER_SCAN, "nextAction": "provide after or projectId"},
        )
    matched = [event for event in events if _matches(event, query)]
    return matched[: query.limit]


def _domain_error_response(error: Task2DomainError, *, trace_id: str) -> JSONResponse:
    """把领域查询错误转换为既有 Task 2 脱敏错误载荷，而不是泄露底层异常。"""
    if error.trace_id == "trace_unknown":
        error.trace_id = trace_id
    return JSONResponse(status_code=error.status_code, content=error.to_payload())


def register_event_routes(app: FastAPI) -> None:
    """注册本机事件 SSE 查询路由；调用方必须先完成 app.state.database 绑定。"""

    @app.get("/api/v1/events", name="task2_event_stream")
    async def event_stream(request: Request):
        """返回已提交事件的有限快照，断线后用 after/Last-Event-ID 补齐。"""
        trace_id = f"tr_events_{uuid4().hex[:12]}"
        assert_local_request(request, trace_id=trace_id)
        try:
            query = _parse_query(request, trace_id=trace_id)
            events = await _read_events(request, query)
        except Task2DomainError as error:
            return _domain_error_response(error, trace_id=trace_id)

        return StreamingResponse(
            _sse_lines(events),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
