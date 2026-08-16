from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field


class RuntimeErrorResponse(BaseModel):
    """描述可展示给调用方的运行边界错误，且不包含敏感凭据。"""
    model_config = ConfigDict(populate_by_name=True)

    code: str
    message: str
    impact: str
    paused: bool
    data_preserved: bool = Field(alias="dataPreserved")
    next_action: str = Field(alias="nextAction")
    trace_id: str = Field(alias="traceId")
    schema_revision: Optional[str] = Field(default=None, alias="schemaRevision")


class RuntimeBoundaryError(RuntimeError):
    """表示运行准备、安全策略或版本边界阻止了当前操作。

    继承 RuntimeError 保留 Task 1 启动异常的兼容捕获语义，同时让调用方可以
    通过 code、dataPreserved 和 nextAction 读取稳定的机器契约。
    """

    def __init__(
        self,
        *,
        code: str,
        message: str,
        impact: str,
        paused: bool = False,
        data_preserved: bool = True,
        next_action: str,
        trace_id: str,
        schema_revision: Optional[str] = None,
        status_code: int = 409,
    ) -> None:
        """保存错误分类、影响、恢复动作和 trace 信息。"""
        super().__init__(message)
        self.code = code
        self.message = message
        self.impact = impact
        self.paused = paused
        self.data_preserved = data_preserved
        self.next_action = next_action
        self.trace_id = trace_id
        self.schema_revision = schema_revision
        self.status_code = status_code

    def response(self) -> RuntimeErrorResponse:
        """将异常转换为稳定的错误响应模型。"""
        return RuntimeErrorResponse(
            code=self.code,
            message=self.message,
            impact=self.impact,
            paused=self.paused,
            dataPreserved=self.data_preserved,
            nextAction=self.next_action,
            traceId=self.trace_id,
            schemaRevision=self.schema_revision,
        )


def error_payload(error: RuntimeBoundaryError) -> Dict[str, Any]:
    """生成 FastAPI 异常处理器使用的 JSON 兼容错误载荷。"""
    return error.response().model_dump(by_alias=True)
