from __future__ import annotations

import json

from app.infra.container_runtime import DockerCliRuntime, _default_docker_executable


class StubRunner:
    def __init__(self, *, returncode: int, stdout: str, stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.commands: list[list[str]] = []

    def __call__(self, command, **_kwargs):
        self.commands.append(command)
        return type(
            "Completed",
            (),
            {"returncode": self.returncode, "stdout": self.stdout, "stderr": self.stderr},
        )()


async def test_docker_cli_runtime_checks_engine_without_starting_a_container():
    runner = StubRunner(
        returncode=0,
        stdout=json.dumps(
            {
                "ServerVersion": "27.0.0",
                "DockerRootDir": "/var/lib/docker",
                "OperatingSystem": "Docker Desktop",
            }
        ),
    )
    runtime = DockerCliRuntime(runner=runner, probe_enabled=False)

    capabilities = await runtime.capabilities()

    assert capabilities.available is True
    assert capabilities.runtime == "docker-desktop"
    assert capabilities.engine_version == "27.0.0"
    assert capabilities.non_root_supported is True
    assert capabilities.workspace_mount_supported is True
    assert runner.commands == [[runtime.executable, "info", "--format", "{{json .}}"]]


async def test_docker_cli_runtime_returns_blocked_capabilities_when_engine_is_down():
    runner = StubRunner(returncode=1, stdout="", stderr="Cannot connect to Docker daemon")
    runtime = DockerCliRuntime(runner=runner, probe_enabled=False)

    capabilities = await runtime.capabilities()

    assert capabilities.available is False
    assert capabilities.runtime == "unavailable"
    assert "Docker" in capabilities.message


def test_default_docker_cli_discovers_macos_docker_desktop_bundle():
    assert _default_docker_executable() == "/Applications/Docker.app/Contents/Resources/bin/docker"


async def test_docker_cli_runtime_runs_isolated_non_root_capability_probe():
    class ProbeRunner(StubRunner):
        def __call__(self, command, **kwargs):
            self.commands.append(command)
            if command[1] == "info":
                return type(
                    "Completed",
                    (),
                    {
                        "returncode": 0,
                        "stdout": json.dumps(
                            {"ServerVersion": "29.7.2", "OperatingSystem": "Docker Desktop"}
                        ),
                        "stderr": "",
                    },
                )()
            return type(
                "Completed",
                (),
                {"returncode": 0, "stdout": "65532\nNON_ROOT_MOUNT=PASS\n", "stderr": ""},
            )()

    runner = ProbeRunner(returncode=0, stdout="")
    runtime = DockerCliRuntime(runner=runner)

    capabilities = await runtime.capabilities()

    assert capabilities.available is True
    assert capabilities.non_root_supported is True
    probe_commands = [command for command in runner.commands if command[1] == "run"]
    assert probe_commands
    probe_command = probe_commands[0]
    assert "--user" in probe_command
    assert "65532:65532" in probe_command
    assert "--network" in probe_command
    assert "none" in probe_command
    assert "--cpus" in probe_command
    assert "--memory" in probe_command
