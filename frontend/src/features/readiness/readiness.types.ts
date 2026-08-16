// 后端 readiness 的状态集合；blocked/degraded 都不得直接开始真实执行。
export type CheckStatus = "ready" | "blocked" | "degraded";

// 与 FastAPI ReadinessView 对齐的单项检查契约。
export type CheckView = {
  status: CheckStatus;
  message: string;
  impact: string | null;
  nextAction: string | null;
  details: Record<string, unknown>;
};

// 页面消费的总体 readiness 契约；字段名保持后端 JSON alias 不变。
export type ReadinessView = {
  status: CheckStatus;
  checkedAt: string;
  checks: Record<string, CheckView>;
  allowedActions: string[];
  traceId: string;
};
