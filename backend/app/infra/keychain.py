from __future__ import annotations

import secrets as secret_token
from dataclasses import dataclass
from typing import Protocol

import keyring


@dataclass(frozen=True)
class SecretLease:
    """表示仅在外部调用边界短时持有的明文凭据。"""
    value: str

    def __repr__(self) -> str:
        """返回不包含凭据明文的调试表示。"""
        return "SecretLease(value=[REDACTED])"


@dataclass(frozen=True)
class CredentialCheckResult:
    """表示凭据引用是否可用，但不返回凭据明文。"""
    available: bool
    secret_ref: str
    message: str


class CredentialAdapter(Protocol):
    """抽象 OS Keychain 与测试替身的凭据访问契约。"""
    async def save(self, provider: str, secret: str) -> str:
        """保存明文并返回安全引用。"""
        ...

    async def read(self, secret_ref: str) -> SecretLease:
        """按引用短时读取明文租约。"""
        ...

    async def delete(self, secret_ref: str) -> None:
        """删除指定凭据引用。"""
        ...

    async def check(self, secret_ref: str) -> CredentialCheckResult:
        """检查凭据可用性而不返回明文。"""
        ...


class MemoryCredentialAdapter:
    """仅供测试使用的内存凭据适配器，避免测试写入真实 Keychain。"""
    def __init__(self) -> None:
        """创建只在当前测试进程内保存数据的凭据映射。"""
        self._values: dict[str, str] = {}

    async def save(self, provider: str, secret: str) -> str:
        """保存测试凭据并返回不可推断明文的引用。"""
        secret_ref = f"memory://{provider}/{secret_token.token_urlsafe(16)}"
        self._values[secret_ref] = secret
        return secret_ref

    async def read(self, secret_ref: str) -> SecretLease:
        """按引用读取测试凭据。"""
        return SecretLease(self._values[secret_ref])

    async def delete(self, secret_ref: str) -> None:
        """删除测试凭据。"""
        self._values.pop(secret_ref, None)

    async def check(self, secret_ref: str) -> CredentialCheckResult:
        """检查引用是否存在，只返回状态和脱敏消息。"""
        available = secret_ref in self._values
        return CredentialCheckResult(
            available=available,
            secret_ref=secret_ref,
            message="Credential is available" if available else "Credential is not bound",
        )

    def clear(self) -> None:
        """清空测试凭据，避免测试之间共享秘密。"""
        self._values.clear()


class KeyringCredentialAdapter:
    """使用操作系统 Keychain/Secret Service 保存生产凭据。"""

    # 凭据服务名固定，避免同一应用在系统凭据库中产生多个命名空间。
    SERVICE = "digital-harness-runtime"

    async def save(self, provider: str, secret: str) -> str:
        """将明文写入 OS Keychain，并仅返回 secretRef。"""
        secret_ref = f"keyring://{provider}/{secret_token.token_urlsafe(16)}"
        keyring.set_password(self.SERVICE, secret_ref, secret)
        return secret_ref

    async def read(self, secret_ref: str) -> SecretLease:
        """在调用边界按引用短时读取 Keychain 明文。"""
        value = keyring.get_password(self.SERVICE, secret_ref)
        if value is None:
            raise KeyError(secret_ref)
        return SecretLease(value)

    async def delete(self, secret_ref: str) -> None:
        """删除 Keychain 中的凭据；不存在时保持幂等。"""
        try:
            keyring.delete_password(self.SERVICE, secret_ref)
        except keyring.errors.PasswordDeleteError:
            return

    async def check(self, secret_ref: str) -> CredentialCheckResult:
        """检查 Keychain 引用是否可读，不暴露凭据内容。"""
        available = keyring.get_password(self.SERVICE, secret_ref) is not None
        return CredentialCheckResult(
            available=available,
            secret_ref=secret_ref,
            message="Credential is available" if available else "Credential is not bound",
        )
