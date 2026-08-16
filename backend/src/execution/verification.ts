import { newObjectId } from "../domain/common.js";
import { DomainError } from "../domain/errors.js";
import {
  CodingExecutionGrant,
  CodingTaskSpec,
  FailureClass,
  VerificationRun,
  classifyFailure,
  verificationCommands,
} from "../domain/coding/index.js";
import { FileGateway } from "./file-gateway.js";
import { CommandGateway } from "./command-gateway.js";

/** VerificationOrchestrator 按版本化 Profile 顺序执行真实命令并保存逐步证据。 */
export class VerificationOrchestrator {
  constructor(
    private readonly commands: CommandGateway,
    private readonly files: FileGateway,
    private readonly timeoutMs = 120_000,
  ) {}

  /** 快速检查优先；首个失败停止后续命令并保留失败输出与退出码。 */
  async run(
    sessionId: string,
    workspacePath: string,
    spec: CodingTaskSpec,
    grant: CodingExecutionGrant,
    retryCount: number,
    traceId: string,
  ): Promise<VerificationRun> {
    const createdAt = new Date().toISOString();
    const steps: VerificationRun["steps"] = [];
    let failureClass: FailureClass | null = null;
    for (const command of verificationCommands(spec.verificationProfile)) {
      const startedAt = new Date().toISOString();
      let result;
      try {
        result = await this.commands.run(
          command,
          workspacePath,
          this.timeoutMs,
          spec,
          grant,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "验证命令被策略拒绝";
        const errorCode =
          error instanceof DomainError &&
          error.data &&
          typeof error.data === "object" &&
          "code" in error.data
            ? String((error.data as { code: unknown }).code)
            : "COMMAND_DENIED";
        const stderrRef = await this.files.saveEvidence(
          grant.projectId,
          message,
          "text/plain",
        );
        steps.push({
          command,
          status: "blocked",
          exitCode: null,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: 0,
          stdoutRef: null,
          stderrRef: stderrRef.storeRef,
          errorCode,
        });
        failureClass = classifyFailure({
          errorCode,
          exitCode: null,
          stderr: message,
        });
        break;
      }
      const stdoutRef = result.stdout
        ? await this.files.saveEvidence(
            grant.projectId,
            result.stdout,
            "text/plain",
          )
        : null;
      const stderrRef = result.stderr
        ? await this.files.saveEvidence(
            grant.projectId,
            result.stderr,
            "text/plain",
          )
        : null;
      const failed = result.errorCode !== null || result.exitCode !== 0;
      steps.push({
        command,
        status: failed ? "failed" : "succeeded",
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        durationMs: result.durationMs,
        stdoutRef: stdoutRef?.storeRef ?? null,
        stderrRef: stderrRef?.storeRef ?? null,
        errorCode: result.errorCode,
      });
      if (failed) {
        failureClass = classifyFailure({
          errorCode: result.errorCode,
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
        break;
      }
    }
    const status = failureClass
      ? failureClass === "POLICY" || failureClass === "CREDENTIAL"
        ? "blocked"
        : "failed"
      : "succeeded";
    return {
      verificationId: newObjectId("verification"),
      sessionId,
      profile: spec.verificationProfile,
      status,
      steps,
      failureClass,
      retryCount,
      traceId,
      createdAt,
      completedAt: new Date().toISOString(),
    };
  }
}
