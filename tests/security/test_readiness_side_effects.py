from dataclasses import dataclass

from app.readiness.service import ReadinessService


@dataclass
class SideEffectCounters:
    model_calls: int = 0
    web_requests: int = 0
    workspace_writes: int = 0
    task_container_starts: int = 0
    project_commands: int = 0


class SideEffectFreeChecker:
    def __init__(self, name: str, counters: SideEffectCounters):
        self.name = name
        self.counters = counters

    async def check(self):
        return {
            "name": self.name,
            "status": "ready",
            "message": "probe only",
            "impact": None,
            "next_action": None,
        }


async def test_readiness_probes_do_not_create_real_execution_side_effects(tmp_path):
    counters = SideEffectCounters()
    service = ReadinessService(
        checkers=[
            SideEffectFreeChecker(name, counters)
            for name in ("model", "research", "workspace", "docker", "persistence")
        ]
    )

    await service.check(trace_id="tr_side_effects")

    assert counters.model_calls == 0
    assert counters.web_requests == 0
    assert counters.workspace_writes == 0
    assert counters.task_container_starts == 0
    assert counters.project_commands == 0
