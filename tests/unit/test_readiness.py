from __future__ import annotations

from app.readiness.service import ReadinessService


class StubChecker:
    def __init__(self, name: str, status: str, *, impact: str | None = None, next_action: str | None = None):
        self.name = name
        self._status = status
        self._impact = impact
        self._next_action = next_action

    async def check(self):
        return {
            "name": self.name,
            "status": self._status,
            "message": f"{self.name} is {self._status}",
            "impact": self._impact,
            "next_action": self._next_action,
        }


async def test_readiness_reports_all_five_checks_and_blocks_on_required_failure():
    service = ReadinessService(
        checkers=[
            StubChecker("model", "ready"),
            StubChecker("research", "blocked", impact="网页适配器不可用", next_action="安装浏览器"),
            StubChecker("workspace", "ready"),
            StubChecker("docker", "ready"),
            StubChecker("persistence", "ready"),
        ]
    )

    view = await service.check(trace_id="tr_readiness_test")

    assert view.status == "blocked"
    assert set(view.checks) == {"model", "research", "workspace", "docker", "persistence"}
    assert view.checks["research"].impact == "网页适配器不可用"
    assert view.checks["research"].next_action == "安装浏览器"
    assert view.allowed_actions == []


async def test_readiness_returns_create_project_only_when_all_required_checks_are_ready():
    service = ReadinessService(
        checkers=[StubChecker(name, "ready") for name in ("model", "research", "workspace", "docker", "persistence")]
    )

    view = await service.check(trace_id="tr_readiness_ready")

    assert view.status == "ready"
    assert view.allowed_actions == ["create_project"]
