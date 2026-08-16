import { randomUUID } from "node:crypto";
import { utcNow } from "../domain/common.js";
import { PolicyDeniedError } from "../domain/errors.js";
import { canonicalRoleId, RoleDefinition } from "../domain/organization/definitions.js";
import { Action, ExecutionGrant, PolicyDecision, PolicyDecisionSink, PolicyTask, PolicyResult, RiskLevel, StructuredPlan } from "./types.js";

/** Policy Gate 的确定性实现；模型计划只能提出动作，最终权限由本类裁决。 */
export class PolicyGate {
  /** 创建策略门禁并注入可选的脱敏审计写入器。 */
  constructor(private readonly options: { sink?: PolicyDecisionSink } = {}) {}

  /** 在一个结构化计划执行前逐项检查角色、任务、工具和路径范围。 */
  async evaluatePlan(role: RoleDefinition, task: PolicyTask, plan: StructuredPlan, grant: ExecutionGrant): Promise<PolicyDecision> {
    const base: Action = { kind: "read", projectId: task.projectId, taskId: task.id };
    const grantDecision = this.checkGrant(role, task, base, grant);
    if (grantDecision) return this.persist(grantDecision);
    for (const action of plan.actions) { const decision = this.evaluate(role, task, action, grant); if (decision.decision !== "allow") return this.persist(decision); }
    return this.persist(this.decision(role, { ...base, kind: "read" }, "allow", "计划内所有动作均通过岗位和执行授权检查", "low", grant.traceId));
  }

  /** 校验单个动作；越权结果带固定原因、策略版本、风险等级和 traceId。 */
  async authorizeAction(role: RoleDefinition, action: Action, grant: ExecutionGrant): Promise<PolicyDecision> {
    const task: PolicyTask = { id: grant.taskId, projectId: grant.projectId, ownerRole: role.roleId, version: grant.taskVersion };
    return this.persist(this.evaluate(role, task, action, grant));
  }

  /** 校验工作区路径是否落在岗位授权目录内。 */
  authorizePath(role: RoleDefinition, path: string, mode: "read" | "write", grant: ExecutionGrant): PolicyDecision {
    return this.evaluate(role, { id: grant.taskId, projectId: grant.projectId, ownerRole: role.roleId, version: grant.taskVersion }, { kind: "use_tool", toolName: mode === "read" ? "file.read" : "file.write", path, pathMode: mode, projectId: grant.projectId, taskId: grant.taskId }, grant);
  }

  /** 校验命令是否命中白名单，拒绝 shell 组合和危险命令。 */
  authorizeCommand(role: RoleDefinition, command: string, grant: ExecutionGrant): PolicyDecision {
    return this.evaluate(role, { id: grant.taskId, projectId: grant.projectId, ownerRole: role.roleId, version: grant.taskVersion }, { kind: "use_tool", toolName: "command.run", command, projectId: grant.projectId, taskId: grant.taskId, riskLevel: "high" }, grant);
  }

  /** 根据当前岗位和任务版本生成 Worker 使用的执行授权。 */
  createGrant(input: { projectId: string; taskId: string; attemptId: string; taskVersion: number; role: RoleDefinition; workspaceRoot: string; deadline: string; leaseExpiresAt: string; traceId: string }): ExecutionGrant {
    return { projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId, roleId: canonicalRoleId(input.role.roleId), roleVersion: input.role.roleVersion, taskVersion: input.taskVersion, workspaceGrant: { root: input.workspaceRoot, readOnly: !input.role.pathPolicy.writeRoots.length }, toolPolicy: [...input.role.allowedTools], commandPolicy: { allowedCommands: [...input.role.commandPolicy.allowedCommands], forbiddenCommands: [...input.role.commandPolicy.forbiddenCommands] }, deadline: input.deadline, leaseExpiresAt: input.leaseExpiresAt, traceId: input.traceId };
  }

  /** 对外提供确定性的策略判断，不直接执行任何文件或命令。 */
  private evaluate(role: RoleDefinition, task: PolicyTask, action: Action, grant: ExecutionGrant): PolicyDecision {
    const grantDecision = this.checkGrant(role, task, action, grant); if (grantDecision) return grantDecision;
    const risk = this.risk(action);
    if (action.kind === "use_tool") return this.checkTool(role, action, grant, risk);
    if (action.kind === "send_message") return this.decision(role, action, "allow", "结构化消息属于跨岗位交接能力", risk, grant.traceId);
    if (action.kind === "approve" && action.objectType === "technical_solution") return this.decision(role, action, "reject", "岗位不能替 Boss 提交或批准技术方案审批", "high", grant.traceId);
    if (action.kind === "approve" && action.objectType === "review" && action.actorInstanceId && action.subjectInstanceId && action.actorInstanceId === action.subjectInstanceId) return this.decision(role, action, "reject", "开发成员不能批准自己的 Review，必须交接给开发代表", "high", grant.traceId);
    const objectType = action.objectType ?? ""; const allowedActions = role.objectActions[objectType] ?? [];
    if (!role.allowedObjects.includes(objectType) || !allowedActions.includes(action.kind as "read" | "create" | "update" | "approve")) return this.decision(role, action, "reject", `岗位 ${role.title} 不允许对 ${objectType || "未指定对象"} 执行 ${action.kind}`, risk, grant.traceId);
    if (action.kind === "approve" && role.forbiddenActions.includes("approve_own_review")) return this.decision(role, action, "reject", "岗位禁止执行自身 Review 审批", "high", grant.traceId);
    if (risk === "critical") return this.decision(role, action, "approval_required", "高风险动作需要人工审批", risk, grant.traceId);
    return this.decision(role, action, "allow", "动作通过角色和对象策略", risk, grant.traceId);
  }

