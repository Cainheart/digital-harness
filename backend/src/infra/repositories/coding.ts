import BetterSqlite3 from "better-sqlite3";
import {
  CodingAction,
  CodingExecutionGrant,
  CodingObservation,
  CodingPlan,
  CodingSession,
  CodingSessionStatus,
  CodingTaskSpec,
  FailureDiagnosis,
  HandoffPackage,
  VerificationRun,
} from "../../domain/coding/index.js";
import {
  IdempotencyKeyReusedError,
  NotFoundError,
  VersionConflictError,
} from "../../domain/errors.js";
import {
  ensureProjectChild,
  ensureProjectWritable,
  jsonText,
  jsonValue,
} from "./common.js";

/** 保存 Task 7 会话投影与不可变动作/观察/验证/交接事实。 */
export class CodingRepository {
  /** 创建版本为 1 的编码会话，并固定 TaskSpec、Grant 和工作区基线。 */
  createSession(
    connection: BetterSqlite3.Database,
    session: CodingSession,
  ): void {
    ensureProjectWritable(connection, session.projectId);
    ensureProjectChild(connection, "tasks", session.projectId, session.taskId);
    ensureProjectChild(
      connection,
      "execution_attempts",
      session.projectId,
      session.attemptId,
    );
    connection
      .prepare(
        `
          INSERT INTO coding_sessions (
            id, project_id, task_id, attempt_id, role, status, spec_json,
            grant_json, plan_json, workspace_path, baseline_manifest_json,
            current_diff_summary, next_action, failure_diagnoses_json,
            verification_ids_json, patch_seq_json, read_files_json,
            changed_files_json, version, trace_id, created_at, updated_at
          )
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `,
      )
      .run(
        session.id,
        session.projectId,
        session.taskId,
        session.attemptId,
        session.role,
        session.status,
        jsonText(session.spec),
        jsonText(session.grant),
        session.plan ? jsonText(session.plan) : null,
        session.workspacePath,
        jsonText(session.baselineManifest),
        session.currentDiffSummary,
        session.nextAction,
        jsonText(session.failureDiagnoses),
        jsonText(session.verificationIds),
        jsonText(session.patchSeq),
        jsonText(session.readFiles),
        jsonText(session.changedFiles),
        session.version,
        session.traceId,
        session.createdAt,
        session.updatedAt,
      );
  }

  /** 读取完整会话投影；历史 Action/Observation 仍通过独立查询保留。 */
  getSession(connection: BetterSqlite3.Database, id: string): CodingSession {
    const row = connection
      .prepare("SELECT * FROM coding_sessions WHERE id=?")
      .get(id) as CodingSessionRow | undefined;
    if (!row) throw new NotFoundError("编码会话不存在");
    return sessionFromRow(row);
  }

  /** 按 project/task 查询会话，防止调用方跨项目读取执行上下文。 */
  getSessionInProject(
    connection: BetterSqlite3.Database,
    projectId: string,
    id: string,
  ): CodingSession {
    const session = this.getSession(connection, id);
    if (session.projectId !== projectId)
      throw new NotFoundError("编码会话不属于指定项目");
    return session;
  }

  /** 按 expectedVersion 原子更新当前投影，历史动作和观察不会被覆盖。 */
  updateSession(
    connection: BetterSqlite3.Database,
    session: CodingSession,
    expectedVersion: number,
  ): CodingSession {
    const result = connection
      .prepare(
        `
          UPDATE coding_sessions
          SET status=?, plan_json=?, current_diff_summary=?, next_action=?,
              failure_diagnoses_json=?, verification_ids_json=?, patch_seq_json=?,
              read_files_json=?, changed_files_json=?, version=?, updated_at=?
          WHERE id=? AND version=?
        `,
      )
      .run(
        session.status,
        session.plan ? jsonText(session.plan) : null,
        session.currentDiffSummary,
        session.nextAction,
        jsonText(session.failureDiagnoses),
        jsonText(session.verificationIds),
        jsonText(session.patchSeq),
        jsonText(session.readFiles),
        jsonText(session.changedFiles),
        session.version,
        session.updatedAt,
        session.id,
        expectedVersion,
      );
    if (result.changes !== 1)
      throw new VersionConflictError("编码会话版本冲突，未覆盖最新执行事实");
    return session;
  }

