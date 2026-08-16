import { RuntimeBoundaryError } from "../api/errors.js";
import { ReadinessService } from "../readiness/service.js";

/** 在真实执行前统一检查 readiness，并阻止绕过运行准备的调用。 */
export class StartupGate {
  /** 绑定 readiness 和真实执行开关，所有执行入口共用同一启动门禁。 */
  constructor(
    private readonly readiness: ReadinessService,
    private readonly allowRealExecution = false,
  ) {}
  /** 在所有必要检查通过、拥有项目上下文且显式允许时放行真实执行。 */
  async assertReadyForRealExecution(
    projectId: string | null,
    traceId: string,
  ): Promise<void> {
    const view = await this.readiness.check(traceId);
    if (!projectId || view.status !== "ready" || !this.allowRealExecution)
      throw new RuntimeBoundaryError({
        code: "WORKFLOW_GUARD_BLOCKED",
        message: "运行准备尚未完成或缺少明确项目启动确认，不能开始真实执行",
        impact: "不会产生模型调用、网页访问、工作区写入或项目命令",
        paused: true,
        dataPreserved: true,
        nextAction: "修复阻断项并完成明确的项目启动确认",
        traceId,
        statusCode: 409,
      });
  }
  /** 返回阻断异常而不是抛出，便于 UI 展示统一的下一步。 */
  async tryAssertReady(traceId: string): Promise<RuntimeBoundaryError | null> {
    try {
      await this.assertReadyForRealExecution(null, traceId);
      return null;
    } catch (error) {
      return error instanceof RuntimeBoundaryError ? error : null;
    }
  }
}
