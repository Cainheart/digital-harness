import { ProjectStatus, TaskStatus } from "../domain/common.js";
import { WorkflowGuardBlockedError } from "../domain/errors.js";

/** 项目主状态机允许的边；所有项目命令和自动推进都必须复用此表。 */
export const PROJECT_TRANSITIONS: Readonly<
  Record<ProjectStatus, readonly ProjectStatus[]>
> = {
  [ProjectStatus.PREPARING]: [ProjectStatus.RUNNING, ProjectStatus.TERMINATED],
  [ProjectStatus.RUNNING]: [
    ProjectStatus.WAITING_BOSS,
    ProjectStatus.PAUSED,
    ProjectStatus.BLOCKED,
    ProjectStatus.CLOSING,
    ProjectStatus.TERMINATED,
  ],
  [ProjectStatus.WAITING_BOSS]: [
    ProjectStatus.RUNNING,
    ProjectStatus.PAUSED,
    ProjectStatus.TERMINATED,
  ],
  [ProjectStatus.PAUSED]: [ProjectStatus.RUNNING, ProjectStatus.TERMINATED],
  [ProjectStatus.BLOCKED]: [
    ProjectStatus.RUNNING,
    ProjectStatus.PAUSED,
    ProjectStatus.TERMINATED,
  ],
  [ProjectStatus.CLOSING]: [
    ProjectStatus.COMPLETED,
    ProjectStatus.BLOCKED,
    ProjectStatus.TERMINATED,
  ],
  [ProjectStatus.COMPLETED]: [],
  [ProjectStatus.TERMINATED]: [],
};

/** 任务状态机允许的边；完成和终止是不可恢复的终态。 */
export const TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  [TaskStatus.PENDING]: [
    TaskStatus.RUNNING,
    TaskStatus.BLOCKED,
    TaskStatus.TERMINATED,
  ],
  [TaskStatus.RUNNING]: [
    TaskStatus.WAITING_REVIEW,
    TaskStatus.WAITING_APPROVAL,
    TaskStatus.BLOCKED,
    TaskStatus.COMPLETED,
    TaskStatus.TERMINATED,
  ],
  [TaskStatus.WAITING_REVIEW]: [
    TaskStatus.REWORK,
    TaskStatus.COMPLETED,
    TaskStatus.BLOCKED,
    TaskStatus.TERMINATED,
  ],
  [TaskStatus.WAITING_APPROVAL]: [
    TaskStatus.REWORK,
    TaskStatus.COMPLETED,
    TaskStatus.BLOCKED,
    TaskStatus.TERMINATED,
  ],
  [TaskStatus.BLOCKED]: [TaskStatus.RUNNING, TaskStatus.TERMINATED],
  [TaskStatus.REWORK]: [
    TaskStatus.RUNNING,
    TaskStatus.BLOCKED,
    TaskStatus.TERMINATED,
  ],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.TERMINATED]: [],
};

/** 检查项目状态是否允许转换，并保留稳定的冲突信息。 */
export function assertProjectTransition(
  from: ProjectStatus,
  to: ProjectStatus,
  context: TransitionContext = {},
): void {
  if (!PROJECT_TRANSITIONS[from]?.includes(to)) {
    throw workflowBlocked("工作流门禁阻止：项目状态不允许直接流转", {
      aggregateType: "project",
      from,
      to,
      reason: context.reason ?? "未满足固定工作流边",
    });
  }
  if (to === ProjectStatus.COMPLETED && !context.closingChecksPassed) {
    throw workflowBlocked("结项检查未通过，项目不能进入已结项", {
      aggregateType: "project",
      from,
      to,
      reason: "closing_checks_required",
    });
  }
  if (
    from === ProjectStatus.WAITING_BOSS &&
    to === ProjectStatus.RUNNING &&
    !context.gateCompleted
  ) {
    throw workflowBlocked("人工关卡尚未完成，项目不能自动恢复", {
      aggregateType: "project",
      from,
      to,
      reason: "approval_required",
    });
  }
  if (
    from === ProjectStatus.BLOCKED &&
    to === ProjectStatus.RUNNING &&
    !context.blockedResolved
  ) {
    throw workflowBlocked("阻塞原因尚未解除，项目不能恢复", {
      aggregateType: "project",
      from,
      to,
      reason: "blocked_condition_required",
    });
  }
  if (
    from === ProjectStatus.PAUSED &&
    to === ProjectStatus.RUNNING &&
    !context.resumeConfirmed
  ) {
    throw workflowBlocked("恢复命令未确认，项目不能继续运行", {
      aggregateType: "project",
      from,
      to,
      reason: "resume_confirmation_required",
    });
  }
}

/** 检查任务状态是否允许转换，并保护 Review、审批和终态边界。 */
export function assertTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  context: TransitionContext = {},
): void {
  if (!TASK_TRANSITIONS[from]?.includes(to)) {
    throw workflowBlocked("工作流门禁阻止：任务状态不允许直接流转", {
      aggregateType: "task",
      from,
      to,
      reason: context.reason ?? "未满足固定任务状态边",
    });
  }
  if (to === TaskStatus.COMPLETED && context.evidenceComplete === false) {
    throw workflowBlocked("任务缺少必需证据，不能标记已完成", {
      aggregateType: "task",
      from,
      to,
      reason: "evidence_required",
    });
  }
  // 修改日期：2026-08-16
  // 修改原因：任务进入 Review 前必须先完成执行证据，防止 Worker 用不完整结果绕过交接门禁。
  if (to === TaskStatus.WAITING_REVIEW && context.evidenceComplete === false) {
    throw workflowBlocked("任务缺少必需证据，不能提交 Review", {
      aggregateType: "task",
      from,
      to,
      reason: "evidence_required_for_review",
    });
  }
  if (to === TaskStatus.RUNNING && context.dependenciesSatisfied === false) {
    throw workflowBlocked("任务依赖未满足，不能开始执行", {
      aggregateType: "task",
      from,
      to,
      reason: "dependencies_unsatisfied",
    });
  }
}

/** 判断一个项目动作是否会产生真实的新执行。 */
export function projectAllowsNewTask(status: ProjectStatus): boolean {
  return status === ProjectStatus.RUNNING;
}

/** 判断通知是否已进入不可再操作的闭环状态。 */
export function notificationAllowsAction(pending: boolean): boolean {
  return pending;
}

/** 统一状态转换上下文，避免调用方通过无类型字段绕过门禁。 */
export type TransitionContext = {
  reason?: string;
  gateCompleted?: boolean;
  closingChecksPassed?: boolean;
  blockedResolved?: boolean;
  resumeConfirmed?: boolean;
  evidenceComplete?: boolean;
  dependenciesSatisfied?: boolean;
};

function workflowBlocked(
  message: string,
  data: Record<string, unknown>,
): WorkflowGuardBlockedError {
  return new WorkflowGuardBlockedError(message, {
    data,
    impact: "业务状态未改变，已有事件和证据保持不变",
    dataPreserved: true,
    nextAction: "查看当前阶段、待办关卡和阻塞条件后提交合法命令",
  });
}
