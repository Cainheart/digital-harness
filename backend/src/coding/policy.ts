import { randomUUID } from "node:crypto";
import type { RoleDefinition } from "../domain/organization/definitions.js";
import { PolicyGate } from "../policy/policy-gate.js";
import type { ExecutionGrant, PolicyDecision } from "../policy/types.js";
import {
  CodingAction,
  CodingExecutionGrant,
  CodingPlan,
  CodingTaskSpec,
  assertCodingGrantActive,
  isCodingCommandAllowed,
  isCodingPathAllowed,
  verificationCommands,
} from "../domain/coding/index.js";
import { PolicyDeniedError } from "../domain/errors.js";

/** 将 Task 7 工具映射到既有 Task 3 PolicyGate，保持角色/版本/审批边界单一。 */
export class CodingPolicyGate {
  constructor(private readonly policy = new PolicyGate()) {}

  /** 校验计划的结构、任务范围、路径、命令和既有角色策略。 */
  async evaluatePlan(
    role: RoleDefinition,
    spec: CodingTaskSpec,
    plan: CodingPlan,
    grant: CodingExecutionGrant,
  ): Promise<PolicyDecision> {
    assertCodingGrantActive(grant);
    if (
      grant.projectId !== spec.projectId ||
      grant.taskId !== spec.taskId ||
      grant.taskVersion !== spec.taskVersion
    ) {
      throw new PolicyDeniedError(
        "CodingExecutionGrant 与 CodingTaskSpec 版本或范围不一致",
        { data: { code: "POLICY_DENIED" } },
      );
    }
    for (const path of plan.affectedFiles) {
      if (!isCodingPathAllowed(path, "read", spec, grant))
        return this.reject(
          role,
          grant,
          {
            kind: "use_tool",
            toolName: "file.read",
            path,
            pathMode: "read",
            projectId: spec.projectId,
            taskId: spec.taskId,
          },
          "计划读取了未授权路径",
        );
    }
    for (const command of plan.verificationCommands) {
      if (!isCodingCommandAllowed(command, grant.commandPolicy.allow))
        return this.reject(
          role,
          grant,
          {
            kind: "use_tool",
            toolName: "command.run",
            command,
            projectId: spec.projectId,
            taskId: spec.taskId,
          },
          "计划包含未授权验证命令",
        );
    }
    const profileCommands = verificationCommands(spec.verificationProfile);
    if (
      JSON.stringify(plan.verificationCommands) !==
      JSON.stringify(profileCommands)
    ) {
      return this.reject(
        role,
        grant,
        {
          kind: "use_tool",
          toolName: "test.run",
          command: plan.verificationCommands.join(" && "),
          projectId: spec.projectId,
          taskId: spec.taskId,
        },
        "计划验证命令必须完全匹配版本化 VerificationProfile",
      );
    }
    for (const action of plan.proposedActions) {
      const decision = await this.authorizeAction(role, spec, action, grant);
      if (decision.decision !== "allow") return decision;
    }
    return this.allow(
      role,
      grant,
      { kind: "read", projectId: spec.projectId, taskId: spec.taskId },
      "结构化计划通过 CodingGrant 和既有 PolicyGate",
    );
  }

  /** 每次真实动作前重新校验 Grant、路径、工具和命令，不信任启动时的旧判断。 */
  async authorizeAction(
    role: RoleDefinition,
    spec: CodingTaskSpec,
    action: CodingAction,
    grant: CodingExecutionGrant,
  ): Promise<PolicyDecision> {
    assertCodingGrantActive(grant);
    const mapped = toPolicyAction(action, spec);
    const input = action.input as Record<string, unknown>;
    const actionPath = typeof input.path === "string" ? input.path : "";
    if (
      (mapped.pathMode &&
        !isCodingPathAllowed(actionPath, mapped.pathMode, spec, grant)) ||
      (mapped.command &&
        !isCodingCommandAllowed(mapped.command, grant.commandPolicy.allow))
    ) {
      return this.reject(
        role,
        grant,
        mapped,
        "CodingTaskSpec 或 Grant 拒绝了路径/命令",
      );
    }
    return this.policy.authorizeAction(
      role,
      mapped,
      toPolicyGrant(grant, role),
    );
  }

