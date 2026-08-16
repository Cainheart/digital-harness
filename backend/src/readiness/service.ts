import { CheckStatus, CheckView, ReadinessView } from "./models.js";

/** 定义独立 readiness 检查器的最小契约。 */
export interface ReadinessChecker {
  readonly name: string;
  check(): Promise<CheckView>;
}
/** 聚合依赖检查并按最严格失败状态计算总体结果。 */
export class ReadinessService {
  /** 绑定固定顺序的依赖检查器，不在聚合层执行任何业务副作用。 */
  constructor(private readonly checkers: ReadinessChecker[]) {}
  /** 每次请求重新执行所有检查，并返回带 trace 的最新状态。 */
  async check(traceId: string): Promise<ReadinessView> {
    const checks: Record<string, CheckView> = {};
    for (const checker of this.checkers)
      checks[checker.name] = await checker.check();
    const statuses = Object.values(checks).map((check) => check.status);
    const status: CheckStatus = statuses.includes("blocked")
      ? "blocked"
      : statuses.includes("degraded")
        ? "degraded"
        : "ready";
    return {
      status,
      checkedAt: new Date().toISOString(),
      checks,
      allowedActions: status === "ready" ? ["create_project"] : [],
      traceId,
    };
  }
}