  /** 以幂等键保存一次动作提案；同键重复请求只返回原始动作。 */
  createAction(
    connection: BetterSqlite3.Database,
    input: {
      projectId: string;
      action: CodingAction;
      traceId: string;
      createdAt: string;
    },
  ): { action: CodingAction; created: boolean } {
    const existing = connection
      .prepare("SELECT * FROM coding_actions WHERE idempotency_key=?")
      .get(input.action.idempotencyKey) as CodingActionRow | undefined;
    if (existing) {
      const previous = actionFromRow(existing);
      if (JSON.stringify(previous.action) !== JSON.stringify(input.action))
        throw new IdempotencyKeyReusedError("编码动作幂等键被不同动作复用");
      return { action: previous.action, created: false };
    }
    connection
      .prepare(
        `
          INSERT INTO coding_actions (
            id, project_id, session_id, seq, type, action_json, reason,
            idempotency_key, status, observation_id, trace_id, created_at
          )
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `,
      )
      .run(
        input.action.actionId,
        input.projectId,
        input.action.sessionId,
        input.action.seq,
        input.action.type,
        jsonText(input.action),
        input.action.reason,
        input.action.idempotencyKey,
        "proposed",
        null,
        input.traceId,
        input.createdAt,
      );
    return { action: input.action, created: true };
  }

  /** 读取幂等动作及其当前 Observation，供重试恢复避免重复 Patch/命令。 */
  getActionByIdempotency(
    connection: BetterSqlite3.Database,
    key: string,
  ): {
    action: CodingAction;
    status: string;
    observation: CodingObservation | null;
  } | null {
    const row = connection
      .prepare("SELECT * FROM coding_actions WHERE idempotency_key=?")
      .get(key) as
      | (CodingActionRow & {
          session_id: string;
          observation_id: string | null;
        })
      | undefined;
    if (!row) return null;
    const observation = row.observation_id
      ? (connection
          .prepare("SELECT result_json FROM coding_observations WHERE id=?")
          .get(row.observation_id) as { result_json: string } | undefined)
      : undefined;
    return {
      action: jsonValue<CodingAction>(row.action_json),
      status: row.status,
      observation: observation
        ? jsonValue<CodingObservation>(observation.result_json)
        : null,
    };
  }

  /** 在可能产生外部副作用前固定动作状态；恢复时 running 动作不会被盲目重放。 */
  setActionStatus(
    connection: BetterSqlite3.Database,
    actionId: string,
    status: "running" | "proposed",
  ): void {
    connection
      .prepare(
        "UPDATE coding_actions SET status=? WHERE id=? AND status='proposed'",
      )
      .run(status, actionId);
  }

  /** 读取最近检查点并确认其属于当前项目/会话。 */
  getCheckpoint(
    connection: BetterSqlite3.Database,
    projectId: string,
    sessionId: string,
    checkpointId: string,
  ): {
    id: string;
    state: Record<string, unknown>;
    workspaceSnapshot: string;
    patchSeq: number;
  } {
    const row = connection
      .prepare(
        "SELECT * FROM coding_checkpoints WHERE project_id=? AND session_id=? AND id=?",
      )
      .get(projectId, sessionId, checkpointId) as CheckpointRow | undefined;
    if (!row) throw new NotFoundError("恢复检查点不存在或不属于当前会话");
    return {
      id: row.id,
      state: jsonValue<Record<string, unknown>>(row.state_json),
      workspaceSnapshot: row.workspace_snapshot,
      patchSeq: row.patch_seq,
    };
  }

