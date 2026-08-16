from fastapi.testclient import TestClient

from app.bootstrap.startup_gate import StartupGate
from app.main import create_app


def test_readiness_route_exists(tmp_path):
    client = TestClient(create_app(persistent_root=tmp_path, test_mode=True))

    response = client.get("/api/v1/readiness")

    assert response.status_code in {200, 503}
    assert response.json()["checks"].keys() == {
        "model", "research", "workspace", "docker", "persistence"
    }


def test_readiness_route_returns_check_messages_and_trace_id(tmp_path):
    client = TestClient(create_app(persistent_root=tmp_path, test_mode=True))

    response = client.get("/api/v1/readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ready", "blocked", "degraded"}
    assert body["traceId"]
    assert all("message" in check for check in body["checks"].values())


def test_app_exposes_startup_gate_for_downstream_execution_consumers(tmp_path):
    app = create_app(persistent_root=tmp_path, test_mode=True)

    assert isinstance(app.state.startup_gate, StartupGate)
    assert app.state.startup_gate.allow_real_execution is False
