import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OrganizationService } from "../../src/application/organization-service.js";
import { NativeCodingHarness } from "../../src/coding/native-harness.js";
import { FileGateway } from "../../src/execution/file-gateway.js";
import {
  CommandGateway,
  type CommandResult,
  type CommandRunner,
} from "../../src/execution/command-gateway.js";
import { VerificationOrchestrator } from "../../src/execution/verification.js";
import { WorkspaceManager } from "../../src/execution/workspace-manager.js";
import { newObjectId } from "../../src/domain/common.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import {
  createTestApp,
  makeProject,
  makeTask,
  useTestRoot,
} from "../helpers.js";

/** 让编码集成测试验证真实编排，但不依赖本机 Docker 或外部网络。 */
class SuccessfulCommandRunner implements CommandRunner {
  async run(
    _command: string,
    _workspacePath: string,
    _timeoutMs: number,
  ): Promise<CommandResult> {
    const now = new Date().toISOString();
    return {
      exitCode: 0,
      stdout: "verified",
      stderr: "",
      startedAt: now,
      endedAt: now,
      durationMs: 1,
      errorCode: null,
      runtime: "native",
    };
  }
}

/** 固定返回代码缺陷，用于验证有限诊断和重试上限不会静默循环。 */
class FailingCommandRunner implements CommandRunner {
  async run(
    _command: string,
    _workspacePath: string,
    _timeoutMs: number,
  ): Promise<CommandResult> {
    const now = new Date().toISOString();
    return {
      exitCode: 1,
      stdout: "",
      stderr: "type error in source",
      startedAt: now,
      endedAt: now,
      durationMs: 1,
      errorCode: null,
      runtime: "native",
    };
  }
}