  /** 保存不可变 Observation，并把动作投影标记为最终结果。 */
  createObservation(
    connection: BetterSqlite3.Database,
    input: {
      projectId: string;
      observation: CodingObservation;
      createdAt: string;
    },
  ): void {
    const action = connection
      .prepare("SELECT session_id FROM coding_actions WHERE id=?")
      .get(input.observation.actionId) as { session_id: string } | undefined;
    if (!action) throw new NotFoundError("编码动作不存在");
    ensureProjectChild(
      connection,
      "coding_sessions",
      input.projectId,
      action.session_id,
      "id",
    );
    connection
      .prepare(
        `
          INSERT INTO coding_observations (
            id, project_id, session_id, action_id, status, rejection_reason,
            result_json, trace_id, created_at
          )
          VALUES (?,?,?,?,?,?,?,?,?)
        `,
      )
      .run(
        input.observation.observationId,
        input.projectId,
        action.session_id,
        input.observation.actionId,
        input.observation.status,
        input.observation.rejectionReason,
        jsonText(input.observation),
        input.observation.traceId,
        input.createdAt,
      );
    connection
      .prepare("UPDATE coding_actions SET status=?,observation_id=? WHERE id=?")
      .run(
        input.observation.status,
        input.observation.observationId,
        input.observation.actionId,
      );
  }

  /** 保存恢复检查点；检查点只新增，不更新已有上下文。 */
  createCheckpoint(
    connection: BetterSqlite3.Database,
    input: {
      projectId: string;
      sessionId: string;
      patchSeq: number;
      state: Record<string, unknown>;
      workspaceSnapshot: string;
      reason: string;
      traceId: string;
      createdAt: string;
      id: string;
    },
  ): void {
    connection
      .prepare(
        `
          INSERT INTO coding_checkpoints (
            id, project_id, session_id, patch_seq, state_json,
            workspace_snapshot, reason, trace_id, created_at
          )
          VALUES (?,?,?,?,?,?,?,?,?)
        `,
      )
      .run(
        input.id,
        input.projectId,
        input.sessionId,
        input.patchSeq,
        jsonText(input.state),
        input.workspaceSnapshot,
        input.reason,
        input.traceId,
        input.createdAt,
      );
  }

  /** 保存一次真实验证的逐命令结果和失败分类。 */
  createVerification(
    connection: BetterSqlite3.Database,
    run: VerificationRun,
  ): void {
    connection
      .prepare(
        `
          INSERT INTO coding_verification_runs (
            id, project_id, session_id, profile, status, steps_json,
            failure_class, retry_count, trace_id, created_at, completed_at
          )
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `,
      )
      .run(
        run.verificationId,
        this.getSession(connection, run.sessionId).projectId,
        run.sessionId,
        run.profile,
        run.status,
        jsonText(run.steps),
        run.failureClass,
        run.retryCount,
        run.traceId,
        run.createdAt,
        run.completedAt,
      );
  }

  /** 保存唯一交接包；交接包生成后等待人工 Review，不自动批准。 */
  createHandoff(
    connection: BetterSqlite3.Database,
    projectId: string,
    handoff: HandoffPackage,
    createdAt: string,
  ): void {
    connection
      .prepare(
        `
          INSERT INTO coding_handoffs (
            id, project_id, session_id, status, package_json, review_decision,
            review_comments, reviewed_by, created_at, reviewed_at
          )
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `,
      )
      .run(
        handoff.handoffId,
        projectId,
        handoff.sessionId,
        handoff.status,
        jsonText(handoff),
        null,
        null,
        null,
        createdAt,
        null,
      );
  }

  /** 读取当前会话的唯一交接包。 */
  getHandoff(
    connection: BetterSqlite3.Database,
    sessionId: string,
  ): HandoffPackage | null {
    const row = connection
      .prepare("SELECT package_json FROM coding_handoffs WHERE session_id=?")
      .get(sessionId) as { package_json: string } | undefined;
    return row ? jsonValue<HandoffPackage>(row.package_json) : null;
  }

  /** 记录开发代表的 Review 决策，审批结果不可由模型或执行器伪造。 */
  reviewHandoff(
    connection: BetterSqlite3.Database,
    input: {
      projectId: string;
      sessionId: string;
      decision: "approved" | "changes_requested" | "blocked";
      comments: string;
      reviewer: string;
      reviewedAt: string;
    },
  ): HandoffPackage {
    const row = connection
      .prepare(
        "SELECT package_json FROM coding_handoffs WHERE project_id=? AND session_id=?",
      )
      .get(input.projectId, input.sessionId) as
      | { package_json: string }
      | undefined;
    if (!row) throw new NotFoundError("编码交接包不存在");
    const handoff = jsonValue<HandoffPackage>(row.package_json);
    const status = input.decision;
    const next = { ...handoff, status };
    connection
      .prepare(
        `
          UPDATE coding_handoffs
          SET status=?, package_json=?, review_decision=?, review_comments=?,
              reviewed_by=?, reviewed_at=?
          WHERE project_id=? AND session_id=?
        `,
      )
      .run(
        status,
        jsonText(next),
        input.decision,
        input.comments,
        input.reviewer,
        input.reviewedAt,
        input.projectId,
        input.sessionId,
      );
    return next;
  }

