from __future__ import annotations

import re
from collections.abc import Iterable


# 仅用于日志、审计和错误载荷的常见凭据模式脱敏，不用于凭据校验。
_BEARER_PATTERN = re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_-]*\b")


def redact(value: str, *, secrets: Iterable[str] | None = None) -> str:
    """替换 Bearer、API Key 和调用方提供的秘密，避免进入可见面。"""
    result = _BEARER_PATTERN.sub(r"\1[REDACTED]", value)
    result = _KEY_PATTERN.sub("[REDACTED]", result)
    for secret in sorted(set(secrets or ()), key=len, reverse=True):
        if secret:
            result = result.replace(secret, "[REDACTED]")
    return result
