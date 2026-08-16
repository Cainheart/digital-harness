from __future__ import annotations

from typing import Any

from app.infra.keychain import CredentialAdapter
from app.readiness.models import CheckStatus, CheckView


class ModelReadinessChecker:
    """检查配置的模型凭据引用是否可用，不执行模型生成。"""

    name = "model"

    def __init__(self, credentials: CredentialAdapter, *, provider: str, model: str, secret_ref: str) -> None:
        """绑定模型配置和凭据引用，但不读取或记录凭据明文。"""
        self.credentials = credentials
        self.provider = provider
        self.model = model
        self.secret_ref = secret_ref

    async def check(self) -> CheckView:
        """把凭据检查结果转换成可展示的 readiness 视图。"""
        result = await self.credentials.check(self.secret_ref)
        if not result.available:
            return CheckView(
                status=CheckStatus.BLOCKED,
                message="模型凭据不可用",
                impact="模型调用无法启动",
                nextAction="重新绑定模型凭据并执行连接检查",
                details={"provider": self.provider, "model": self.model},
            )
        return CheckView(
            status=CheckStatus.READY,
            message="至少一个已配置模型可连接",
            details={"provider": self.provider, "model": self.model},
        )
