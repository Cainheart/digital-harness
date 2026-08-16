from __future__ import annotations

import pytest

from app.bootstrap.startup_gate import StartupGate
from app.readiness.models import CheckStatus, CheckView, ReadinessView


class StubReadiness:
    def __init__(self, status: CheckStatus):
        self.status = status

    async def check(self, *, trace_id: str) -> ReadinessView:
        return ReadinessView(
            status=self.status,
            checks={
                "model": CheckView(
                    status=self.status,
                    message="model check",
                    impact="model unavailable" if self.status == CheckStatus.BLOCKED else None,
                    nextAction="bind model" if self.status == CheckStatus.BLOCKED else None,
                )
            },
            allowedActions=[],
            traceId=trace_id,
        )


@pytest.mark.asyncio
async def test_startup_gate_blocks_real_execution_when_readiness_is_incomplete():
    gate = StartupGate(StubReadiness(CheckStatus.BLOCKED))

    with pytest.raises(Exception) as raised:
        await gate.assert_ready_for_real_execution(project_id="project-1", trace_id="tr-gate")

    assert raised.value.code == "WORKFLOW_GUARD_BLOCKED"
    assert raised.value.data_preserved is True


@pytest.mark.asyncio
async def test_startup_gate_allows_real_execution_only_after_ready_check():
    gate = StartupGate(StubReadiness(CheckStatus.READY), allow_real_execution=True)

    await gate.assert_ready_for_real_execution(project_id="project-1", trace_id="tr-gate-ready")
