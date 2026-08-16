import { describe, expect, it } from "vitest";
import { assertCompleteRoleDefinition, INITIAL_ROLES, RoleDefinition } from "../../src/domain/organization/definitions.js";
import { InvalidRoleDefinitionError } from "../../src/domain/errors.js";
import { PolicyGate } from "../../src/policy/policy-gate.js";
import { ExecutionGrant } from "../../src/policy/types.js";

/** 构造策略单测使用的未来有效授权，避免测试依赖系统当前时区。 */
function grant(roleId: string, roleVersion = 1): ExecutionGrant { return { projectId: "project_policy", taskId: "task_policy", attemptId: "attempt_policy", roleId, roleVersion, taskVersion: 1, workspaceGrant: { root: "workspace_policy", readOnly: false }, toolPolicy: [...(INITIAL_ROLES.find((role) => role.roleId === roleId)?.allowedTools ?? [])], commandPolicy: { allowedCommands: ["node", "npm", "npx", "vitest"], forbiddenCommands: ["rm", "sudo", "curl", "wget"] }, deadline: new Date(Date.now() + 60_000).toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), traceId: "tr_policy_test" }; }

describe("Task 3 Policy Gate", () => {
  it("rejects incomplete roles before activation", () => {
    const role = { ...INITIAL_ROLES[0], responsibilities: [] } as RoleDefinition;
    expect(() => assertCompleteRoleDefinition(role)).toThrow(InvalidRoleDefinitionError);
  });

  it("rejects technical approval by a product PM", async () => {
    const role = INITIAL_ROLES.find((item) => item.roleId === "product_market_pm") as RoleDefinition;
    const decision = await new PolicyGate().authorizeAction(role, { kind: "approve", objectType: "technical_solution", projectId: "project_policy", taskId: "task_policy" }, grant(role.roleId));
    expect(decision.decision).toBe("reject"); expect(decision.reason).toContain("Boss"); expect(decision.policyVersion).toBe(1); expect(decision.traceId).toBe("tr_policy_test");
  });

  it("rejects self Review approval and unauthorized tools", async () => {
    const developer = INITIAL_ROLES.find((item) => item.roleId === "frontend_developer") as RoleDefinition;
    const allowedWrite = await new PolicyGate().authorizeAction(developer, { kind: "use_tool", toolName: "file.write", path: "workspace://project/src/app.ts", pathMode: "write", projectId: "project_policy", taskId: "task_policy" }, grant(developer.roleId));
    expect(allowedWrite.decision).toBe("allow");
    const selfReview = await new PolicyGate().authorizeAction(developer, { kind: "approve", objectType: "review", projectId: "project_policy", taskId: "task_policy", actorInstanceId: "emp_03", subjectInstanceId: "emp_03" }, grant(developer.roleId));
    expect(selfReview.decision).toBe("reject"); expect(selfReview.reason).toContain("开发成员");
    const write = await new PolicyGate().authorizeAction(INITIAL_ROLES.find((item) => item.roleId === "functional_tester") as RoleDefinition, { kind: "use_tool", toolName: "file.write", path: "src/app.ts", pathMode: "write", projectId: "project_policy", taskId: "task_policy" }, grant("functional_tester"));
    expect(write.decision).toBe("reject");
    const keychain = await new PolicyGate().authorizeAction(developer, { kind: "use_tool", toolName: "keychain.read", projectId: "project_policy", taskId: "task_policy" }, grant(developer.roleId));
    expect(keychain.decision).toBe("reject"); expect(keychain.riskLevel).toBe("critical");
    const allowedTest = await new PolicyGate().authorizeAction(INITIAL_ROLES.find((item) => item.roleId === "functional_tester") as RoleDefinition, { kind: "use_tool", toolName: "test.run", projectId: "project_policy", taskId: "task_policy" }, grant("functional_tester"));
    expect(allowedTest.decision).toBe("allow");
  });

  it("rejects a stale role version from a previous grant", async () => {
    const role = INITIAL_ROLES.find((item) => item.roleId === "backend_developer") as RoleDefinition;
    const changed = { ...role, roleVersion: 2 };
    const decision = await new PolicyGate().authorizeAction(changed, { kind: "read", objectType: "task", projectId: "project_policy", taskId: "task_policy" }, grant(role.roleId, 1));
    expect(decision.decision).toBe("reject"); expect(decision.reason).toContain("过期");
  });
});