/** 构造与既有组织/Attempt 绑定的 Task 7 CodingExecutionGrant。 */
async function fixture(runner: CommandRunner = new SuccessfulCommandRunner()) {
  const app = await createTestApp(useTestRoot());
  const project = makeProject();
  const task = makeTask(project.id, {
    ownerRole: "backend_developer",
    title: "编码 Agent 集成测试",
  });
  const projects = new ProjectTaskRepository();
  app.runtime.database.transaction((connection) => {
    projects.createProject(connection, project);
    projects.createTask(connection, task);
  });
  const sourceRoot = join(app.runtime.settings.workspacePath, "source-fixture");
  mkdirSync(join(sourceRoot, "src"), { recursive: true });
  writeFileSync(
    join(sourceRoot, "package.json"),
    JSON.stringify({
      scripts: {
        lint: "true",
        typecheck: "true",
        test: "true",
        build: "true",
        "db:check": "true",
      },
    }),
  );
  writeFileSync(
    join(sourceRoot, "src", "index.ts"),
    "export const value = 'old';\n",
  );
  const org = new OrganizationService(app.runtime.database);
  const attemptId = newObjectId("attempt");
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const legacyGrant = org.createExecutionGrant({
    projectId: project.id,
    taskId: task.id,
    attemptId,
    roleId: "backend_developer",
    modelConfigVersion: "0",
    workspaceRoot: "workspace://project",
    deadline: expiresAt,
    leaseExpiresAt: expiresAt,
    traceId: newObjectId("trace"),
  });
  const grant = {
    grantId: newObjectId("grant"),
    projectId: project.id,
    taskId: task.id,
    attemptId,
    role: "backend_developer",
    roleVersion: legacyGrant.roleVersion,
    taskVersion: 1,
    modelConfigVersion: 0,
    modelProvider: "unconfigured",
    modelName: "unconfigured",
    workspaceGrant: {
      root: "workspace://project",
      read: ["package.json", "src/**"],
      write: ["src/**"],
      deny: [".env*", "secrets/**"],
    },
    toolPolicy: [
      "repo_scan",
      "read_file",
      "search_code",
      "apply_patch",
      "run_verification",
      "save_evidence",
    ],
    commandPolicy: { allow: ["npm", "ruff"], network: "deny" },
    expiresAt,
    policyVersion: 1,
    traceId: legacyGrant.traceId,
  } as const;
  // 测试替身模拟 Scheduler 已领取 Attempt；生产路径由 workflow scheduler 写入同一租约字段。
  const workerId = `worker_${attemptId}`;
  app.runtime.database.saveWorkerLease(
    workerId,
    new Date().toISOString(),
    "active",
  );
  app.runtime.database.connection
    .prepare(
      "UPDATE execution_attempts SET worker_lease_id=?,status='running' WHERE id=?",
    )
    .run(workerId, attemptId);
  const workspaces = new WorkspaceManager(app.runtime.settings.workspacePath);
  const files = new FileGateway(workspaces, app.runtime.artifactStore);
  const harness = new NativeCodingHarness({
    database: app.runtime.database,
    artifactStore: app.runtime.artifactStore,
    workspaceManager: workspaces,
    fileGateway: files,
    verifier: new VerificationOrchestrator(new CommandGateway(runner), files),
    roleResolver: (roleId) => org.getRole(roleId),
  });
  const spec = {
    taskId: task.id,
    projectId: project.id,
    title: task.title,
    goal: "修改导出值并保留测试证据",
    acceptanceCriteria: ["导出值发生变化", "验证命令全部有真实结果"],
    workspaceRoot: "workspace://project",
    baselineCommit: "local-snapshot-sha",
    allowedPaths: ["package.json", "src/**"],
    forbiddenPaths: [".env*", "secrets/**"],
    stackProfile: "node-ts",
    verificationProfile: "backend-default",
    riskPolicy: "standard",
    taskVersion: 1,
  };
  return { app, harness, spec, grant, sourceRoot, project, task };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Task 7 NativeCodingHarness", () => {
  it("allocates isolated writable workspaces for separate Attempts", () => {
    const root = join(useTestRoot(), "workspaces");
    const sourceRoot = join(root, "source");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "src", "index.ts"),
      "export const value = 'old';\n",
    );
    const workspaces = new WorkspaceManager(root);
    const first = workspaces.createIsolatedWorkspace(
      "project-isolation",
      "attempt-one",
      sourceRoot,
    );
    const second = workspaces.createIsolatedWorkspace(
      "project-isolation",
      "attempt-two",
      sourceRoot,
    );

    expect(first.path).not.toBe(second.path);
    writeFileSync(
      join(first.path, "src", "index.ts"),
      "export const value = 'first';\n",
    );
    expect(workspaces.read(second.path, "src/index.ts").toString()).toBe(
      "export const value = 'old';\n",
    );
  });

  it("blocks an incomplete CodingTaskSpec before context or code mutation", async () => {
    const { app, harness, spec, grant, sourceRoot } = await fixture();
    const blocked = await harness.start(
      { ...spec, goal: "", acceptanceCriteria: [] },
      grant,
      { sourceRoot },
    );
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.nextAction).toContain("补齐");
    expect(harness.result(blocked.id).facts.actions).toHaveLength(0);
    await app.close();
  });

  it("rejects a missing Grant before creating a writable coding session", async () => {
    const { app, harness, spec, sourceRoot } = await fixture();
    await expect(
      harness.start(spec, undefined, { sourceRoot }),
    ).rejects.toThrow("CodingExecutionGrant 结构不完整");
    const count = (
      app.runtime.database.connection
        .prepare("SELECT COUNT(*) AS count FROM coding_sessions")
        .get() as { count: number }
    ).count;
    expect(count).toBe(0);
    await app.close();
  });

  it("completes Context → Plan → Policy → Patch → Verify → Handoff without auto-approving Review", async () => {
    const { app, harness, spec, grant, sourceRoot } = await fixture();
    const started = await harness.start(spec, grant, { sourceRoot });
    expect(started.status).toBe("IMPLEMENTING");
    expect(started.plan?.verificationCommands).toEqual([
      "ruff check .",
      "npm test -- --run",
      "npm run typecheck",
      "npm run db:check",
    ]);
    const observation = await harness.applyPatch(started.id, {
      input: {
        path: "src/index.ts",
        baseFileSha256: sha256("export const value = 'old';\n"),
        patch:
          "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const value = 'old';\n+export const value = 'new';\n",
      },
      reason: "更新导出值",
      idempotencyKey: `${started.id}:patch:1`,
    });
    expect(observation.status).toBe("succeeded");
    const replay = await harness.applyPatch(started.id, {
      input: {
        path: "src/index.ts",
        baseFileSha256: "ignored-on-idempotent-replay",
        patch: "ignored-on-idempotent-replay",
      },
      reason: "重放同一动作",
      idempotencyKey: `${started.id}:patch:1`,
    });
    expect(replay.observationId).toBe(observation.observationId);
    const verifying = harness.result(started.id).session;
    expect(verifying.status).toBe("VERIFYING");
    const reviewed = await harness.runVerification(started.id);
    expect(reviewed.status).toBe("REVIEW_REQUESTED");
    const handoff = await harness.requestHandoff(started.id);
    expect(handoff.status).toBe("review_requested");
    expect(handoff.changedFiles).toEqual(["src/index.ts"]);
    expect(harness.result(started.id).session.status).toBe("REVIEW_REQUESTED");
    const completed = await harness.reviewHandoff(
      started.id,
      "developer_representative",
      "approved",
      "变更和自测证据完整",
    );
    expect(completed.status).toBe("COMPLETED");
    const events = [];
    for await (const event of harness.stream(started.id))
      events.push(event.eventType);
    expect(events).toContain("CodingPatchApplied");
    expect(events).toContain("CodingVerificationPassed");
    await app.close();
  });

  it("rejects forbidden paths and base SHA conflicts without modifying the workspace", async () => {
    const { app, harness, spec, grant, sourceRoot } = await fixture();
    const started = await harness.start(spec, grant, { sourceRoot });
    const denied = await harness.applyPatch(started.id, {
      input: {
        path: "secrets/key.txt",
        baseFileSha256: "bad",
        patch:
          "--- a/secrets/key.txt\n+++ b/secrets/key.txt\n@@ -0,0 +1 @@\n+secret\n",
      },
      reason: "越权写入",
      idempotencyKey: `${started.id}:patch:denied`,
    });
    expect(denied.status).toBe("rejected");
    expect(denied.rejectionReason).toBe("PATH_DENIED");
    expect(harness.result(started.id).session.status).toBe("BLOCKED");
    await app.close();
  });

  it("keeps Review rejection under human control and does not complete the task", async () => {
    const { app, harness, spec, grant, sourceRoot } = await fixture();
    const started = await harness.start(spec, grant, { sourceRoot });
    await harness.applyPatch(started.id, {
      input: {
        path: "src/index.ts",
        baseFileSha256: sha256("export const value = 'old';\n"),
        patch:
          "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const value = 'old';\n+export const value = 'needs-review';\n",
      },
      reason: "准备人工 Review 驳回测试",
      idempotencyKey: `${started.id}:patch:review-reject`,
    });
    await harness.runVerification(started.id);
    await harness.requestHandoff(started.id);
    const changesRequested = await harness.reviewHandoff(
      started.id,
      "developer_representative",
      "changes_requested",
      "请补充边界测试证据",
    );
    expect(changesRequested.status).toBe("IMPLEMENTING");
    expect(harness.result(started.id).handoff?.status).toBe(
      "changes_requested",
    );
    expect(harness.result(started.id).session.status).not.toBe("COMPLETED");
    await app.close();
  });

  it("blocks Handoff when an extra workspace file appears after verification", async () => {
    const { app, harness, spec, grant, sourceRoot } = await fixture();
    const started = await harness.start(spec, grant, { sourceRoot });
    await harness.applyPatch(started.id, {
      input: {
        path: "src/index.ts",
        baseFileSha256: sha256("export const value = 'old';\n"),
        patch:
          "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const value = 'old';\n+export const value = 'handoff';\n",
      },
      reason: "准备交接范围校验测试",
      idempotencyKey: `${started.id}:patch:handoff-extra`,
    });
    const verified = await harness.runVerification(started.id);
    expect(verified.status).toBe("REVIEW_REQUESTED");
    writeFileSync(
      join(harness.result(started.id).session.workspacePath, "unexpected.out"),
      "unapproved change",
    );
    await expect(harness.requestHandoff(started.id)).rejects.toThrow(
      "额外工作区变更阻止交接",
    );
    expect(harness.result(started.id).session.status).toBe("BLOCKED");
    await app.close();
  });

  it("pauses without creating new actions and resumes from a checkpoint only when the snapshot matches", async () => {
    const { app, harness, spec, grant, sourceRoot } = await fixture();
    const started = await harness.start(spec, grant, { sourceRoot });
    const observation = await harness.applyPatch(started.id, {
      input: {
        path: "src/index.ts",
        baseFileSha256: sha256("export const value = 'old';\n"),
        patch:
          "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const value = 'old';\n+export const value = 'paused';\n",
      },
      reason: "准备暂停恢复测试",
      idempotencyKey: `${started.id}:patch:pause`,
    });
    expect(observation.status).toBe("succeeded");
    const paused = await harness.pause(started.id, "Boss 暂停检查");
    expect(paused.status).toBe("PAUSED");
    await expect(harness.applyPatch(started.id, {})).rejects.toThrow(
      "禁止执行新的工具动作",
    );
    const factsBefore = harness.result(started.id).facts.actions.length;
    const checkpoint = (await harness.stream(started.id).next()).value;
    expect(checkpoint).toBeTruthy();
    const rows = harness.result(started.id);
    const checkpointId = (
      app.runtime.database.connection
        .prepare(
          "SELECT id FROM coding_checkpoints WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(started.id) as { id: string }
    ).id;
    const resumed = await harness.resume(started.id, checkpointId);
    expect(resumed.status).toBe("IMPLEMENTING");
    expect(harness.result(started.id).facts.actions.length).toBe(factsBefore);
    void grant;
    void rows;
    await app.close();
  });

  it("records failure diagnosis, limits repair attempts, and blocks extra workspace changes", async () => {
    const failing = await fixture(new FailingCommandRunner());
    const started = await failing.harness.start(failing.spec, failing.grant, {
      sourceRoot: failing.sourceRoot,
    });
    await failing.harness.applyPatch(started.id, {
      input: {
        path: "src/index.ts",
        baseFileSha256: sha256("export const value = 'old';\n"),
        patch:
          "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const value = 'old';\n+export const value = 'repair-1';\n",
      },
      reason: "制造验证失败",
      idempotencyKey: `${started.id}:patch:1`,
    });
    let current = await failing.harness.runVerification(started.id);
    expect(current.status).toBe("DIAGNOSING");
    for (let index = 2; index <= 3; index += 1) {
      const checkpointId = (
        failing.app.runtime.database.connection
          .prepare(
            "SELECT id FROM coding_checkpoints WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(started.id) as { id: string }
      ).id;
      current = await failing.harness.resume(started.id, checkpointId);
      const previous = index === 2 ? "repair-1" : `repair-${index - 1}`;
      await failing.harness.applyPatch(started.id, {
        input: {
          path: "src/index.ts",
          baseFileSha256: sha256(`export const value = '${previous}';\n`),
          patch: [
            "--- a/src/index.ts",
            "+++ b/src/index.ts",
            "@@ -1 +1 @@",
            `-export const value = '${previous}';`,
            `+export const value = 'repair-${index}';`,
            "",
          ].join("\n"),
        },
        reason: "根据失败证据最小修复",
        idempotencyKey: `${started.id}:patch:${index}`,
      });
      current = await failing.harness.runVerification(started.id);
    }
    expect(current.status).toBe("BLOCKED");
    expect(
      failing.harness.result(started.id).session.failureDiagnoses,
    ).toHaveLength(3);
    await failing.app.close();

    const extra = await fixture();
    const extraStarted = await extra.harness.start(extra.spec, extra.grant, {
      sourceRoot: extra.sourceRoot,
    });
    writeFileSync(
      join(
        extra.harness.result(extraStarted.id).session.workspacePath,
        "generated.out",
      ),
      "unexpected",
    );
    const extraObservation = await extra.harness.applyPatch(extraStarted.id, {
      input: {
        path: "src/index.ts",
        baseFileSha256: sha256("export const value = 'old';\n"),
        patch:
          "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const value = 'old';\n+export const value = 'extra';\n",
      },
      reason: "触发额外变更门禁",
      idempotencyKey: `${extraStarted.id}:patch:1`,
    });
    expect(extraObservation.status).toBe("succeeded");
    expect((await extra.harness.runVerification(extraStarted.id)).status).toBe(
      "BLOCKED",
    );
    await extra.app.close();
  });
});