  /** 查询动作、观察和验证摘要，供任务详情和调用控制台使用。 */
  listFacts(
    connection: BetterSqlite3.Database,
    sessionId: string,
  ): {
    actions: CodingAction[];
    observations: CodingObservation[];
    verifications: VerificationRun[];
  } {
    const actions = (
      connection
        .prepare("SELECT * FROM coding_actions WHERE session_id=? ORDER BY seq")
        .all(sessionId) as CodingActionRow[]
    ).map((row) => actionFromRow(row).action);
    const observations = (
      connection
        .prepare(
          "SELECT result_json FROM coding_observations WHERE session_id=? ORDER BY created_at,id",
        )
        .all(sessionId) as { result_json: string }[]
    ).map((row) => jsonValue<CodingObservation>(row.result_json));
    const verifications = (
      connection
        .prepare(
          "SELECT * FROM coding_verification_runs WHERE session_id=? ORDER BY created_at,id",
        )
        .all(sessionId) as VerificationRow[]
    ).map(verificationFromRow);
    return { actions, observations, verifications };
  }
}

type CodingSessionRow = {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  role: string;
  status: CodingSessionStatus;
  spec_json: string;
  grant_json: string;
  plan_json: string | null;
  workspace_path: string;
  baseline_manifest_json: string;
  current_diff_summary: string;
  next_action: string;
  failure_diagnoses_json: string;
  verification_ids_json: string;
  patch_seq_json: string;
  read_files_json: string;
  changed_files_json: string;
  version: number;
  trace_id: string;
  created_at: string;
  updated_at: string;
};
type CodingActionRow = {
  id: string;
  action_json: string;
  status: string;
  observation_id: string | null;
};
type CheckpointRow = {
  id: string;
  state_json: string;
  workspace_snapshot: string;
  patch_seq: number;
};
type VerificationRow = {
  id: string;
  session_id: string;
  profile: string;
  status: VerificationRun["status"];
  steps_json: string;
  failure_class: VerificationRun["failureClass"];
  retry_count: number;
  trace_id: string;
  created_at: string;
  completed_at: string;
};

/** 将 SQLite JSON 投影恢复为严格的会话模型。 */
function sessionFromRow(row: CodingSessionRow): CodingSession {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    role: row.role,
    status: row.status,
    spec: jsonValue<CodingTaskSpec>(row.spec_json),
    grant: jsonValue<CodingExecutionGrant>(row.grant_json),
    plan: row.plan_json ? jsonValue<CodingPlan>(row.plan_json) : null,
    workspacePath: row.workspace_path,
    baselineManifest: jsonValue<Record<string, string>>(
      row.baseline_manifest_json,
    ),
    currentDiffSummary: row.current_diff_summary,
    nextAction: row.next_action,
    failureDiagnoses: jsonValue<FailureDiagnosis[]>(row.failure_diagnoses_json),
    verificationIds: jsonValue<string[]>(row.verification_ids_json),
    patchSeq: jsonValue<number[]>(row.patch_seq_json),
    readFiles: jsonValue<string[]>(row.read_files_json),
    changedFiles: jsonValue<string[]>(row.changed_files_json),
    version: row.version,
    traceId: row.trace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将动作行恢复为完整提案。 */
function actionFromRow(row: CodingActionRow): {
  action: CodingAction;
  status: string;
} {
  return {
    action: jsonValue<CodingAction>(row.action_json),
    status: row.status,
  };
}

/** 将验证行恢复为逐步骤事实。 */
function verificationFromRow(row: VerificationRow): VerificationRun {
  return {
    verificationId: row.id,
    sessionId: row.session_id,
    profile: row.profile,
    status: row.status,
    steps: jsonValue<VerificationRun["steps"]>(row.steps_json),
    failureClass: row.failure_class,
    retryCount: row.retry_count,
    traceId: row.trace_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
