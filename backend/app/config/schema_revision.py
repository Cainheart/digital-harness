"""应用唯一支持的持久化 Schema 基线。"""

SUPPORTED_SCHEMA_REVISION = "0002_task2_domain_foundation"


def validate_schema_revision(value: str) -> str:
    """拒绝让配置、迁移目标和 readiness 使用不同的兼容基线。"""
    if value != SUPPORTED_SCHEMA_REVISION:
        raise ValueError("only 0002_task2_domain_foundation is supported")
    return value
