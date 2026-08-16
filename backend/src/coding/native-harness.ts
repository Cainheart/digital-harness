import type BetterSqlite3 from "better-sqlite3";
import { Database } from "../infra/database.js";
import { FileArtifactStore } from "../infra/artifacts.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import { CodingRepository } from "../infra/repositories/coding.js";
import { PolicyDecisionRepository } from "../policy/decision-repository.js";
import type { RoleDefinition } from "../domain/organization/definitions.js";
import {
  assertCodingGrantActive,
  assertCodingTransition,
  CodingAction,
  CodingExecutionGrant,
  CodingObservation,
  CodingPlan,
  CodingSession,
  CodingSessionStatus,
  CodingTaskSpec,
  FailureDiagnosis,
  HandoffPackage,
  parseCodingExecutionGrant,
  parseCodingTaskSpec,
  classifyFailure,
  isCodingPathAllowed,
} from "../domain/coding/index.js";
import {
  DomainError,
  PolicyDeniedError,
  WorkflowGuardBlockedError,
} from "../domain/errors.js";
import { utcNow, newObjectId } from "../domain/common.js";
import { WorkspaceManager } from "../execution/workspace-manager.js";
import { FileGateway } from "../execution/file-gateway.js";
import { VerificationOrchestrator } from "../execution/verification.js";
import { ContextBuilder } from "./context-builder.js";
import { DeterministicCodingPlanner, type CodingPlanner } from "./planner.js";
import { CodingPolicyGate } from "./policy.js";
import type { AgentHarness } from "./spi.js";

/** NativeCodingHarness 的依赖边界；业务状态推进仍由外层 Workflow Coordinator 负责。 */
export type NativeCodingHarnessDependencies = {
  database: Database;
  artifactStore: FileArtifactStore;
  workspaceManager: WorkspaceManager;
  fileGateway: FileGateway;
  verifier: VerificationOrchestrator;
  planner?: CodingPlanner;
  policy?: CodingPolicyGate;
  repository?: CodingRepository;
  eventStore?: SqliteEventStore;
  policyDecisions?: PolicyDecisionRepository;
  roleResolver: (roleId: string) => RoleDefinition;
};

/** Harness 向 Worker/控制台暴露的不可变事件最小视图。 */
export type AgentEvent = {
  eventId: string;
  eventType: string;
  aggregateVersion: number;
  payload: Record<string, unknown>;
  result: string;
  traceId: string;
  occurredAt: string;
};

/** 只实现 NativeCodingHarness；所有动作先策略校验，再由隔离工具产生事实。 */
export class NativeCodingHarness implements AgentHarness {
  private readonly repository: CodingRepository;
  private readonly events: SqliteEventStore;
  private readonly planner: CodingPlanner;
  private readonly policy: CodingPolicyGate;
  private readonly policyDecisions: PolicyDecisionRepository;
  private readonly contextBuilder: ContextBuilder;

  /** 组装可替换的上下文、计划、工具、验证和持久化边界。 */
  constructor(private readonly dependencies: NativeCodingHarnessDependencies) {
    this.repository = dependencies.repository ?? new CodingRepository();
    this.events = dependencies.eventStore ?? new SqliteEventStore();
    this.planner = dependencies.planner ?? new DeterministicCodingPlanner();
    this.policy = dependencies.policy ?? new CodingPolicyGate();
    this.policyDecisions =
      dependencies.policyDecisions ?? new PolicyDecisionRepository();
    this.contextBuilder = new ContextBuilder(dependencies.workspaceManager);
  }

