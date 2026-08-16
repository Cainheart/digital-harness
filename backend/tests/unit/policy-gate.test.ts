import { describe, expect, it } from "vitest";
import {
  assertCompleteRoleDefinition,
  INITIAL_ROLES,
  RoleDefinition,
} from "../../src/domain/organization/definitions.js";
import { InvalidRoleDefinitionError } from "../../src/domain/errors.js";
import { PolicyGate } from "../../src/policy/policy-gate.js";
import { ExecutionGrant } from "../../src/policy/types.js";

/** 构造策略单测使用的未来有效授权，避免测试依赖系统当前时区。 */
function grant(roleId: string, roleVersion = 1): ExecutionGrant {
  const role = INITIAL_ROLES.find(
    (item) => item.roleId === roleId,
  ) as RoleDefinition;
  return {
    projectId: "project_policy",
    taskId: "task_policy",
    attemptId: "attempt_policy",
    roleId,
    roleVersion,
    taskVersion: 1,
    workspaceGrant: { root: "workspace_policy", readOnly: false },
    toolPolicy: [...role.allowedTools],
    commandPolicy: {
      allowedCommands: [...role.commandPolicy.allowedCommands],
      forbiddenCommands: [...role.commandPolicy.forbiddenCommands],
    },
    deadline: new Date(Date.now() + 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    traceId: "tr_policy_test",
  };
}

describe("Task 3 Policy Gate", () => {
  it("rejects incomplete roles before activation", () => {
    const role = {
      ...INITIAL_ROLES[0],
      responsibilities: [],
    } as RoleDefinition;
    expect(() => assertCompleteRoleDefinition(role)).toThrow(
      InvalidRoleDefinitionError,
    );
  });

  it("rejects technical approval by a product PM", async () => {
    const role = INITIAL_ROLES.find(
      (item) => item.roleId === "product_market_pm",
    ) as RoleDefinition;
    const decision = await new PolicyGate().authorizeAction(
      role,
      {
        kind: "approve",
        objectType: "technical_solution",
        projectId: "project_policy",
        taskId: "task_policy",
      },
      grant(role.roleId),
    );
    expect(decision.decision).toBe("reject");
    expect(decision.reason).toContain("Boss");
    expect(decision.policyVersion).toBe(1);
    expect(decision.traceId).toBe("tr_policy_test");
  });

  it("rejects self Review approval and unauthorized tools", async () => {
    const developer = INITIAL_ROLES.find(
      (item) => item.roleId === "frontend_developer",
    ) as RoleDefinition;
    const allowedWrite = await new PolicyGate().authorizeAction(
      developer,
      {
        kind: "use_tool",
        toolName: "file.write",
        path: "workspace://project/src/app.ts",
        pathMode: "write",
        projectId: "project_policy",
        taskId: "task_policy",
      },
      grant(developer.roleId),
    );
    expect(allowedWrite.decision).toBe("allow");
    const selfReview = await new PolicyGate().authorizeAction(
      developer,
      {
        kind: "approve",
        objectType: "review",
        projectId: "project_policy",
        taskId: "task_policy",
        actorInstanceId: "emp_03",
        subjectInstanceId: "emp_03",
      },
      grant(developer.roleId),
    );
    expect(selfReview.decision).toBe("reject");
    expect(selfReview.reason).toContain("开发成员");
    const write = await new PolicyGate().authorizeAction(
      INITIAL_ROLES.find(
        (item) => item.roleId === "functional_tester",
      ) as RoleDefinition,
      {
        kind: "use_tool",
        toolName: "file.write",
        path: "src/app.ts",
        pathMode: "write",
        projectId: "project_policy",
        taskId: "task_policy",
      },
      grant("functional_tester"),
    );
    expect(write.decision).toBe("reject");
    const keychain = await new PolicyGate().authorizeAction(
      developer,
      {
        kind: "use_tool",
        toolName: "keychain.read",
        projectId: "project_policy",
        taskId: "task_policy",
      },
      grant(developer.roleId),
    );
    expect(keychain.decision).toBe("reject");
    expect(keychain.riskLevel).toBe("critical");
    const allowedTest = await new PolicyGate().authorizeAction(
      INITIAL_ROLES.find(
        (item) => item.roleId === "functional_tester",
      ) as RoleDefinition,
      {
        kind: "use_tool",
        toolName: "test.run",
        projectId: "project_policy",
        taskId: "task_policy",
      },
      grant("functional_tester"),
    );
    expect(allowedTest.decision).toBe("allow");
  });

  it("rejects a stale role version from a previous grant", async () => {
    const role = INITIAL_ROLES.find(
      (item) => item.roleId === "backend_developer",
    ) as RoleDefinition;
    const changed = { ...role, roleVersion: 2 };
    const decision = await new PolicyGate().authorizeAction(
      changed,
      {
        kind: "read",
        objectType: "task",
        projectId: "project_policy",
        taskId: "task_policy",
      },
      grant(role.roleId, 1),
    );
    expect(decision.decision).toBe("reject");
    expect(decision.reason).toContain("过期");
  });

  it("rejects forged grant scope, malformed time, read-only writes and shell/path escapes", async () => {
    const developer = INITIAL_ROLES.find(
      (item) => item.roleId === "backend_developer",
    ) as RoleDefinition;
    const gate = new PolicyGate();
    const expanded = grant(developer.roleId);
    expanded.toolPolicy = [...expanded.toolPolicy, "keychain.read"];
    expect(
      (
        await gate.authorizeAction(
          developer,
          {
            kind: "use_tool",
            toolName: "file.read",
            path: "workspace://project/src/app.ts",
            pathMode: "read",
            projectId: "project_policy",
            taskId: "task_policy",
          },
          expanded,
        )
      ).reason,
    ).toContain("工具集合");
    const malformed = grant(developer.roleId);
    malformed.deadline = "not-a-date";
    expect(
      (
        await gate.authorizeAction(
          developer,
          {
            kind: "read",
            objectType: "task",
            projectId: "project_policy",
            taskId: "task_policy",
          },
          malformed,
        )
      ).reason,
    ).toContain("时间字段无效");
    const readOnly = grant(developer.roleId);
    readOnly.workspaceGrant.readOnly = true;
    expect(
      (
        await gate.authorizeAction(
          developer,
          {
            kind: "use_tool",
            toolName: "file.write",
            path: "workspace://project/src/app.ts",
            pathMode: "write",
            projectId: "project_policy",
            taskId: "task_policy",
          },
          readOnly,
        )
      ).decision,
    ).toBe("reject");
    expect(
      (
        await gate.authorizeCommand(
          developer,
          "npm test\nrm -rf /",
          grant(developer.roleId),
        )
      ).decision,
    ).toBe("reject");
    expect(
      (
        await gate.authorizeCommand(
          developer,
          "npm --prefix /tmp test",
          grant(developer.roleId),
        )
      ).decision,
    ).toBe("reject");
  });

  it("rejects an action when the task owner role is different from the grant role", async () => {
    const developer = INITIAL_ROLES.find(
      (item) => item.roleId === "backend_developer",
    ) as RoleDefinition;
    const grantForDeveloper = grant(developer.roleId);
    const decision = await new PolicyGate().evaluatePlan(
      developer,
      {
        id: "task_policy",
        projectId: "project_policy",
        ownerRole: "frontend_developer",
        version: 1,
      },
      {
        objective: "read task",
        actions: [
          {
            kind: "read",
            objectType: "task",
            projectId: "project_policy",
            taskId: "task_policy",
          },
        ],
        expectedArtifacts: [],
      },
      grantForDeveloper,
    );
    expect(decision.decision).toBe("reject");
    expect(decision.reason).toContain("明确负责人");
    const product = INITIAL_ROLES.find(
      (item) => item.roleId === "product_solution_pm",
    ) as RoleDefinition;
    const broadOwnerDecision = await new PolicyGate().evaluatePlan(
      product,
      {
        id: "task_policy",
        projectId: "project_policy",
        ownerRole: "developer",
        version: 1,
      },
      {
        objective: "read task",
        actions: [
          {
            kind: "read",
            objectType: "task",
            projectId: "project_policy",
            taskId: "task_policy",
          },
        ],
        expectedArtifacts: [],
      },
      grant(product.roleId),
    );
    expect(broadOwnerDecision.decision).toBe("reject");
    expect(broadOwnerDecision.reason).toContain("明确负责人");
  });

  it("rejects role definitions with unknown domains, tools or object actions", () => {
    const base = INITIAL_ROLES[0];
    expect(() =>
      assertCompleteRoleDefinition({
        ...base,
        domain: "unknown" as RoleDefinition["domain"],
      }),
    ).toThrow(InvalidRoleDefinitionError);
    expect(() =>
      assertCompleteRoleDefinition({
        ...base,
        allowedTools: [
          ...base.allowedTools,
          "unknown.tool",
        ] as RoleDefinition["allowedTools"],
      }),
    ).toThrow(InvalidRoleDefinitionError);
    expect(() =>
      assertCompleteRoleDefinition({
        ...base,
        objectActions: { ...base.objectActions, task: ["delete"] as never },
      }),
    ).toThrow(InvalidRoleDefinitionError);
  });

  it("rejects malformed plans and does not persist sensitive action fields", async () => {
    const developer = INITIAL_ROLES.find(
      (item) => item.roleId === "backend_developer",
    ) as RoleDefinition;
    const gate = new PolicyGate();
    const malformedPlan = await gate.evaluatePlan(
      developer,
      {
        id: "task_policy",
        projectId: "project_policy",
        ownerRole: developer.roleId,
        version: 1,
      },
      { objective: "", actions: [], expectedArtifacts: [] },
      grant(developer.roleId),
    );
    expect(malformedPlan.decision).toBe("reject");
    expect(malformedPlan.reason).toContain("计划格式");
    const unsafeAction = {
      kind: "read",
      objectType: "task",
      prompt: "system prompt=do not persist",
      projectId: "project_policy",
      taskId: "task_policy",
    } as never;
    const decision = await gate.authorizeAction(
      developer,
      unsafeAction,
      grant(developer.roleId),
    );
    expect(decision.decision).toBe("reject");
    expect(JSON.stringify(decision)).not.toContain("system prompt");
  });
});
