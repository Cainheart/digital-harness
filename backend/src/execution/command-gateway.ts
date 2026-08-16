import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { PolicyDeniedError } from "../domain/errors.js";
import {
  CodingExecutionGrant,
  CodingTaskSpec,
  isCodingCommandAllowed,
} from "../domain/coding/index.js";

/** 受控命令执行器的事实结果；不返回凭据、环境变量或隐藏提示词。 */
export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  errorCode: string | null;
  runtime: "docker" | "native";
};

/** Docker/Native 实现共用的最小命令执行边界，便于集成测试注入替身。 */
export interface CommandRunner {
  run(
    command: string,
    workspacePath: string,
    timeoutMs: number,
  ): Promise<CommandResult>;
}

/** 工具网关先执行 CodingGrant 校验，再把固定命令交给隔离运行器。 */
export class CommandGateway {
  constructor(private readonly runner: CommandRunner) {}

  /** 执行验证 Profile 允许的单一命令，默认网络策略只能是 deny。 */
  async run(
    command: string,
    workspacePath: string,
    timeoutMs: number,
    spec: CodingTaskSpec,
    grant: CodingExecutionGrant,
  ): Promise<CommandResult> {
    if (
      !grant.toolPolicy.includes("run_verification") ||
      grant.commandPolicy.network !== "deny" ||
      !isCodingCommandAllowed(command, grant.commandPolicy.allow)
    ) {
      throw new PolicyDeniedError("命令不在验证 Profile 或 Grant 白名单内", {
        data: { code: "COMMAND_DENIED" },
      });
    }
    if (
      !workspacePath ||
      !spec.projectId ||
      grant.projectId !== spec.projectId
    ) {
      throw new PolicyDeniedError("命令工作区与任务授权不匹配", {
        data: { code: "PATH_DENIED" },
      });
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    ) {
      throw new PolicyDeniedError("命令超时超出资源限制", {
        data: { code: "RESOURCE_LIMIT" },
      });
    }
    return this.runner.run(command.trim(), workspacePath, timeoutMs);
  }
}

/** Docker 执行器默认关闭网络、只读基础层、非 root 并限制 CPU/内存/PID。 */
export class DockerCommandRunner implements CommandRunner {
  constructor(
    private readonly executable = "docker",
    private readonly image = "node:22-bookworm-slim",
  ) {}

  /** 使用 exec 参数数组启动一次性容器，不经过宿主机 shell。 */
  async run(
    command: string,
    workspacePath: string,
    timeoutMs: number,
  ): Promise<CommandResult> {
    if (!existsSync(this.executable) && this.executable !== "docker") {
      return blockedResult("RESOURCE_LIMIT", "Docker CLI 不可用", "docker");
    }
    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "65532:65532",
      "--cpus",
      "1",
      "--memory",
      "1g",
      "--pids-limit",
      "256",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "-v",
      `${workspacePath}:/workspace:rw`,
      "--workdir",
      "/workspace",
      this.image,
      ...splitCommand(command),
    ];
    return spawnCommand(
      this.executable,
      args,
      workspacePath,
      timeoutMs,
      "docker",
    );
  }
}

/** 仅供受控测试或明确的本地开发 fallback 使用；同样禁止 shell 和继承凭据。 */
export class NativeProcessRunner implements CommandRunner {
  /** 在工作区 cwd 中执行固定 argv，环境只保留 PATH 和非敏感运行时变量。 */
  async run(
    command: string,
    workspacePath: string,
    timeoutMs: number,
  ): Promise<CommandResult> {
    return spawnCommand(
      "/usr/bin/env",
      ["-i", "PATH=/usr/local/bin:/usr/bin:/bin", ...splitCommand(command)],
      workspacePath,
      timeoutMs,
      "native",
    );
  }
}

/** 将命令限制为简单 argv；命令白名单已在上层校验，禁止 shell 语法和控制字符。 */
function splitCommand(command: string): string[] {
  if (!command.trim() || /[\u0000-\u001f\u007f|;&><`$]/.test(command))
    throw new PolicyDeniedError("命令包含禁止的 shell 语法", {
      data: { code: "COMMAND_DENIED" },
    });
  const args = command.trim().split(/\s+/);
  if (
    args.some(
      (arg) => arg === ".." || arg.includes("../") || arg.includes("\\"),
    )
  )
    throw new PolicyDeniedError("命令参数包含路径逃逸", {
      data: { code: "COMMAND_DENIED" },
    });
  return args;
}

/** 执行 argv 并收集有限大小输出；超时会终止进程且保留已收集诊断。 */
function spawnCommand(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  runtime: "docker" | "native",
): Promise<CommandResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (target: "stdout" | "stderr", value: Buffer): void => {
      const text = value.toString("utf8");
      if (target === "stdout") stdout = `${stdout}${text}`.slice(-1_000_000);
      else stderr = `${stderr}${text}`.slice(-1_000_000);
    };
    child.stdout.on("data", (value: Buffer) => append("stdout", value));
    child.stderr.on("data", (value: Buffer) => append("stderr", value));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}${error.message}`.slice(-1_000_000),
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        errorCode: "RESOURCE_LIMIT",
        runtime,
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        errorCode: timedOut ? "TIMEOUT" : exitCode === 0 ? null : null,
        runtime,
      });
    });
  });
}

/** 返回无执行事实的阻塞结果，便于 readiness 失败仍能保留结构化证据。 */
function blockedResult(
  errorCode: string,
  stderr: string,
  runtime: "docker" | "native",
): CommandResult {
  const now = new Date().toISOString();
  return {
    exitCode: null,
    stdout: "",
    stderr,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    errorCode,
    runtime,
  };
}