  /** 创建 Attempt 对应的隔离会话，并同步走 Context → Plan → Policy 生命周期。 */
  async start(
    rawSpec: unknown,
    rawGrant: unknown,
    options: { sourceRoot?: string } = {},
  ): Promise<CodingSession> {
    const grant = parseCodingExecutionGrant(rawGrant);
    let spec: CodingTaskSpec;
    let blockedReason: string | null = null;
    try {
      spec = parseCodingTaskSpec(rawSpec);
    } catch (error) {
      const candidate =
        rawSpec && typeof rawSpec === "object"
          ? (rawSpec as Record<string, unknown>)
          : {};
      if (
        typeof candidate.projectId === "string" &&
        candidate.projectId !== grant.projectId
      )
        throw new PolicyDeniedError("CodingTaskSpec 项目范围与 Grant 不一致");
      if (
        typeof candidate.taskId === "string" &&
        candidate.taskId !== grant.taskId
      )
        throw new PolicyDeniedError("CodingTaskSpec 任务范围与 Grant 不一致");
      spec = incompleteSpec(candidate, grant);
      blockedReason = safeFailure(error);
    }
    // 修改日期：2026-08-17
    // 修改原因：TaskSpec 与 Grant 必须共享同一 workspaceRoot，防止授权工作区与任务声明不一致。
    if (
      spec.projectId !== grant.projectId ||
      spec.taskId !== grant.taskId ||
      spec.taskVersion !== grant.taskVersion ||
      spec.workspaceRoot !== grant.workspaceGrant.root
    ) {
      throw new PolicyDeniedError(
        "CodingTaskSpec 与 ExecutionGrant 绑定不一致",
        { data: { code: "POLICY_DENIED" } },
      );
    }
    // 修改日期：2026-08-17
    // 修改原因：只有 Scheduler 已领取且租约仍有效的 Attempt 才能创建可执行工作区，避免脱离 Worker 生命周期运行。
    this.assertAttemptReady(spec, grant);
    const workspace =
      this.dependencies.workspaceManager.createIsolatedWorkspace(
        spec.projectId,
        grant.attemptId,
        options.sourceRoot,
      );
    const sessionId = newObjectId("coding_session");
    const now = utcNow();
    const session: CodingSession = {
      id: sessionId,
      projectId: spec.projectId,
      taskId: spec.taskId,
      attemptId: grant.attemptId,
      role: grant.role,
      status: blockedReason ? "BLOCKED" : "CREATED",
      spec,
      grant,
      plan: null,
      workspacePath: workspace.path,
      baselineManifest: workspace.baselineManifest,
      currentDiffSummary: "",
      nextAction: blockedReason
        ? "补齐 CodingTaskSpec 后重新领取任务"
        : "build_context",
      failureDiagnoses: [],
      verificationIds: [],
      patchSeq: [],
      readFiles: [],
      changedFiles: [],
      version: 1,
      traceId: grant.traceId,
      createdAt: now,
      updatedAt: now,
    };
    this.dependencies.database.transaction((connection) => {
      this.repository.createSession(connection, session);
      this.appendEvent(connection, session, "CodingSessionCreated", {
        status: session.status,
      });
    });
    if (blockedReason) return session;
    try {
      return await this.prepareSession(sessionId);
    } catch (error) {
      return this.blockSession(sessionId, safeFailure(error));
    }
  }

  /** 从最近检查点恢复；恢复只改变会话状态，不重放已经有 Observation 的动作。 */
  async resume(
    sessionId: string,
    checkpointId: string,
  ): Promise<CodingSession> {
    const current = this.getSession(sessionId);
    const checkpoint = this.dependencies.database.transaction((connection) =>
      this.repository.getCheckpoint(
        connection,
        current.projectId,
        sessionId,
        checkpointId,
      ),
    );
    if (
      current.status !== "PAUSED" &&
      current.status !== "BLOCKED" &&
      current.status !== "DIAGNOSING"
    )
      throw new WorkflowGuardBlockedError(
        "当前会话没有可恢复的暂停/阻塞检查点",
      );
    if (
      checkpoint.workspaceSnapshot !==
      this.dependencies.workspaceManager.snapshotDigest(current.workspacePath)
    )
      throw new WorkflowGuardBlockedError(
        "工作区快照与恢复检查点不一致，已阻止恢复",
        { data: { code: "WORKSPACE_CONFLICT" } },
      );
    try {
      assertCodingGrantActive(current.grant);
    } catch (error) {
      return this.blockExpiredGrant(sessionId, error);
    }
    // 修改日期：2026-08-17
    // 修改原因：恢复前重新通过当前 PolicyGate，防止暂停期间 Grant、角色策略
    // 或命令白名单变化后直接执行。
    if (!current.plan) {
      throw new WorkflowGuardBlockedError("恢复会话缺少已审批的 CodingPlan");
    }
    const role = this.dependencies.roleResolver(current.role);
    let decision: Awaited<ReturnType<CodingPolicyGate["evaluatePlan"]>>;
    try {
      decision = await this.policy.evaluatePlan(
        role,
        current.spec,
        current.plan,
        current.grant,
      );
    } catch (error) {
      return this.blockExpiredGrant(sessionId, error);
    }
    this.dependencies.database.transaction((connection) => {
      this.policyDecisions.save(connection, decision, {
        projectId: current.projectId,
        taskId: current.taskId,
        attemptId: current.attemptId,
      });
    });
    if (decision.decision !== "allow") {
      return this.blockSession(sessionId, decision.reason);
    }
    return this.transition(
      current,
      "IMPLEMENTING",
      "CodingSessionResumed",
      "continue_from_checkpoint",
    );
  }

