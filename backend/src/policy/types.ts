import { Task } from "../domain/entities.js";
import { ObjectAction, RoleDefinition, ToolName } from "../domain/organization/definitions.js";

/** Policy Gate 支持的动作类型；每个动作必须绑定业务对象、工具或路径边界。 */
export type ActionKind = "read" | "create" | "update" | "approve" | "use_tool" | "send_message" | "assign_task";
/** Policy Gate 统一接收的动作描述。 */
export type Action = { kind: ActionKind; objectType?: string; objectId?: string; toolName?: ToolName | string; path?: string; pathMode?: "read" | "write"; command?: string; projectId?: string; taskId?: string; actorInstanceId?: string; subjectInstanceId?: string; riskLevel?: RiskLevel };
/** 计划是模型输出进入执行循环前的结构化动作列表。 */
export type StructuredPlan = { objective: string; actions: Action[]; expectedArtifacts: string[] };
/** 绑定项目、任务、岗位版本、工具和工作区的执行授权。 */
export type ExecutionGrant = { projectId: string; taskId: string; attemptId: string; roleId: string; roleVersion: number; taskVersion: number; workspaceGrant: { root: string; readOnly: boolean }; toolPolicy: ToolName[]; commandPolicy: { allowedCommands: string[]; forbiddenCommands: string[] }; deadline: string; leaseExpiresAt: string; traceId: string };
/** 策略拒绝的风险等级，供流程门禁和 UI 展示。 */
export type RiskLevel = "low" | "medium" | "high" | "critical";
/** 策略判断的稳定三态。 */
export type PolicyResult = "allow" | "reject" | "approval_required";
/** Policy Gate 的可审计判断结果。 */
export type PolicyDecision = { decisionId: string; decision: PolicyResult; policyVersion: number; reason: string; riskLevel: RiskLevel; traceId: string; roleId: string; roleVersion: number; action: Action; createdAt: string };
/** 角色策略输入的最小公共形状，便于单测使用自定义岗位。 */
export type RolePolicyInput = Pick<RoleDefinition, "roleId" | "roleVersion" | "allowedTools" | "allowedObjects" | "forbiddenActions" | "objectActions" | "pathPolicy" | "commandPolicy">;
/** 计划策略判断的最小 Task 形状，后续工作流可直接复用。 */
export type PolicyTask = Pick<Task, "id" | "projectId" | "ownerRole" | "version">;
/** 策略审计写入器；拒绝结果必须进入脱敏审计，而不写模型原文。 */
export type PolicyDecisionSink = (decision: PolicyDecision) => void | Promise<void>;

/** 将对象动作映射成可读的审计名称。 */
export function actionLabel(action: Action): string { return [action.kind, action.objectType ?? "", action.toolName ?? "", action.path ?? "", action.command ?? ""].filter(Boolean).join(":"); }