  private allow(
    role: RoleDefinition,
    grant: CodingExecutionGrant,
    action: Parameters<PolicyGate["authorizeAction"]>[1],
    reason: string,
  ): PolicyDecision {
    return {
      decisionId: `decision_${randomUUID()}`,
      decision: "allow",
      policyVersion: grant.policyVersion,
      reason,
      riskLevel: "low",
      traceId: grant.traceId,
      roleId: role.roleId,
      roleVersion: role.roleVersion,
      action,
      createdAt: new Date().toISOString(),
    };
  }

  private reject(
    role: RoleDefinition,
    grant: CodingExecutionGrant,
    action: Parameters<PolicyGate["authorizeAction"]>[1],
    reason: string,
  ): PolicyDecision {
    return {
      ...this.allow(role, grant, action, reason),
      decision: "reject",
      riskLevel: "high",
      reason,
    };
  }
}

/** 将 CodingAction 转成 Task 3 PolicyGate 能理解的最小 Action。 */
function toPolicyAction(
  action: CodingAction,
  spec: CodingTaskSpec,
): Parameters<PolicyGate["authorizeAction"]>[1] {
  const input = action.input as Record<string, unknown>;
  if (action.type === "apply_patch")
    return {
      kind: "use_tool",
      toolName: "file.write",
      path: policyPath(stringInput(input.path)),
      pathMode: "write",
      projectId: spec.projectId,
      taskId: spec.taskId,
    };
  if (
    action.type === "read_file" ||
    action.type === "search_code" ||
    action.type === "repo_scan"
  )
    return {
      kind: "use_tool",
      toolName: "file.read",
      path: policyPath(
        typeof input.path === "string" ? input.path : "README.md",
      ),
      pathMode: "read",
      projectId: spec.projectId,
      taskId: spec.taskId,
    };
  if (action.type === "run_verification")
    return {
      kind: "use_tool",
      toolName: "test.run",
      command: stringInput(input.command),
      projectId: spec.projectId,
      taskId: spec.taskId,
    };
  return {
    kind: "use_tool",
    toolName: "evidence.write",
    projectId: spec.projectId,
    taskId: spec.taskId,
  };
}

/** 只允许动作输入中的字符串路径/命令进入策略；畸形输入在策略层拒绝。 */
function stringInput(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 既有 PolicyGate 使用 workspace URI；CodingGrant 仍保持相对路径最小权限。 */
function policyPath(value: string): string {
  return value.startsWith("workspace://")
    ? value
    : `workspace://project/${value}`;
}

/** 建立与既有 PolicyGate 对齐的不可变兼容 Grant，不扩大角色原有权限。 */
function toPolicyGrant(
  grant: CodingExecutionGrant,
  role: RoleDefinition,
): ExecutionGrant {
  const allowedTools = new Set<string>();
  for (const tool of grant.toolPolicy) {
    if (["read_file", "search_code", "repo_scan"].includes(tool))
      allowedTools.add("file.read");
    if (tool === "apply_patch") allowedTools.add("file.write");
    if (tool === "run_verification") {
      allowedTools.add("test.run");
      allowedTools.add("command.run");
    }
    if (tool === "save_evidence") allowedTools.add("evidence.write");
  }
  return {
    projectId: grant.projectId,
    taskId: grant.taskId,
    attemptId: grant.attemptId,
    roleId: grant.role,
    roleVersion: grant.roleVersion,
    taskVersion: grant.taskVersion,
    workspaceGrant: {
      root: "workspace://project",
      readOnly: grant.workspaceGrant.write.length === 0,
    },
    toolPolicy: [...allowedTools] as ExecutionGrant["toolPolicy"],
    commandPolicy: {
      allowedCommands: role.commandPolicy.allowedCommands,
      forbiddenCommands: role.commandPolicy.forbiddenCommands,
    },
    deadline: grant.expiresAt,
    leaseExpiresAt: grant.expiresAt,
    traceId: grant.traceId,
  };
}