  /** 暂停当前会话并保存上下文；暂停成功后任何工具动作都会被拒绝。 */
  async pause(sessionId: string, reason: string): Promise<CodingSession> {
    if (!reason.trim()) throw new WorkflowGuardBlockedError("暂停原因不能为空");
    const current = this.getSession(sessionId);
    if (
      ![
        "CONTEXT_BUILDING",
        "PLAN_READY",
        "POLICY_PENDING",
        "IMPLEMENTING",
        "VERIFYING",
        "DIAGNOSING",
      ].includes(current.status)
    )
      throw new WorkflowGuardBlockedError("当前状态不能暂停");
    return this.dependencies.database.transaction((connection) => {
      const next = this.nextSession(
        current,
        "PAUSED",
        "resume_from_checkpoint",
      );
      this.repository.updateSession(connection, next, current.version);
      this.repository.createCheckpoint(connection, {
        id: newObjectId("checkpoint"),
        projectId: current.projectId,
        sessionId,
        patchSeq: current.patchSeq.at(-1) ?? 0,
        state: this.checkpointState(next),
        workspaceSnapshot: this.dependencies.workspaceManager.snapshotDigest(
          current.workspacePath,
        ),
        reason,
        traceId: current.traceId,
        createdAt: utcNow(),
      });
      this.appendEvent(connection, next, "CodingSessionPaused", { reason });
      return next;
    });
  }

  /** 取消会话并保留工作区、动作、观察、验证和诊断证据。 */
  async cancel(sessionId: string, reason: string): Promise<CodingSession> {
    if (!reason.trim()) throw new WorkflowGuardBlockedError("取消原因不能为空");
    const current = this.getSession(sessionId);
    if (["CANCELLED", "COMPLETED"].includes(current.status)) return current;
    return this.transition(
      current,
      "CANCELLED",
      "CodingSessionCancelled",
      reason,
    );
  }

  /** 以小批量 unified diff 修改单个文件，并在成功后进入 VERIFYING。 */
  async applyPatch(
    sessionId: string,
    rawAction: unknown,
  ): Promise<CodingObservation> {
    const current = this.getSession(sessionId);
    const action = parseAction(
      rawAction,
      sessionId,
      current.patchSeq.length + 1,
      "apply_patch",
    );
    const existing = this.dependencies.database.transaction((connection) =>
      this.repository.getActionByIdempotency(connection, action.idempotencyKey),
    );
    if (existing?.observation) return existing.observation;
    if (existing?.status === "running")
      throw new WorkflowGuardBlockedError(
        "检测到未完成的 Patch 动作，禁止重复执行",
        { data: { code: "WORKSPACE_CONFLICT" } },
      );
    try {
      this.assertExecutable(current);
    } catch (error) {
      return this.blockExpiredGrant(sessionId, error);
    }
    const role = this.dependencies.roleResolver(current.role);
    let decision: Awaited<ReturnType<CodingPolicyGate["authorizeAction"]>>;
    try {
      decision = await this.policy.authorizeAction(
        role,
        current.spec,
        action,
        current.grant,
      );
    } catch (error) {
      return this.blockExpiredGrant(sessionId, error);
    }
    if (decision.decision !== "allow") {
      const code = decision.reason.includes("路径")
        ? "PATH_DENIED"
        : "POLICY_DENIED";
      this.dependencies.database.transaction((connection) =>
        this.policyDecisions.save(connection, decision, {
          projectId: current.projectId,
          taskId: current.taskId,
          attemptId: current.attemptId,
        }),
      );
      return this.recordRejectedAction(current, action, decision.reason, code);
    }
    this.dependencies.database.transaction((connection) => {
      this.repository.createAction(connection, {
        projectId: current.projectId,
        action,
        traceId: current.traceId,
        createdAt: utcNow(),
      });
      this.repository.setActionStatus(connection, action.actionId, "running");
      this.policyDecisions.save(connection, decision, {
        projectId: current.projectId,
        taskId: current.taskId,
        attemptId: current.attemptId,
      });
    });
    try {
      const input = action.input as Record<string, unknown>;
      const path = stringField(input, "path");
      const patch = stringField(input, "patch");
      const baseFileSha256 = stringField(input, "baseFileSha256");
      const result = await this.dependencies.fileGateway.applyPatch({
        workspacePath: current.workspacePath,
        path,
        baseFileSha256,
        patch,
        spec: current.spec,
        grant: current.grant,
      });
      const changedFiles = this.dependencies.workspaceManager.changedFiles(
        current.workspacePath,
        current.baselineManifest,
      );
      const observation: CodingObservation = {
        observationId: newObjectId("observation"),
        actionId: action.actionId,
        status: "succeeded",
        exitCode: 0,
        changedFiles: [{ path, before: result.before, after: result.after }],
        stdoutRef: null,
        stderrRef: null,
        diffRef: result.diffRef.storeRef,
        durationMs: 0,
        rejectionReason: null,
        redactions: [],
        traceId: current.traceId,
      };
      return this.dependencies.database.transaction((connection) => {
        const next = this.nextSession(
          current,
          "VERIFYING",
          "run_verification",
          {
            patchSeq: [...current.patchSeq, action.seq],
            changedFiles,
            currentDiffSummary:
              `${current.currentDiffSummary}\n--- ${path} ---\n${patch}`.slice(
                -2_000_000,
              ),
          },
        );
        this.repository.createObservation(connection, {
          projectId: current.projectId,
          observation,
          createdAt: utcNow(),
        });
        this.repository.updateSession(connection, next, current.version);
        this.repository.createCheckpoint(connection, {
          id: newObjectId("checkpoint"),
          projectId: current.projectId,
          sessionId,
          patchSeq: action.seq,
          state: this.checkpointState(next),
          workspaceSnapshot: this.dependencies.workspaceManager.snapshotDigest(
            current.workspacePath,
          ),
          reason: "patch_applied",
          traceId: current.traceId,
          createdAt: utcNow(),
        });
        this.appendEvent(connection, next, "CodingPatchApplied", {
          actionId: action.actionId,
          path,
          patchSeq: action.seq,
          changedFiles,
        });
        return observation;
      });
    } catch (error) {
      return this.recordRejectedAction(
        current,
        action,
        safeFailure(error),
        rejectionCode(error),
      );
    }
  }

