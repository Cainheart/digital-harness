from fastapi.testclient import TestClient

from app.main import create_app


def test_non_local_request_is_rejected_and_audited(tmp_path):
    app = create_app(persistent_root=tmp_path, test_mode=True)
    client = TestClient(app)

    response = client.get(
        "/api/v1/readiness",
        headers={"X-Test-Remote-Address": "192.0.2.10", "Authorization": "Bearer secret-not-for-logs"},
    )

    assert response.status_code == 403
    assert response.json()["code"] == "POLICY_DENIED"
    assert response.json()["dataPreserved"] is True
    assert "traceId" in response.json()
    assert "secret-not-for-logs" not in app.state.database.read_event_text()


def test_local_request_is_allowed(tmp_path):
    client = TestClient(create_app(persistent_root=tmp_path, test_mode=True))

    response = client.get("/api/v1/readiness")

    assert response.status_code == 200
