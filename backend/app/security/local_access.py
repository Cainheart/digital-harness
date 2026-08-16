from __future__ import annotations

from ipaddress import ip_address

from fastapi import Request

from app.api.errors import RuntimeBoundaryError


def trusted_client_host(request: Request) -> str:
    """获取请求来源地址；测试模式允许通过专用请求头注入测试地址。"""
    if request.app.state.test_mode:
        injected = request.headers.get("X-Test-Remote-Address")
        return injected or "127.0.0.1"
    return request.client.host if request.client else ""


def assert_local_request(request: Request, *, trace_id: str) -> None:
    """拒绝非回环地址请求，保证控制面默认只服务本机。"""
    host = trusted_client_host(request)
    try:
        is_loopback = ip_address(host).is_loopback
    except ValueError:
        is_loopback = False
    if not is_loopback:
        raise RuntimeBoundaryError(
            code="POLICY_DENIED",
            message="仅允许本机访问控制面",
            impact="当前请求未执行任何业务操作",
            data_preserved=True,
            next_action="从运行产品的本机访问，或检查监听地址配置",
            trace_id=trace_id,
            status_code=403,
        )