  /** 执行版本化验证阶梯；成功进入 REVIEW_REQUESTED，失败进入有限诊断或 BLOCKED。 */
  async runVerification(sessionId: string): Promise<CodingSession> {
    const current = this.getSession(sessionId);
    if (current.status !== "VERIFYING")
      throw new WorkflowGuardBlockedError(
        "只有已产生 Patch 的会话才能开始验证",
      );
    const currentFiles = this.dependencies.workspaceManager.changedFiles(
      current.workspacePath,
      current.baselineManifest,
    );
    const extra = currentFiles.filter(
      (path) => !isAllowedChangedPath(path, current.spec, current.grant),
    );
    if (extra.length > 0)
      return this.blockSession(
        sessionId,
        `检测到任务范围外的额外变更: ${extra.join(", ")}`,
      );
    const run = await this.dependencies.verifier.run(
      sessionId,
      current.workspacePath,
      current.spec,
      current.grant,
      current.failureDiagnoses.length,
      current.traceId,
    );
    return this.dependencies.database.transaction((connection) => {
      this.repository.createVerification(connection, run);
      const next =
        run.status === "succeeded"
          ? this.nextSession(
              current,
              "REVIEW_REQUESTED",
              "developer_representative_review",
            )
          : this.failureSession(current, run);
      next.verificationIds = [...current.verificationIds, run.verificationId];
      next.changedFiles = currentFiles;
      this.repository.updateSession(connection, next, current.version);
      this.repository.createCheckpoint(connection, {
        id: newObjectId("checkpoint"),
        projectId: current.projectId,
        sessionId,
        patchSeq: current.patchSeq.at(-1) ?? 0,
        state: this.checkpointState(next),
        workspaceSnapshot: this.dependencies.workspaceManager.snapshotDigest(
          current.workspacePath,
        ),
        reason:
          run.status === "succeeded"
            ? "verification_passed"
            : "verification_failed",
        traceId: current.traceId,
        createdAt: utcNow(),
      });
      if (run.status === "succeeded")
        this.appendEvent(connection, next, "CodingVerificationPassed", {
          verificationId: run.verificationId,
          commands: run.steps.map((step) => step.command),
        });
      else
        this.appendEvent(connection, next, "CodingVerificationFailed", {
          verificationId: run.verificationId,
          failureClass: run.failureClass,
          retryCount: run.retryCount,
        });
      return next;
    });
  }

  /** 生成包含完整 diff、验证、风险和回滚快照的 Review Handoff，不产生审批结果。 */
  async requestHandoff(sessionId: string): Promise<HandoffPackage> {
    const session = this.getSession(sessionId);
    if (session.status !== "REVIEW_REQUESTED")
      throw new WorkflowGuardBlockedError("当前会话尚未满足 Review 交接条件");
    // 修改日期：2026-08-17
    // 修改原因：交接前再次核对工作区，覆盖验证完成后到人工 Review 前产生的额外文件变更。
    const currentFiles = this.dependencies.workspaceManager.changedFiles(
      session.workspacePath,
      session.baselineManifest,
    );
    const extra = currentFiles.filter(
      (path) => !isAllowedChangedPath(path, session.spec, session.grant),
    );
    if (extra.length > 0) {
      await this.blockSession(
        sessionId,
        `检测到任务范围外的额外变更: ${extra.join(", ")}`,
      );
      throw new WorkflowGuardBlockedError("额外工作区变更阻止交接", {
        data: { code: "WORKSPACE_CONFLICT", extraFiles: extra },
      });
    }
    const existing = this.dependencies.database.transaction((connection) =>
      this.repository.getHandoff(connection, sessionId),
    );
    if (existing) return existing;
    // 修改日期：2026-08-17
    // 修改原因：Handoff 的命令摘要必须来自真实 VerificationRun，不能把模型计划中的
    // 未执行命令当作验证证据。
    const facts = this.dependencies.database.transaction((connection) =>
      this.repository.listFacts(connection, sessionId),
    );
    const commands = facts.verifications.flatMap((run) =>
      run.steps.map((step) => step.command),
    );
    const diff = await this.dependencies.artifactStore.put(
      Buffer.from(session.currentDiffSummary, "utf8"),
      "text/x-diff",
      { projectId: session.projectId, artifactId: `diff_${session.id}` },
    );
    const handoff: HandoffPackage = {
      handoffId: newObjectId("handoff"),
      sessionId,
      status: "review_requested",
      summary: session.plan?.goal ?? session.spec.goal,
      changedFiles: session.changedFiles,
      diffRef: diff.storeRef,
      verificationRuns: [...session.verificationIds],
      commands,
      remainingRisks: session.plan?.risks ?? [],
      knownFailures: session.failureDiagnoses.map((item) => item.summary),
      rollback: {
        workspaceSnapshot: this.dependencies.workspaceManager.snapshotDigest(
          session.workspacePath,
        ),
        patchSeq: [...session.patchSeq],
      },
      traceId: session.traceId,
    };
    this.dependencies.database.transaction((connection) =>
      this.repository.createHandoff(
        connection,
        session.projectId,
        handoff,
        utcNow(),
      ),
    );
    return handoff;
  }

