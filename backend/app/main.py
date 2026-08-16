from pathlib import Path
import os
import shutil
import tempfile
from typing import Any
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.bootstrap.startup_gate import StartupGate
from app.infra.container_runtime import DockerCliRuntime, UnavailableContainerRuntime
from app.infra.database import Database
from app.infra.keychain import KeyringCredentialAdapter, MemoryCredentialAdapter
from app.infra.persistence_root import PersistenceRoot
from app.api.errors import RuntimeBoundaryError, error_payload
from app.api.events import register_event_routes
from app.readiness.checkers.container import ContainerReadinessChecker
from app.readiness.checkers.model import ModelReadinessChecker
from app.readiness.checkers.persistence import PersistenceReadinessChecker
from app.readiness.checkers.research import LocalBrowserProbe, ResearchReadinessChecker, UnavailableResearchProbe
from app.readiness.checkers.workspace import WorkspaceReadinessChecker
from app.readiness.service import ReadinessService
from app.security.audit import AuditWriter
from app.security.local_access import assert_local_request


def _schema_initialization_payload(error: RuntimeError) -> dict[str, Any]:
    """把启动失败保存为可机器解析的冲突/初始化错误契约，同时保留展示文本。"""
    if isinstance(error, RuntimeBoundaryError):
        payload = error.response().model_dump(by_alias=True)
        payload["legacyMessage"] = str(error)
        return payload
    # 原始数据库/OSError 文本可能含路径、锁信息或秘密；只保留固定诊断契约。
    return {
        "code": "SCHEMA_INITIALIZATION_FAILED",
        "message": "持久化 Schema 初始化未完成",
        "impact": "Schema 初始化未完成，业务写入、真实执行和工作区写入保持阻断",
        "paused": True,
        "dataPreserved": True,
        "nextAction": "检查数据库初始化日志和持久化根目录后重试",
        "traceId": f"tr_schema_init_{uuid4().hex[:12]}",
        "legacyMessage": "持久化 Schema 初始化未完成",
    }


def _default_browser_executable() -> str:
    """发现本机可用于 readiness 探针的浏览器可执行文件。"""
    for candidate in ("chromium", "chromium-browser", "google-chrome", "chrome"):
        executable = shutil.which(candidate)
        if executable:
            return executable
    for executable in (
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ):
        if executable.is_file() and os.access(executable, os.X_OK):
            return str(executable)
    return "__browser_not_configured__"


def create_app(
    *,
    persistent_root: Path,
    test_mode: bool = False,
    initialize_runtime: bool = True,
) -> FastAPI:
    """创建本地控制面，并组装持久化、readiness、生命周期和访问边界。"""
    from app.config.settings import Settings

    settings = Settings(persistent_root=persistent_root)
    persistence_root = PersistenceRoot(
        settings.persistent_root,
        app_version=settings.app_version,
        schema_revision=settings.current_schema_revision,
    )
    database = Database(
        settings.database_path,
        persistent_root=settings.persistent_root,
        app_version=settings.app_version,
        schema_revision=settings.current_schema_revision,
    )
    schema_initialization_error: dict[str, Any] | None = None
    if initialize_runtime:
        try:
            # 修改说明：SR-DAT-004/T2-AC-09 要求先读取真实 Schema；
            # blocked/失败路径只能创建缺失目录，成功新库/升级后才提交 manifest。
            persistence_root.initialize_database(database)
        except RuntimeBoundaryError as error:
            schema_initialization_error = _schema_initialization_payload(error)
    credentials = MemoryCredentialAdapter() if test_mode else KeyringCredentialAdapter()
    secret_ref = "memory://unconfigured" if test_mode else settings.model_secret_ref
    readiness = ReadinessService(
        checkers=[
            ModelReadinessChecker(
                credentials,
                provider=settings.model_provider,
                model=settings.model_name,
                secret_ref=secret_ref,
            ),
            ResearchReadinessChecker(
                UnavailableResearchProbe()
                if test_mode
                else LocalBrowserProbe(executable=_default_browser_executable())
            ),
            WorkspaceReadinessChecker(settings.workspace_path),
            ContainerReadinessChecker(
                UnavailableContainerRuntime() if test_mode else DockerCliRuntime()
            ),
            PersistenceReadinessChecker(
                database,
            ),
        ]
    )
    @asynccontextmanager
    async def lifespan(runtime_app: FastAPI):
        """在 ASGI 生命周期内初始化运行时资源并安全释放数据库连接。"""
        if not initialize_runtime:
            try:
                # 与 initialize_runtime=True 共用同一非破坏性 root/database 初始化顺序。
                persistence_root.initialize_database(database)
            except RuntimeBoundaryError as error:
                runtime_app.state.schema_initialization_error = _schema_initialization_payload(error)
        try:
            yield
        finally:
            database.close()

    app = FastAPI(title="Digital Harness Runtime", version=settings.app_version, lifespan=lifespan)
    app.state.settings = settings
    app.state.database = database
    app.state.credentials = credentials
    app.state.schema_initialization_error = schema_initialization_error
    app.state.readiness = readiness
    app.state.startup_gate = StartupGate(
        readiness,
        allow_real_execution=settings.allow_real_execution,
    )
    app.state.audit = AuditWriter(database)
    app.state.test_mode = test_mode
    register_event_routes(app)

    @app.get("/api/v1/readiness")
    async def readiness_view(request: Request):
        """返回当前运行准备状态；每次请求都会重新执行检查。"""
        trace_id = f"tr_readiness_{uuid4().hex[:12]}"
        assert_local_request(request, trace_id=trace_id)
        view = await app.state.readiness.check(trace_id=trace_id)
        return view.model_dump(by_alias=True, mode="json")

    @app.exception_handler(RuntimeBoundaryError)
    async def runtime_boundary_error_handler(_request: Request, error: RuntimeBoundaryError):
        """将统一运行边界异常转换为脱敏 API 响应并记录安全事件。"""
        if error.code == "POLICY_DENIED":
            await app.state.audit.write(
                trace_id=error.trace_id,
                event_type="SecurityAccessDenied",
                result="blocked",
                metadata={"code": error.code, "message": error.message},
            )
        return JSONResponse(status_code=error.status_code, content=error_payload(error))

    return app



def _default_persistent_root() -> Path:
    """返回环境变量指定的持久化根目录，未配置时使用临时目录。"""
    configured = os.environ.get("DIGITAL_HARNESS_PERSISTENT_ROOT")
    if configured:
        return Path(configured)
    # macOS 常将 /var 映射到 /private/var；默认路径先 canonicalize，避免把
    # 系统自身的别名误判为用户配置的越界 symlink。
    return Path(tempfile.gettempdir()).resolve() / "digital-harness-runtime"


# 模块级 ASGI 应用供 Uvicorn 和桌面 sidecar 直接加载。
app = create_app(persistent_root=_default_persistent_root(), initialize_runtime=False)
