/** 单项和总体 readiness 的可观察状态。 */
export type CheckStatus = "ready" | "blocked" | "degraded";
/** 描述单项依赖检查结果、影响和下一步动作。 */
export type CheckView = {
  status: CheckStatus;
  message: string;
  code?: string;
  impact?: string;
  dataPreserved?: boolean;
  schemaRevision?: string;
  nextAction?: string;
  details: Record<string, unknown>;
};
/** 描述一次完整运行准备检查及其允许动作。 */
export type ReadinessView = {
  status: CheckStatus;
  checkedAt: string;
  checks: Record<string, CheckView>;
  allowedActions: string[];
  traceId: string;
};