  /** 只接受开发代表的人工 Review 决策；approved 后才允许会话进入 COMPLETED。 */
  async reviewHandoff(
    sessionId: string,
    reviewerRole: string,
    decision: "approved" | "changes_requested" | "blocked",
    comments: string,
  ): Promise<CodingSession> {
    if (reviewerRole !== "developer_representative")
      throw new PolicyDeniedError("只有开发代表可以处理编码 Review");
    if (!comments.trim() && decision !== "approved")
      throw new WorkflowGuardBlockedError("Review 驳回或阻塞必须填写非空意见");
    const current = this.getSession(sessionId);
    if (current.status !== "REVIEW_REQUESTED")
      throw new WorkflowGuardBlockedError("当前会话不在等待 Review 状态");
    const target: CodingSessionStatus =
      decision === "approved"
        ? "COMPLETED"
        : decision === "changes_requested"
          ? "IMPLEMENTING"
          : "BLOCKED";
    return this.dependencies.database.transaction((connection) => {
      this.repository.reviewHandoff(connection, {
        projectId: current.projectId,
        sessionId,
        decision,
        comments,
        reviewer: reviewerRole,
        reviewedAt: utcNow(),
      });
      const next = this.nextSession(
        current,
        target,
        decision === "approved"
          ? "outer_workflow_may_advance"
          : decision === "changes_requested"
            ? "apply_review_feedback"
            : "manual_resolution_required",
      );
      this.repository.updateSession(connection, next, current.version);
      this.appendEvent(connection, next, "CodingReviewRecorded", {
        decision,
        reviewerRole,
      });
      return next;
    });
  }

  /** 返回可查询的完整执行结果；不把模型隐藏提示词或凭据带出。 */
  result(sessionId: string): {
    session: CodingSession;
    handoff: HandoffPackage | null;
    facts: ReturnType<CodingRepository["listFacts"]>;
  } {
    return this.dependencies.database.transaction((connection) => ({
      session: this.repository.getSession(connection, sessionId),
      handoff: this.repository.getHandoff(connection, sessionId),
      facts: this.repository.listFacts(connection, sessionId),
    }));
  }

  /** 以已提交 DomainEvent 顺序流式读取会话事件，重启后仍可从数据库重建。 */
  async *stream(sessionId: string): AsyncGenerator<AgentEvent> {
    const events = this.dependencies.database.transaction((connection) =>
      this.events.listForAggregate(connection, "coding_session", sessionId),
    );
    for (const event of events)
      yield {
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateVersion: event.aggregateVersion,
        payload: event.payload,
        result: event.result,
        traceId: event.traceId,
        occurredAt: event.occurredAt,
      };
  }

  private async prepareSession(sessionId: string): Promise<CodingSession> {
    let current = this.getSession(sessionId);
    current = await this.transition(
      current,
      "CONTEXT_BUILDING",
      "CodingContextBuilding",
      "build_context",
    );
    const context = await this.contextBuilder.build(
      current.workspacePath,
      current.spec,
      current.grant,
    );
    if (context.missingItems.length > 0)
      return this.blockSession(
        sessionId,
        `上下文不完整: ${context.missingItems.join(", ")}`,
      );
    const plan = await this.planner.generate(current.spec, context, current.id);
    validatePlanActions(plan, current.id);
    current = await this.transition(
      current,
      "PLAN_READY",
      "CodingPlanReady",
      "policy_check",
      { plan },
    );
    current = await this.transition(
      current,
      "POLICY_PENDING",
      "CodingPolicyPending",
      "evaluate_plan",
    );
    const role = this.dependencies.roleResolver(current.role);
    const decision = await this.policy.evaluatePlan(
      role,
      current.spec,
      plan,
      current.grant,
    );
    this.dependencies.database.transaction((connection) =>
      this.policyDecisions.save(connection, decision, {
        projectId: current.projectId,
        taskId: current.taskId,
        attemptId: current.attemptId,
      }),
    );
    if (decision.decision !== "allow")
      return this.blockSession(sessionId, decision.reason);
    return this.transition(
      current,
      "IMPLEMENTING",
      "CodingPolicyAllowed",
      "implement",
    );
  }

