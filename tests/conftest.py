import sys
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


@dataclass
class AcceptanceCounters:
    model_calls: int = 0
    web_requests: int = 0
    workspace_writes: int = 0
    task_container_starts: int = 0
    project_commands: int = 0


@pytest.fixture
def task1_runtime(tmp_path):
    from app.bootstrap.application import build_runtime
    from app.bootstrap.startup_gate import StartupGate
    from app.main import create_app

    runtime = build_runtime(tmp_path, test_mode=True)
    app = create_app(persistent_root=tmp_path, test_mode=True)
    runtime.lifecycle.start_sync()
    counters = AcceptanceCounters()
    client = TestClient(app)
    yield type(
        "Task1AcceptanceRuntime",
        (),
        {
            "root": tmp_path,
            "runtime": runtime,
            "app": app,
            "client": client,
            "database": runtime.database,
            "lifecycle": runtime.lifecycle,
            "leases": runtime.leases,
            "credentials": app.state.readiness.checkers[0].credentials,
            "startup_gate": StartupGate(app.state.readiness),
            "counters": counters,
            "restart": lambda self: build_runtime(tmp_path, test_mode=True),
        },
    )()
    runtime.lifecycle.stop_sync()
    client.close()
