/** 固定研发主流程节点；业务代码不能通过配置增加或跳过节点。 */
export const WorkflowStage = {
  PREPARATION: "准备/立项",
  RESEARCH_PRD: "调研/PRD",
  PM_CROSS_REVIEW: "PM 交叉评审",
  PRD_APPROVAL: "Boss PRD 审批",
  FEASIBILITY: "可行性讨论",
  REQUIREMENT_DISPUTE: "需求争议",
  TASK_BREAKDOWN: "开发任务拆解",
  DEVELOPMENT: "开发/自测",
  DEVELOPER_REVIEW: "开发代表 Review",
  TEST_STRATEGY: "测试策略/用例",
  REAL_TEST: "真实测试",
  DEFECT_NPI_REGRESSION: "缺陷/NPI/回归",
  TEST_RELEASE: "Boss 测试放行",
  CLOSING: "结项检查/历史归档",
} as const;
export type WorkflowStage = (typeof WorkflowStage)[keyof typeof WorkflowStage];

/** 固定线性主流程；审批驳回通过显式回边处理，不接受任意 stage 输入。 */
export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  WorkflowStage.PREPARATION,
  WorkflowStage.RESEARCH_PRD,
  WorkflowStage.PM_CROSS_REVIEW,
  WorkflowStage.PRD_APPROVAL,
  WorkflowStage.FEASIBILITY,
  WorkflowStage.REQUIREMENT_DISPUTE,
  WorkflowStage.TASK_BREAKDOWN,
  WorkflowStage.DEVELOPMENT,
  WorkflowStage.DEVELOPER_REVIEW,
  WorkflowStage.TEST_STRATEGY,
  WorkflowStage.REAL_TEST,
  WorkflowStage.DEFECT_NPI_REGRESSION,
  WorkflowStage.TEST_RELEASE,
  WorkflowStage.CLOSING,
];

/** 四类 Boss 人工关卡的持久化类型值。 */
export const ApprovalType = {
  PRD: "prd_approval",
  REQUIREMENT_DISPUTE: "requirement_dispute",
  MAJOR_RISK: "major_risk",
  TEST_RELEASE: "test_release",
} as const;
export type ApprovalType = (typeof ApprovalType)[keyof typeof ApprovalType];

/** 返回固定流程的下一节点；终点不会隐式循环到任意业务节点。 */
export function nextWorkflowStage(stage: WorkflowStage): WorkflowStage | null {
  const index = WORKFLOW_STAGES.indexOf(stage);
  return index < 0 || index === WORKFLOW_STAGES.length - 1
    ? null
    : WORKFLOW_STAGES[index + 1];
}

/** 测试放行驳回的唯一回路，必须回到责任组长计划后的测试策略阶段。 */
export function rejectedTestReleaseTarget(): WorkflowStage {
  return WorkflowStage.TEST_STRATEGY;
}

/** 只有固定节点才能被写入项目 stage 字段。 */
export function isWorkflowStage(value: string): value is WorkflowStage {
  return WORKFLOW_STAGES.includes(value as WorkflowStage);
}