  private getSession(sessionId: string): CodingSession {
    return this.dependencies.database.transaction((connection) =>
      this.repository.getSession(connection, sessionId),
    );
  }

  private async transition(
    current: CodingSession,
    target: CodingSessionStatus,
    eventType: string,
    nextAction: string,
    changes: Partial<CodingSession> = {},
  ): Promise<CodingSession> {
    assertCodingTransition(current.status, target);
    const next = this.nextSession(current, target, nextAction, changes);
    return this.dependencies.database.transaction((connection) => {
      this.repository.updateSession(connection, next, current.version);
      this.appendEvent(connection, next, eventType, {
        from: current.status,
        to: target,
        nextAction,
      });
      return next;
    });
  }

  private nextSession(
    current: CodingSession,
    status: CodingSessionStatus,
    nextAction: string,
    changes: Partial<CodingSession> = {},
  ): CodingSession {
    return {
      ...current,
      ...changes,
      status,
      nextAction,
      version: current.version + 1,
      updatedAt: utcNow(),
    };
  }

  private async blockSession(
    sessionId: string,
    reason: string,
  ): Promise<CodingSession> {
    const current = this.getSession(sessionId);
    if (current.status === "BLOCKED") return current;
    assertCodingTransition(current.status, "BLOCKED");
    const next = this.nextSession(
      current,
      "BLOCKED",
      "manual_resolution_required",
    );
    next.currentDiffSummary =
      `${current.currentDiffSummary}\n阻塞原因：${reason}`.slice(-2_000_000);
    return this.dependencies.database.transaction((connection) => {
      this.repository.updateSession(connection, next, current.version);
      this.appendEvent(connection, next, "CodingSessionBlocked", {
        reason: reason.slice(0, 1000),
      });
      return next;
    });
  }

  /** 过期授权必须转为持久化 BLOCKED；其他状态门禁只返回原始拒绝。 */
  private async blockExpiredGrant(
    sessionId: string,
    error: unknown,
  ): Promise<never> {
    if (rejectionCode(error) === "GRANT_EXPIRED") {
      await this.blockSession(sessionId, safeFailure(error));
    }
    throw error;
  }

  private failureSession(
    current: CodingSession,
    run: Awaited<ReturnType<VerificationOrchestrator["run"]>>,
  ): CodingSession {
    const failureClass =
      run.failureClass ??
      classifyFailure({
        errorCode: null,
        exitCode: 1,
        stderr: "unknown verification failure",
      });
    const sameClassCount =
      current.failureDiagnoses.filter(
        (item) => item.failureClass === failureClass,
      ).length + 1;
    const diagnosis: FailureDiagnosis = {
      diagnosisId: newObjectId("diagnosis"),
      failureClass,
      summary: `验证 Profile ${current.spec.verificationProfile} 失败`,
      rootCauseHypothesis:
        failureClass === "CODE_DEFECT"
          ? "代码、类型或测试断言需要最小修复"
          : "需要根据验证输出和运行环境进一步确认",
      nextAction:
        failureClass === "POLICY" || failureClass === "CREDENTIAL"
          ? "交接责任人处理授权或凭据"
          : "基于失败证据生成最小修复 Patch",
      retryNumber: sameClassCount,
      maxRetries: 2,
      evidenceRefs: run.steps.flatMap((step) =>
        [step.stdoutRef, step.stderrRef].filter((value): value is string =>
          Boolean(value),
        ),
      ),
      traceId: current.traceId,
    };
    const diagnoses = [...current.failureDiagnoses, diagnosis];
    const exhausted =
      sameClassCount > 2 ||
      diagnoses.length > 3 ||
      ["POLICY", "CREDENTIAL", "UNKNOWN"].includes(failureClass);
    return this.nextSession(
      current,
      exhausted ? "BLOCKED" : "DIAGNOSING",
      exhausted ? "manual_resolution_required" : "prepare_minimal_repair",
      { failureDiagnoses: diagnoses },
    );
  }