  /** 先检查授权绑定，防止跨项目、跨任务或使用过期岗位版本。 */
  private checkGrant(role: RoleDefinition, task: PolicyTask, action: Action, grant: ExecutionGrant): PolicyDecision | null {
    if (canonicalRoleId(grant.roleId) !== canonicalRoleId(role.roleId)) return this.decision(role, action, "reject", "ExecutionGrant 的岗位与当前岗位不一致", "high", grant.traceId);
    if (grant.roleVersion !== role.roleVersion) return this.decision(role, action, "reject", "ExecutionGrant 使用了过期岗位策略版本", "high", grant.traceId);
    if (grant.projectId !== task.projectId || grant.taskId !== task.id || (action.projectId && action.projectId !== grant.projectId) || (action.taskId && action.taskId !== grant.taskId)) return this.decision(role, action, "reject", "动作超出 ExecutionGrant 的项目或任务范围", "high", grant.traceId);
    if (Date.parse(grant.leaseExpiresAt) <= Date.now() || Date.parse(grant.deadline) <= Date.now()) return this.decision(role, action, "reject", "ExecutionGrant 已过期", "high", grant.traceId);
    return null;
  }

  /** 检查工具白名单、文件模式和命令白名单。 */
  private checkTool(role: RoleDefinition, action: Action, grant: ExecutionGrant, risk: RiskLevel): PolicyDecision {
    const tool = String(action.toolName ?? ""); if (!role.allowedTools.includes(tool as RoleDefinition["allowedTools"][number]) || !grant.toolPolicy.includes(tool as RoleDefinition["allowedTools"][number])) return this.decision(role, action, "reject", `岗位不允许使用工具 ${tool || "未指定工具"}`, risk, grant.traceId);
    if (tool === "file.read" || tool === "file.write") { const path = action.path ?? ""; if (!this.pathMatches(path, role.pathPolicy.readRoots) || (tool === "file.write" && (!role.pathPolicy.writeRoots.length || !this.pathMatches(path, role.pathPolicy.writeRoots)))) return this.decision(role, action, "reject", "路径不在岗位授权范围内", "high", grant.traceId); }
    if (tool === "command.run") { const command = action.command?.trim() ?? ""; const first = command.split(/\s+/)[0] ?? ""; if (!command || /[|;&><`$]/.test(command) || role.commandPolicy.forbiddenCommands.includes(first) || grant.commandPolicy.forbiddenCommands.includes(first) || !role.commandPolicy.allowedCommands.includes(first) || !grant.commandPolicy.allowedCommands.includes(first)) return this.decision(role, action, "reject", "命令未命中岗位白名单或包含禁止的 shell 组合", "high", grant.traceId); }
    if (tool === "keychain.read") return this.decision(role, action, "reject", "数字员工不能直接访问 Keychain", "critical", grant.traceId);
    return this.decision(role, action, "allow", `工具 ${tool} 通过策略检查`, risk, grant.traceId);
  }

  /** 使用安全的 URI/相对路径模式匹配，不解析或跟随外部文件系统路径。 */
  private pathMatches(path: string, roots: string[]): boolean { const workspacePrefix = "workspace://project/"; const comparable = path.startsWith(workspacePrefix) ? path.slice(workspacePrefix.length) : path; if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || comparable.split("/").some((part) => part === ".." || part === "." || !part)) return false; return roots.some((root) => { const rootPrefix = root.endsWith("/**") ? root.slice(0, -2) : root; const comparableRoot = rootPrefix.startsWith(workspacePrefix) ? rootPrefix.slice(workspacePrefix.length) : rootPrefix; return root.endsWith("/**") ? path.startsWith(rootPrefix) || comparable.startsWith(comparableRoot) : path === rootPrefix || comparable === comparableRoot; }); }
  /** 为审计和 UI 生成固定风险等级。 */
  private risk(action: Action): RiskLevel { return action.riskLevel ?? (action.kind === "approve" || action.kind === "assign_task" ? "high" : action.kind === "use_tool" && action.toolName === "keychain.read" ? "critical" : action.kind === "use_tool" && action.toolName === "command.run" ? "high" : action.kind === "use_tool" && action.toolName === "file.write" ? "medium" : "low"); }
  /** 物化一条带版本和 trace 的策略判断。 */
  private decision(role: RoleDefinition, action: Action, decision: PolicyResult, reason: string, riskLevel: RiskLevel, traceId: string): PolicyDecision { return { decisionId: `policy_${randomUUID().replaceAll("-", "")}`, decision, policyVersion: role.roleVersion, reason, riskLevel, traceId, roleId: canonicalRoleId(role.roleId), roleVersion: role.roleVersion, action, createdAt: utcNow() }; }
  /** 写入脱敏策略审计；sink 失败不改变已经做出的拒绝语义。 */
  private async persist(decision: PolicyDecision): Promise<PolicyDecision> { if (this.options.sink) await this.options.sink(decision); return decision; }
}

/** 将拒绝结果转换为命令/API 可以直接抛出的稳定策略异常。 */
export function requirePolicyAllowed(decision: PolicyDecision): void { if (decision.decision !== "allow") throw new PolicyDeniedError(decision.reason, { traceId: decision.traceId, data: { decision: decision.decision, policyVersion: decision.policyVersion, riskLevel: decision.riskLevel } }); }