  private async recordRejectedAction(
    current: CodingSession,
    action: CodingAction,
    reason: string,
    code: string,
  ): Promise<CodingObservation> {
    const observation: CodingObservation = {
      observationId: newObjectId("observation"),
      actionId: action.actionId,
      status: "rejected",
      exitCode: null,
      changedFiles: [],
      stdoutRef: null,
      stderrRef: null,
      diffRef: null,
      durationMs: 0,
      rejectionReason: rejectionCodeToReason(code),
      redactions: [],
      traceId: current.traceId,
    };
    await this.dependencies.database.transaction((connection) => {
      this.repository.createAction(connection, {
        projectId: current.projectId,
        action,
        traceId: current.traceId,
        createdAt: utcNow(),
      });
      this.repository.createObservation(connection, {
        projectId: current.projectId,
        observation,
        createdAt: utcNow(),
      });
      const next = this.nextSession(
        current,
        "BLOCKED",
        "manual_resolution_required",
        {
          currentDiffSummary:
            `${current.currentDiffSummary}\n拒绝原因：${reason}`.slice(
              -2_000_000,
            ),
        },
      );
      this.repository.updateSession(connection, next, current.version);
      this.appendEvent(connection, next, "CodingActionRejected", {
        actionId: action.actionId,
        rejectionReason: observation.rejectionReason,
      });
    });
    return observation;
  }

  private assertExecutable(session: CodingSession): void {
    if (session.status !== "IMPLEMENTING")
      throw new WorkflowGuardBlockedError("当前会话禁止执行新的工具动作", {
        data: { code: "SESSION_NOT_EXECUTABLE", status: session.status },
      });
    assertCodingGrantActive(session.grant);
    this.assertAttemptReady(session.spec, session.grant);
  }

  /** 检查 Attempt 的项目、任务、角色、running 状态和未过期 Worker lease。 */
  private assertAttemptReady(
    spec: CodingTaskSpec,
    grant: CodingExecutionGrant,
  ): void {
    const attempt = this.dependencies.database.transaction(
      (connection) =>
        connection
          .prepare(
            `
            SELECT ea.project_id, ea.task_id, ea.role, ea.status,
                   wl.status AS lease_status, wl.heartbeat_at
            FROM execution_attempts ea
            LEFT JOIN worker_leases wl ON wl.worker_id = ea.worker_lease_id
            WHERE ea.id=?
          `,
          )
          .get(grant.attemptId) as
          | {
              project_id: string;
              task_id: string;
              role: string;
              status: string;
              lease_status: string | null;
              heartbeat_at: string | null;
            }
          | undefined,
    );
    const leaseActive =
      attempt?.lease_status === "active" &&
      attempt.heartbeat_at !== null &&
      Number.isFinite(Date.parse(attempt.heartbeat_at)) &&
      Date.now() - Date.parse(attempt.heartbeat_at) <= 300_000;
    if (
      !attempt ||
      attempt.project_id !== spec.projectId ||
      attempt.task_id !== spec.taskId ||
      attempt.role !== grant.role ||
      attempt.status !== "running" ||
      !leaseActive
    ) {
      throw new WorkflowGuardBlockedError(
        "ExecutionAttempt 未被有效 Worker lease 领取，编码执行保持阻塞",
        { data: { code: "WORKER_LEASE_REQUIRED", attemptId: grant.attemptId } },
      );
    }
  }

  private checkpointState(session: CodingSession): Record<string, unknown> {
    return {
      taskGoal: session.spec.goal,
      constraints: {
        allowedPaths: session.spec.allowedPaths,
        forbiddenPaths: session.spec.forbiddenPaths,
        riskPolicy: session.spec.riskPolicy,
      },
      readFiles: session.readFiles,
      changedFiles: session.changedFiles,
      currentDiffSummary: session.currentDiffSummary,
      commands: session.plan?.verificationCommands ?? [],
      failures: session.failureDiagnoses,
      verificationResults: session.verificationIds,
      unresolved: [],
      remainingRisks: session.plan?.risks ?? [],
      nextAction: session.nextAction,
      artifactRefs: [],
      traceId: session.traceId,
    };
  }

  private appendEvent(
    connection: BetterSqlite3.Database,
    session: CodingSession,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const expectedVersion = Math.max(0, session.version - 1);
    this.events.append(
      connection,
      "coding_session",
      session.id,
      expectedVersion,
      [
        {
          eventType,
          aggregateType: "coding_session",
          aggregateId: session.id,
          payload: {
            projectId: session.projectId,
            sessionId: session.id,
            ...payload,
          },
          inputSummary: { sessionId: session.id },
          outputSummary: { status: session.status },
          result: "success",
          failure: null,
          retryCount: 0,
          durationMs: 0,
          actor: { type: "coding_agent", id: session.role },
          traceId: session.traceId,
          occurredAt: session.updatedAt,
          attemptId: session.attemptId,
          rejectionReason: null,
          redactionReason:
            "source and model internals remain outside the event payload",
          eventCategory: "ordinary",
        },
      ],
    );
  }
}

/** 判断工作区变更是否同时满足 TaskSpec 和 Grant 的可写路径授权。 */
function isAllowedChangedPath(
  path: string,
  spec: CodingTaskSpec,
  grant: CodingExecutionGrant,
): boolean {
  return isCodingPathAllowed(path, "write", spec, grant);
}

/** 校验 Planner 提出的动作仍绑定当前会话且序号唯一。 */
function validatePlanActions(plan: CodingPlan, sessionId: string): void {
  const sequences = new Set<number>();
  for (const action of plan.proposedActions) {
    if (action.sessionId !== sessionId) {
      throw new PolicyDeniedError("CodingPlan 动作未绑定当前会话", {
        data: { code: "POLICY_DENIED" },
      });
    }
    if (sequences.has(action.seq)) {
      throw new PolicyDeniedError("CodingPlan 动作序号重复", {
        data: { code: "POLICY_DENIED" },
      });
    }
    sequences.add(action.seq);
  }
}

/** 规范化动作输入并固定序号、会话、幂等键和动作类型。 */
function parseAction(
  raw: unknown,
  sessionId: string,
  seq: number,
  expectedType: CodingAction["type"],
): CodingAction {
  if (!raw || typeof raw !== "object")
    throw new PolicyDeniedError("编码动作必须是结构化对象");
  const value = raw as Record<string, unknown>;
  const action: CodingAction = {
    actionId:
      typeof value.actionId === "string"
        ? value.actionId
        : newObjectId("action"),
    sessionId,
    seq,
    type: expectedType,
    input:
      value.input && typeof value.input === "object"
        ? (value.input as Record<string, unknown>)
        : {},
    reason:
      typeof value.reason === "string" && value.reason.trim()
        ? value.reason
        : "incremental patch",
    idempotencyKey:
      typeof value.idempotencyKey === "string" && value.idempotencyKey.trim()
        ? value.idempotencyKey
        : `${sessionId}:${seq}:apply_patch`,
    requiresApproval: false,
  };
  if (!action.actionId || !action.idempotencyKey)
    throw new PolicyDeniedError("编码动作缺少幂等标识");
  return action;
}

/** 从动作输入读取非空字符串；畸形输入不会落盘为伪造执行证据。 */
function stringField(input: Record<string, unknown>, name: string): string {
  if (typeof input[name] !== "string" || !input[name].trim())
    throw new PolicyDeniedError(`${name} 必须是非空字符串`, {
      data: { code: "PATH_DENIED" },
    });
  return input[name] as string;
}

/** 错误只保留脱敏原因摘要，供事件和诊断使用。 */
function safeFailure(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return error instanceof Error ? error.message.slice(0, 1000) : "编码执行失败";
}

/** 将工具异常映射为稳定拒绝码，不把底层路径/命令原文写入错误载荷。 */
function rejectionCode(error: unknown): string {
  if (
    error instanceof DomainError &&
    error.data &&
    typeof error.data === "object" &&
    "code" in error.data
  )
    return String((error.data as { code: unknown }).code);
  if (error instanceof WorkflowGuardBlockedError)
    return "SESSION_NOT_EXECUTABLE";
  return "BASE_VERSION_MISMATCH";
}

/** 将内部拒绝码映射到 Observation 固定枚举。 */
function rejectionCodeToReason(
  code: string,
): CodingObservation["rejectionReason"] {
  const values: CodingObservation["rejectionReason"][] = [
    "PATH_DENIED",
    "COMMAND_DENIED",
    "GRANT_EXPIRED",
    "RESOURCE_LIMIT",
    "NETWORK_DENIED",
    "SECRET_ACCESS_DENIED",
    "BASE_VERSION_MISMATCH",
    "APPROVAL_REQUIRED",
    "SESSION_NOT_EXECUTABLE",
    "WORKSPACE_CONFLICT",
  ];
  return values.includes(code as CodingObservation["rejectionReason"])
    ? (code as CodingObservation["rejectionReason"])
    : "SESSION_NOT_EXECUTABLE";
}

/** 将缺字段任务固化为不可执行的阻塞投影，避免为错误输入产生代码变更。 */
function incompleteSpec(
  value: Record<string, unknown>,
  grant: CodingExecutionGrant,
): CodingTaskSpec {
  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
  return {
    taskId: grant.taskId,
    projectId: grant.projectId,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title
        : "未命名编码任务",
    goal: typeof value.goal === "string" ? value.goal : "",
    acceptanceCriteria: strings(value.acceptanceCriteria),
    workspaceRoot: grant.workspaceGrant.root,
    baselineCommit:
      typeof value.baselineCommit === "string" && value.baselineCommit.trim()
        ? value.baselineCommit
        : "missing-baseline",
    allowedPaths: strings(value.allowedPaths),
    forbiddenPaths: strings(value.forbiddenPaths),
    stackProfile:
      typeof value.stackProfile === "string" && value.stackProfile.trim()
        ? value.stackProfile
        : "unknown",
    verificationProfile:
      typeof value.verificationProfile === "string" &&
      value.verificationProfile.trim()
        ? value.verificationProfile
        : "unknown",
    riskPolicy: "standard",
    taskVersion: grant.taskVersion,
  };
}
