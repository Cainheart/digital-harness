import { createHash, randomBytes } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import {
  Actor,
  newObjectId,
  ProjectStatus,
  TaskStatus,
  utcNow,
} from "../domain/common.js";
import {
  Approval,
  Project,
  Task,
  parseProject,
  parseTask,
} from "../domain/entities.js";
import {
  ApprovalType,
  rejectedTestReleaseTarget,
  WorkflowStage,
  isWorkflowStage,
} from "../workflow/fixed-workflow.js";
import {
  assertProjectTransition,
  assertTaskTransition,
  projectAllowsNewTask,
} from "../workflow/state-machine.js";
import {
  CommandEnvelope,
  CommandResult,
  canonicalRequestHash,
  parseCommand,
} from "../domain/commands.js";
import {
  EvidenceIncompleteError,
  InvalidArgumentError,
  NotFoundError,
  PolicyDeniedError,
  VersionConflictError,
  WorkflowGuardBlockedError,
} from "../domain/errors.js";
import { DomainEventDraft } from "../domain/events.js";
import { Database } from "../infra/database.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import { EvidenceRepository } from "../infra/repositories/evidence.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import { SqliteIdempotencyRepository } from "../infra/repositories/idempotency.js";

/** 触发固定流程自动推进的受限事件集合。 */
export type WorkflowTrigger =
  | "project_started"
  | "prd_submitted"
  | "pm_review_completed"
  | "feasibility_completed"
  | "task_breakdown_completed"
  | "development_completed"
  | "review_passed"
  | "test_strategy_completed"
  | "test_passed"
  | "regression_passed"
  | "closing_checks_passed";

/** Coordinator 推进结果；状态、下一任务、等待对象、阻塞原因和 trace 必须同时返回。 */
export type AdvanceResult = {
  project: Project;
  nextTaskId: string | null;
  waitingFor: string | null;
  blockedReason: string | null;
  notificationEvents: string[];
  traceId: string;
};

/** 终止二次确认预览，token 只在响应中返回，数据库只保存哈希。 */
export type TerminatePreview = {
  projectId: string;
  currentStage: string;
  currentStatus: ProjectStatus;
  unfinishedTasks: string[];
  impact: string;
  requiresReason: true;
  requiresSecondConfirmation: true;
  confirmationToken: string;
  expiresAt: string;
};

/** 统一项目、审批、任务和通知命令的业务协调器；不执行模型、网页、文件或 Docker。 */
export class WorkflowCoordinator {
  private readonly projects = new ProjectTaskRepository();
  private readonly events = new SqliteEventStore();
  private readonly evidence = new EvidenceRepository();
  private readonly idempotency = new SqliteIdempotencyRepository();

  /** 注入业务数据库；所有状态和事件写入由同一事务完成。 */
  constructor(private readonly database: Database) {}

  /** 创建准备中的项目，并拒绝同时存在第二个活动项目。 */
  createProject(input: Record<string, unknown>): Project {
    const id = newObjectId("project");
    const command = this.command(input, id, {
      name: input.name,
      businessGoal: input.businessGoal,
      targetUsers: input.targetUsers,
      priority: input.priority ?? "P1",
      deadline: input.deadline ?? null,
      constraints: input.constraints ?? {},
    });
    assertBoss(command.actor);
    const payload = command.payload;
    const project = parseProject({
      id,
      name: requireText(payload.name, "name"),
      businessGoal: requireText(payload.businessGoal, "businessGoal"),
      targetUsers: requireText(payload.targetUsers, "targetUsers"),
      priority: requirePriority(payload.priority),
      deadline:
        payload.deadline == null
          ? null
          : requireDate(payload.deadline, "deadline"),
      constraints: requireJsonObject(payload.constraints, "constraints"),
      stage: WorkflowStage.PREPARATION,
      status: ProjectStatus.PREPARING,
      createdAt: utcNow(),
      endedAt: null,
      version: 1,
      readOnly: false,
    });
    const result = this.executeProjectCommand(command, null, (connection) => {
      const active = connection
        .prepare(
          "SELECT id FROM projects WHERE status IN ('准备中','运行中','等待 Boss','已暂停','已阻塞','结项中') LIMIT 1",
        )
        .get() as { id: string } | undefined;
      if (active) {
        throw workflowBlocked("同一时刻只能有一个活动项目", {
          activeProjectId: active.id,
        });
      }
      this.projects.createProject(connection, project);
      return {
        projectId: project.id,
        newVersion: project.version,
        eventType: "ProjectCreated",
        payload: {
          projectId: project.id,
          stage: project.stage,
          status: project.status,
        },
        notification: null,
      };
    });
    if (result.aggregateId !== project.id)
      throw new Error("project command aggregate mismatch");
    return project;
  }

  /** Boss 确认启动数字公司；只创建首个任务，不在确认前触发真实执行。 */
  startProject(
    projectId: string,
    input: Record<string, unknown>,
  ): CommandResult {
    const command = this.command(input, projectId);
    assertBoss(command.actor);
    return this.executeProjectCommand(
      command,
      projectId,
      (connection, current) => {
        if (!current) throw new NotFoundError("项目不存在");
        assertProjectTransition(current.status, ProjectStatus.RUNNING, {
          reason: "boss_start_confirmation",
        });
        if (current.stage !== WorkflowStage.PREPARATION)
          throw workflowBlocked("项目不在准备/立项节点，不能重复启动", {
            stage: current.stage,
          });
        const startedAt = utcNow();
        const taskId = newObjectId("task");
        const next = this.nextProject(current, {
          status: ProjectStatus.RUNNING,
          stage: WorkflowStage.RESEARCH_PRD,
        });
        this.projects.updateProject(connection, next, current.version);
        const task: Task = {
          id: taskId,
          projectId,
          title: "调研与 PRD",
          ownerRole: "product_market_pm",
          specialistTag: "research",
          assignmentReason: "Boss 已确认启动，进入固定研发流程的调研/PRD 节点",
          priority: current.priority,
          dependencies: [],
          expectedDeliverables: ["调研报告", "来源目录", "PRD"],
          status: TaskStatus.PENDING,
          createdAt: startedAt,
          startedAt: null,
          endedAt: null,
          version: 1,
        };
        this.projects.createTask(connection, task);
        return {
          projectId,
          newVersion: next.version,
          eventType: "ProjectStarted",
          payload: { projectId, firstTaskId: taskId, stage: next.stage },
          notification: null,
        };
      },
    );
  }

  /** Boss 主动暂停项目，并保存影响范围、等待对象、动作和恢复条件。 */
  pauseProject(
    projectId: string,
    input: Record<string, unknown>,
  ): CommandResult {
    const command = this.command(input, projectId);
    assertBoss(command.actor);
    const reason = requireText(command.payload.reason, "reason");
    const pauseDetails = pauseDetailsFromPayload(command.payload);
    return this.executeProjectCommand(
      command,
      projectId,
      (connection, current) => {
        if (!current) throw new NotFoundError("项目不存在");
        if (current.status === ProjectStatus.PAUSED)
          throw workflowBlocked("项目已经处于已暂停状态", { projectId });
        assertProjectTransition(current.status, ProjectStatus.PAUSED, {
          reason: "boss_pause",
        });
        const now = utcNow();
        const next = this.nextProject(current, {
          status: ProjectStatus.PAUSED,
        });
        this.projects.updateProject(connection, next, current.version);
        this.insertPause(connection, {
          projectId,
          reason,
          ...pauseDetails,
          previousStatus: current.status,
          previousStage: current.stage,
          createdAt: now,
        });
        this.insertCheckpoint(
          connection,
          projectId,
          current.stage,
          ProjectStatus.PAUSED,
          {
            reason,
            previousStatus: current.status,
          },
        );
        return {
          projectId,
          newVersion: next.version,
          eventType: "ProjectPaused",
          payload: {
            projectId,
            reason,
            impactScope: pauseDetails.impactScope,
            waitingFor: pauseDetails.waitingFor,
            recoveryCondition: pauseDetails.recoveryCondition,
          },
          notification: {
            notificationType: "project_paused",
            severity: "P0",
            subjectType: "project",
            subjectId: projectId,
            action: "满足恢复条件后由 Boss 点击恢复",
          },
        };
      },
    );
  }

  /** 从暂停或已解除阻塞状态恢复；人工审批中的项目不能靠恢复命令越过关卡。 */
  resumeProject(
    projectId: string,
    input: Record<string, unknown>,
  ): CommandResult {
    const command = this.command(input, projectId);
    assertBoss(command.actor);
    return this.executeProjectCommand(
      command,
      projectId,
      (connection, current) => {
        if (!current) throw new NotFoundError("项目不存在");
        const openApproval = this.openApproval(connection, projectId);
        if (openApproval)
          throw workflowBlocked(
            "存在未完成人工关卡，不能通过恢复命令越过审批",
            {
              approvalId: openApproval.id,
            },
          );
        const blockedResolved = command.payload.blockedResolved === true;
        const context =
          current.status === ProjectStatus.BLOCKED
            ? { blockedResolved }
            : { resumeConfirmed: true };
        assertProjectTransition(current.status, ProjectStatus.RUNNING, context);
        const next = this.nextProject(current, {
          status: ProjectStatus.RUNNING,
        });
        this.projects.updateProject(connection, next, current.version);
        this.resolveActivePause(connection, projectId, command.actor.id);
        this.insertCheckpoint(connection, projectId, next.stage, next.status, {
          reason: "boss_resume",
          previousStatus: current.status,
        });
        return {
          projectId,
          newVersion: next.version,
          eventType: "ProjectResumed",
          payload: {
            projectId,
            previousStatus: current.status,
            stage: next.stage,
          },
          notification: null,
        };
      },
    );
  }

  /** 创建终止确认；响应 token 是一次性短期凭据，数据库只保存哈希。 */
  terminatePreview(
    projectId: string,
    input: Record<string, unknown>,
  ): TerminatePreview {
    const command = this.command(input, projectId);
    assertBoss(command.actor);
    const reason = requireText(command.payload.reason, "reason");
    return this.database.transaction((connection) => {
      const project = this.projects.getProject(connection, projectId);
      if (
        project.status === ProjectStatus.COMPLETED ||
        project.status === ProjectStatus.TERMINATED
      )
        throw workflowBlocked("最终状态项目不能再次终止", {
          status: project.status,
        });
      const token = `terminate-${randomBytes(18).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      connection
        .prepare(
          "INSERT INTO termination_confirmations (id,project_id,token_hash,reason,expected_version,actor_id,status,created_at,expires_at,confirmed_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          newObjectId("termination"),
          projectId,
          hashToken(token),
          reason,
          project.version,
          command.actor.id,
          "previewed",
          utcNow(),
          expiresAt,
          null,
          1,
        );
      const unfinished = (
        connection
          .prepare(
            "SELECT id FROM tasks WHERE project_id=? AND status NOT IN ('已完成','已终止') ORDER BY id",
          )
          .all(projectId) as { id: string }[]
      ).map((row) => row.id);
      return {
        projectId,
        currentStage: project.stage,
        currentStatus: project.status,
        unfinishedTasks: unfinished,
        impact: "终止后项目进入历史存档，只读且不可恢复为活动项目",
        requiresReason: true,
        requiresSecondConfirmation: true,
        confirmationToken: token,
        expiresAt,
      };
    });
  }

  /** 使用预览 token、原因、版本和幂等键完成不可恢复终止。 */
  terminateProject(
    projectId: string,
    input: Record<string, unknown>,
  ): CommandResult {
    const confirmationToken = confirmationTokenFromInput(input);
    const command = this.command(
      withConfirmationProof(input, confirmationToken),
      projectId,
    );
    assertBoss(command.actor);
    const reason = requireText(command.payload.reason, "reason");
    return this.executeProjectCommand(
      command,
      projectId,
      (connection, current) => {
        if (!current) throw new NotFoundError("项目不存在");
        const confirmation = connection
          .prepare(
            "SELECT * FROM termination_confirmations WHERE project_id=? AND token_hash=? AND status='previewed'",
          )
          .get(projectId, hashToken(confirmationToken)) as
          | TerminationRow
          | undefined;
        if (!confirmation)
          throw workflowBlocked("终止确认 token 无效、已使用或已过期", {
            projectId,
          });
        if (new Date(confirmation.expires_at) <= new Date())
          throw workflowBlocked("终止确认 token 已过期", { projectId });
        if (
          confirmation.expected_version !== current.version ||
          confirmation.reason !== reason
        )
          throw new VersionConflictError("终止确认对应的项目版本或原因已变化", {
            data: {
              expectedVersion: confirmation.expected_version,
              actualVersion: current.version,
            },
          });
        assertProjectTransition(current.status, ProjectStatus.TERMINATED, {
          reason: "boss_termination_confirmation",
        });
        const now = utcNow();
        const next = this.nextProject(current, {
          status: ProjectStatus.TERMINATED,
          endedAt: now,
          readOnly: true,
        });
        this.projects.updateProject(connection, next, current.version);
        connection
          .prepare(
            "UPDATE tasks SET status='已终止',ended_at=?,version=version+1 WHERE project_id=? AND status NOT IN ('已完成','已终止')",
          )
          .run(now, projectId);
        connection
          .prepare(
            "UPDATE termination_confirmations SET status='confirmed',confirmed_at=?,version=version+1 WHERE id=? AND status='previewed'",
          )
          .run(now, confirmation.id);
        return {
          projectId,
          newVersion: next.version,
          eventType: "ProjectTerminated",
          payload: { projectId, reason, unfinishedTasksTerminated: true },
          notification: {
            notificationType: "project_terminated",
            severity: "P0",
            subjectType: "project",
            subjectId: projectId,
            action: "仅可查看历史存档，不可恢复",
          },
          allowTerminalEvent: true,
        };
      },
    );
  }

  /** 按固定节点和受限 trigger 推进工作流，人工关卡自动变为等待 Boss。 */
  advance(
    projectId: string,
    trigger: WorkflowTrigger,
    traceId = `trace_advance_${Date.now().toString(36)}`,
  ): AdvanceResult {
    const command = parseCommand({
      commandId: newObjectId("advance"),
      idempotencyKey: `advance:${projectId}:${this.projects.getProject(this.database.connection, projectId).version}:${trigger}`,
      aggregateId: projectId,
      expectedVersion: this.projects.getProject(
        this.database.connection,
        projectId,
      ).version,
      actor: { type: "workflow_coordinator", id: "workflow-coordinator" },
      payload: { trigger, traceId },
    });
    const result = this.executeProjectCommand(
      command,
      projectId,
      (connection, current) => {
        if (!current) throw new NotFoundError("项目不存在");
        if (
          current.stage !== WorkflowStage.CLOSING &&
          !projectAllowsNewTask(current.status)
        )
          return {
            projectId,
            newVersion: current.version,
            eventType: "WorkflowAdvanceDeferred",
            payload: {
              projectId,
              trigger,
              status: current.status,
              stage: current.stage,
            },
            notification: null,
            noStateChange: true,
          };
        if (
          current.stage === WorkflowStage.CLOSING &&
          trigger === "closing_checks_passed"
        ) {
          assertProjectTransition(current.status, ProjectStatus.COMPLETED, {
            closingChecksPassed: true,
          });
          const next = this.nextProject(current, {
            status: ProjectStatus.COMPLETED,
            endedAt: utcNow(),
            readOnly: true,
          });
          this.projects.updateProject(connection, next, current.version);
          return {
            projectId,
            newVersion: next.version,
            eventType: "ProjectCompleted",
            payload: { projectId, stage: next.stage },
            notification: {
              notificationType: "project_completed",
              severity: "P1",
              subjectType: "project",
              subjectId: projectId,
              action: "查看结项检查和历史归档",
            },
            status: next.status,
            allowTerminalEvent: true,
          };
        }
        const action = this.stageAction(connection, current, trigger);
        if (action.approval) {
          const next = this.nextProject(current, {
            status: ProjectStatus.WAITING_BOSS,
            stage: action.stage,
          });
          assertProjectTransition(current.status, next.status);
          this.projects.updateProject(connection, next, current.version);
          this.evidence.createApproval(connection, action.approval);
          return {
            projectId,
            newVersion: next.version,
            eventType: "ApprovalRequested",
            payload: {
              projectId,
              approvalId: action.approval.id,
              approvalType: action.approval.approvalType,
              stage: next.stage,
            },
            notification: {
              notificationType: "approval_required",
              severity: "P0",
              subjectType: "approval",
              subjectId: action.approval.id,
              action: "查看证据后完成 Boss 审批",
            },
          };
        }
        const next = this.nextProject(current, { stage: action.stage });
        this.projects.updateProject(connection, next, current.version);
        return {
          projectId,
          newVersion: next.version,
          eventType: "WorkflowAdvanced",
          payload: {
            projectId,
            trigger,
            fromStage: current.stage,
            toStage: next.stage,
          },
          notification: null,
        };
      },
      traceId,
    );
    const project = this.projects.getProject(
      this.database.connection,
      projectId,
    );
    const pendingApproval = this.openApproval(
      this.database.connection,
      projectId,
    );
    return {
      project,
      nextTaskId: this.nextTaskId(projectId),
      waitingFor: pendingApproval?.id ?? null,
      blockedReason:
        project.status === ProjectStatus.BLOCKED ? "项目存在未解除阻塞" : null,
      notificationEvents: result.eventId ? [result.eventId] : [],
      traceId: result.traceId,
    };
  }

  /** 处理四类 Boss 审批，并固定实现 PRD、Review、风险和测试放行回路。 */
  decideApproval(
    approvalId: string,
    input: Record<string, unknown>,
  ): CommandResult {
    const approval = this.evidence.getApproval(
      this.database.connection,
      approvalId,
    );
    const command = this.command(input, approvalId);
    assertBoss(command.actor);
    if (command.actor.id !== approval.bossId)
      throw new PolicyDeniedError("当前操作者不是该审批指定的 Boss", {
        data: { approvalId },
      });
    const decision = command.payload.decision;
    if (decision !== "approved" && decision !== "rejected")
      throw new InvalidArgumentError("decision 必须是 approved 或 rejected");
    const opinion =
      command.payload.opinion == null
        ? null
        : requireText(command.payload.opinion, "opinion");
    if (decision === "rejected" && !opinion)
      throw new InvalidArgumentError("驳回审批必须填写非空方向意见");
    if (command.payload.evidenceVersion != null) {
      const evidenceVersion = command.payload.evidenceVersion;
      if (!Number.isInteger(evidenceVersion) || Number(evidenceVersion) < 0)
        throw new InvalidArgumentError("evidenceVersion 必须是非负整数");
    }
    const result = this.executeApprovalCommand(
      command,
      approval,
      decision,
      opinion,
    );
    return result;
  }

  /** Review 只改变被拒任务，保留其他任务、证据和事件不变。 */
  reviewTask(taskId: string, input: Record<string, unknown>): CommandResult {
    const task = this.projects.getTask(this.database.connection, taskId);
    const command = this.command(input, taskId);
    if (command.actor.type === "boss")
      throw new PolicyDeniedError("Boss 不代替开发代表执行成员级 Review");
    if (command.actor.id === task.ownerRole)
      throw new PolicyDeniedError("任务负责人不能批准自己的 Review");
    const decision = command.payload.decision;
    if (decision !== "approved" && decision !== "rejected")
      throw new InvalidArgumentError(
        "Review decision 必须是 approved 或 rejected",
      );
    const comments = requireText(
      command.payload.comments ??
        (decision === "rejected" ? "" : "Review 通过"),
      "comments",
    );
    return this.executeTaskCommand(command, task, (connection, current) => {
      if (current.status !== TaskStatus.WAITING_REVIEW)
        throw workflowBlocked("只有等待 Review 的任务才能提交 Review 决定", {
          status: current.status,
        });
      const nextStatus =
        decision === "approved" ? TaskStatus.COMPLETED : TaskStatus.REWORK;
      assertTaskTransition(current.status, nextStatus, {
        evidenceComplete: true,
      });
      const next = this.nextTask(current, nextStatus);
      this.projects.updateTask(connection, next, current.version);
      return {
        projectId: task.projectId,
        newVersion: next.version,
        eventType:
          decision === "approved" ? "ReviewApproved" : "ReviewRejected",
        payload: {
          taskId,
          decision,
          comments,
          originalTaskVersion: current.version,
          newTaskVersion: next.version,
        },
      };
    });
  }

  /** 读取审批证据和当前版本，供 Boss 页面在决定前复核。 */
  getApproval(approvalId: string): Approval {
    return this.evidence.getApproval(this.database.connection, approvalId);
  }

  /** 从持久化事实组装项目看板，不使用动画或内存状态。 */
  getDashboard(projectId: string): Record<string, unknown> {
    const connection = this.database.connection;
    const project = this.projects.getProject(connection, projectId);
    const tasks = this.projects.listTasks(
      connection,
      projectId,
      null,
      500,
    ).items;
    const approvals = connection
      .prepare(
        "SELECT * FROM approvals WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId);
    const notifications = this.listNotifications(projectId, 500).items;
    const counts = connection
      .prepare(
        "SELECT COUNT(*) AS total, SUM(status='已完成') AS completed, SUM(status='返工') AS rework FROM tasks WHERE project_id=?",
      )
      .get(projectId) as { total: number; completed: number; rework: number };
    const defects = connection
      .prepare(
        "SELECT COUNT(*) AS total,SUM(status NOT IN ('closed','resolved')) AS open FROM defects WHERE project_id=?",
      )
      .get(projectId) as { total: number; open: number };
    return {
      project,
      tasks,
      approvals,
      notifications,
      progress: {
        taskTotal: counts.total,
        taskCompleted: counts.completed ?? 0,
        taskRework: counts.rework ?? 0,
        defectTotal: defects.total,
        openDefects: defects.open ?? 0,
      },
      allowedActions: allowedProjectActions(project.status),
      nextAction: this.nextAction(project, approvals),
    };
  }

  /** 查询通知，并从对应事件中补充原因摘要和 trace。 */
  listNotifications(
    projectId: string | null,
    limit: number,
  ): {
    items: Record<string, unknown>[];
    nextCursor: string | null;
    hasMore: boolean;
  } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new InvalidArgumentError("limit 必须介于 1 和 500 之间");
    const connection = this.database.connection;
    const rows = projectId
      ? (connection
          .prepare(
            "SELECT n.*,e.payload_json,e.trace_id FROM notifications n JOIN domain_events e ON e.event_id=n.event_id WHERE n.project_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT ?",
          )
          .all(projectId, limit + 1) as NotificationRow[])
      : (connection
          .prepare(
            "SELECT n.*,e.payload_json,e.trace_id FROM notifications n JOIN domain_events e ON e.event_id=n.event_id ORDER BY n.created_at DESC,n.id DESC LIMIT ?",
          )
          .all(limit + 1) as NotificationRow[]);
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: visible.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        eventId: row.event_id,
        notificationType: row.notification_type,
        severity: row.severity,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        unread: Boolean(row.unread),
        pending: Boolean(row.pending),
        action: row.action,
        reasonSummary: safePayloadReason(row.payload_json ?? "{}"),
        traceId: row.trace_id,
        createdAt: row.created_at,
        readAt: row.read_at,
        handledBy: row.handled_by,
        handledAt: row.handled_at,
      })),
      nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
      hasMore,
    };
  }

  /** 标记已阅但不自动关闭仍需业务处理的通知。 */
  markNotificationRead(notificationId: string): Record<string, unknown> {
    return this.database.transaction((connection) => {
      const row = this.notificationRow(connection, notificationId);
      connection
        .prepare(
          "UPDATE notifications SET unread=0,read_at=COALESCE(read_at,?) WHERE id=?",
        )
        .run(utcNow(), notificationId);
      return { ...row, unread: false, readAt: row.read_at ?? utcNow() };
    });
  }

  /** 完成普通通知动作；审批/重大风险通知必须通过其业务接口闭环。 */
  handleNotification(
    notificationId: string,
    handledBy: string,
    action: string,
  ): Record<string, unknown> {
    if (!handledBy.trim() || !action.trim())
      throw new InvalidArgumentError("handledBy 和 action 不能为空");
    return this.database.transaction((connection) => {
      const row = this.notificationRow(connection, notificationId);
      if (!row.pending) return row;
      if (["approval_required", "major_risk"].includes(row.notification_type))
        throw workflowBlocked(
          "审批或重大风险通知必须完成对应业务处理，不能仅标记关闭",
          {
            notificationId,
            notificationType: row.notification_type,
          },
        );
      const handledAt = utcNow();
      connection
        .prepare(
          "UPDATE notifications SET unread=0,pending=0,handled_by=?,action=?,handled_at=?,read_at=COALESCE(read_at,?) WHERE id=? AND pending=1",
        )
        .run(handledBy, action, handledAt, handledAt, notificationId);
      return this.notificationRow(connection, notificationId);
    });
  }

  /** 保存一般/重大风险，重大风险会暂停项目并创建 Boss 审批入口。 */
  createRisk(input: RiskInput): Record<string, unknown> {
    const project = this.projects.getProject(
      this.database.connection,
      input.projectId,
    );
    if (input.severity === "P0" || input.severity === "P1") {
      const pauseInput = {
        commandId: newObjectId("risk-pause"),
        idempotencyKey: `risk-pause:${input.id}`,
        aggregateId: input.projectId,
        expectedVersion: project.version,
        actor: { type: "workflow_coordinator", id: "workflow-coordinator" },
        payload: {
          reason: input.reason,
          impactScope: input.impactScope,
          waitingFor: "Boss 重大风险裁决",
          availableActions: [
            "查看证据",
            "完成重大风险审批",
            "满足恢复条件后恢复",
          ],
          recoveryCondition: input.recommendation,
        },
      };
      // 修改日期：2026-08-16
      // 修改原因：P0/P1 风险命令已经在同一事务中写入暂停、审批和风险事实，必须立即返回，避免普通风险分支重复插入同一 riskId。
      const result = this.executeProjectCommand(
        parseCommand(pauseInput),
        input.projectId,
        (connection, current) => {
          if (!current) throw new NotFoundError("项目不存在");
          if (current.status !== ProjectStatus.PAUSED) {
            assertProjectTransition(current.status, ProjectStatus.PAUSED, {
              reason: "major_risk",
            });
            const next = this.nextProject(current, {
              status: ProjectStatus.PAUSED,
            });
            this.projects.updateProject(connection, next, current.version);
            const approval = this.newApproval(current, ApprovalType.MAJOR_RISK);
            this.evidence.createApproval(connection, approval);
            this.insertPause(connection, {
              projectId: input.projectId,
              reason: input.reason,
              impactScope: input.impactScope,
              waitingFor: "Boss 重大风险裁决",
              availableActions: [
                "查看证据",
                "完成重大风险审批",
                "满足恢复条件后恢复",
              ],
              recoveryCondition: input.recommendation,
              previousStatus: current.status,
              previousStage: current.stage,
              createdAt: utcNow(),
            });
            connection
              .prepare(
                "INSERT INTO workflow_risks (id,project_id,task_id,severity,reason,impact_scope_json,evidence_json,recommendation,status,approval_id,created_at,resolved_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                input.id,
                input.projectId,
                input.taskId ?? null,
                input.severity,
                input.reason,
                JSON.stringify(input.impactScope),
                JSON.stringify(input.evidence),
                input.recommendation,
                "open",
                approval.id,
                utcNow(),
                null,
                1,
              );
            return {
              projectId: input.projectId,
              newVersion: next.version,
              eventType: "MajorRiskPaused",
              payload: {
                projectId: input.projectId,
                riskId: input.id,
                approvalId: approval.id,
                reason: input.reason,
              },
              notification: {
                notificationType: "major_risk",
                severity: "P0",
                subjectType: "approval",
                subjectId: approval.id,
                action: "完成重大风险 Boss 裁决",
              },
            };
          }
          throw workflowBlocked(
            "项目已经因风险暂停，不能重复创建自动暂停事实",
            { projectId: input.projectId },
          );
        },
      );
      const risk = this.database.connection
        .prepare("SELECT approval_id FROM workflow_risks WHERE id=?")
        .get(input.id) as { approval_id: string | null } | undefined;
      return {
        ...result,
        id: input.id,
        projectId: input.projectId,
        status: "open",
        approvalId: risk?.approval_id ?? null,
      };
    }
    return this.database.transaction((connection) => {
      connection
        .prepare(
          "INSERT INTO workflow_risks (id,project_id,task_id,severity,reason,impact_scope_json,evidence_json,recommendation,status,approval_id,created_at,resolved_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.projectId,
          input.taskId ?? null,
          input.severity,
          input.reason,
          JSON.stringify(input.impactScope),
          JSON.stringify(input.evidence),
          input.recommendation,
          "open",
          null,
          utcNow(),
          null,
          1,
        );
      return { id: input.id, projectId: input.projectId, status: "open" };
    });
  }

  private executeApprovalCommand(
    command: CommandEnvelope,
    approval: Approval,
    decision: "approved" | "rejected",
    opinion: string | null,
  ): CommandResult {
    const hash = canonicalRequestHash(command);
    return this.database.transaction((connection) => {
      const existing = this.idempotency.get(connection, command.idempotencyKey);
      if (existing)
        return this.idempotency.assertReusable(
          existing,
          hash,
          `trace_${command.commandId}`,
        );
      const current = this.evidence.getApproval(connection, approval.id);
      if (current.version !== command.expectedVersion)
        throw new VersionConflictError("审批版本已变化，未覆盖最新决定", {
          data: {
            expectedVersion: command.expectedVersion,
            actualVersion: current.version,
          },
        });
      if (
        current.status !== "pending" &&
        current.status !== "waiting_direction"
      )
        throw workflowBlocked("该审批已经完成，不能重复决定", {
          status: current.status,
        });
      const project = this.projects.getProject(connection, current.projectId);
      if (
        current.approvalType === ApprovalType.TEST_RELEASE &&
        decision === "approved"
      ) {
        const blocking = connection
          .prepare(
            "SELECT id FROM defects WHERE project_id=? AND severity IN ('P0','P1') AND status NOT IN ('closed','resolved') LIMIT 1",
          )
          .get(current.projectId) as { id: string } | undefined;
        if (blocking)
          throw new EvidenceIncompleteError(
            "存在未关闭的阻断性缺陷，不能通过测试放行",
            {
              data: { defectId: blocking.id },
            },
          );
      }
      const now = utcNow();
      connection
        .prepare(
          "UPDATE approvals SET decision=?,direction=?,status=?,decided_at=?,version=version+1 WHERE id=? AND version=?",
        )
        .run(
          decision,
          opinion,
          decision === "approved" ? "approved" : "rejected",
          now,
          current.id,
          current.version,
        );
      const outcome = this.applyApprovalOutcome(
        connection,
        project,
        current,
        decision,
        opinion,
      );
      const eventCount = this.events.countForAggregate(
        connection,
        "project",
        project.id,
      );
      const approvalEvents = [
        this.eventDraft(
          decision === "approved" ? "ApprovalApproved" : "ApprovalRejected",
          project.id,
          command.actor,
          command,
          {
            approvalId: current.id,
            approvalType: current.approvalType,
            decision,
            opinion,
            nextStage: outcome.stage,
          },
        ),
      ];
      if (
        current.approvalType === ApprovalType.TEST_RELEASE &&
        decision === "approved"
      )
        approvalEvents.push(
          this.eventDraft(
            "ProjectEnteredClosing",
            project.id,
            command.actor,
            command,
            { approvalId: current.id, stage: WorkflowStage.CLOSING },
          ),
        );
      const event = this.events.append(
        connection,
        "project",
        project.id,
        eventCount,
        approvalEvents,
      );
      const result: CommandResult = {
        aggregateId: current.id,
        version: current.version + 1,
        eventId: event.events[0].eventId,
        allowedActions: allowedProjectActions(outcome.status),
        traceId: `trace_${command.commandId}`,
      };
      this.idempotency.save(connection, {
        id: newObjectId("idempotency"),
        projectId: project.id,
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        aggregateType: "approval",
        aggregateId: current.id,
        requestHash: hash,
        commandResult: result,
        eventId: result.eventId,
        createdAt: now,
      });
      return result;
    });
  }

  private applyApprovalOutcome(
    connection: BetterSqlite3.Database,
    project: Project,
    approval: Approval,
    decision: "approved" | "rejected",
    opinion: string | null,
  ): { status: ProjectStatus; stage: string } {
    let status = project.status;
    let stage = project.stage;
    if (approval.approvalType === ApprovalType.PRD) {
      stage =
        decision === "approved"
          ? WorkflowStage.FEASIBILITY
          : WorkflowStage.RESEARCH_PRD;
      status = ProjectStatus.RUNNING;
      if (decision === "rejected")
        this.createResponseTask(
          connection,
          project,
          "PM 修订 PRD",
          "product_solution_pm",
          opinion ?? "Boss 要求修订 PRD",
        );
    } else if (approval.approvalType === ApprovalType.REQUIREMENT_DISPUTE) {
      stage =
        decision === "approved"
          ? WorkflowStage.TASK_BREAKDOWN
          : WorkflowStage.RESEARCH_PRD;
      status = ProjectStatus.RUNNING;
      if (decision === "approved")
        this.createResponseTask(
          connection,
          project,
          "按 Boss 方向完成任务拆解",
          "developer_representative",
          opinion ?? "按批准方向拆解任务",
        );
    } else if (approval.approvalType === ApprovalType.MAJOR_RISK) {
      if (decision === "approved") {
        const pause = this.activePause(connection, project.id);
        stage = pause?.previous_stage ?? project.stage;
        status = ProjectStatus.RUNNING;
        if (pause)
          this.resolveActivePause(connection, project.id, approval.bossId);
        // 修改日期：2026-08-16
        // 修改原因：Boss 批准重大风险后，关联风险必须与暂停事实一起闭环，避免已恢复项目仍显示开放的 P0/P1 风险。
        connection
          .prepare(
            "UPDATE workflow_risks SET status='resolved',resolved_at=?,version=version+1 WHERE approval_id=? AND status='open'",
          )
          .run(utcNow(), approval.id);
      } else {
        status = ProjectStatus.PAUSED;
      }
    } else if (approval.approvalType === ApprovalType.TEST_RELEASE) {
      if (decision === "approved") {
        stage = WorkflowStage.CLOSING;
        assertProjectTransition(project.status, ProjectStatus.RUNNING, {
          gateCompleted: true,
        });
        const running = this.nextProject(project, {
          status: ProjectStatus.RUNNING,
          stage,
        });
        this.projects.updateProject(connection, running, project.version);
        assertProjectTransition(running.status, ProjectStatus.CLOSING);
        const closing = this.nextProject(running, {
          status: ProjectStatus.CLOSING,
          stage,
        });
        this.projects.updateProject(connection, closing, running.version);
        status = closing.status;
        return { status, stage };
      } else {
        status = ProjectStatus.RUNNING;
        stage = rejectedTestReleaseTarget();
        this.createResponseTask(
          connection,
          project,
          "测试放行整改计划",
          "test_lead",
          opinion ?? "Boss 要求制定整改计划",
        );
      }
    }
    const next = this.nextProject(project, { status, stage });
    assertProjectTransition(project.status, next.status, {
      gateCompleted: true,
      resumeConfirmed: true,
      blockedResolved: true,
    });
    this.projects.updateProject(connection, next, project.version);
    return { status, stage };
  }

  private stageAction(
    connection: BetterSqlite3.Database,
    project: Project,
    trigger: WorkflowTrigger,
  ): { stage: WorkflowStage; approval: Approval | null } {
    if (!isWorkflowStage(project.stage))
      throw workflowBlocked("项目当前阶段不属于固定工作流", {
        stage: project.stage,
      });
    const expected: Record<WorkflowStage, WorkflowTrigger | null> = {
      [WorkflowStage.PREPARATION]: "project_started",
      [WorkflowStage.RESEARCH_PRD]: "prd_submitted",
      [WorkflowStage.PM_CROSS_REVIEW]: "pm_review_completed",
      [WorkflowStage.PRD_APPROVAL]: null,
      [WorkflowStage.FEASIBILITY]: "feasibility_completed",
      [WorkflowStage.REQUIREMENT_DISPUTE]: null,
      [WorkflowStage.TASK_BREAKDOWN]: "task_breakdown_completed",
      [WorkflowStage.DEVELOPMENT]: "development_completed",
      [WorkflowStage.DEVELOPER_REVIEW]: "review_passed",
      [WorkflowStage.TEST_STRATEGY]: "test_strategy_completed",
      [WorkflowStage.REAL_TEST]: "test_passed",
      [WorkflowStage.DEFECT_NPI_REGRESSION]: "regression_passed",
      [WorkflowStage.TEST_RELEASE]: null,
      [WorkflowStage.CLOSING]: "closing_checks_passed",
    };
    if (expected[project.stage] !== trigger)
      throw workflowBlocked("trigger 与当前固定工作流节点不匹配", {
        stage: project.stage,
        trigger,
        expectedTrigger: expected[project.stage],
      });
    if (project.stage === WorkflowStage.PM_CROSS_REVIEW)
      return {
        stage: WorkflowStage.PRD_APPROVAL,
        approval: this.newApproval(project, ApprovalType.PRD),
      };
    if (project.stage === WorkflowStage.FEASIBILITY) {
      const dispute = connection
        .prepare(
          "SELECT 1 FROM structured_messages WHERE project_id=? AND message_type='feasibility_opinion' AND status IN ('pending','acknowledged') LIMIT 1",
        )
        .get(project.id);
      return dispute
        ? {
            stage: WorkflowStage.REQUIREMENT_DISPUTE,
            approval: this.newApproval(
              project,
              ApprovalType.REQUIREMENT_DISPUTE,
            ),
          }
        : { stage: WorkflowStage.TASK_BREAKDOWN, approval: null };
    }
    if (project.stage === WorkflowStage.REAL_TEST)
      return {
        stage: WorkflowStage.TEST_RELEASE,
        approval: this.newApproval(project, ApprovalType.TEST_RELEASE),
      };
    return {
      stage: nextStageOrThrow(project.stage) as WorkflowStage,
      approval: null,
    };
  }

  private newApproval(project: Project, approvalType: ApprovalType): Approval {
    return {
      id: newObjectId("approval"),
      projectId: project.id,
      taskId: null,
      approvalType,
      subjectType: "project",
      subjectId: project.id,
      artifactVersionId: null,
      evidenceVersionId: null,
      decision: null,
      direction: null,
      bossId: "boss-local",
      status: "pending",
      responseTaskId: null,
      createdAt: utcNow(),
      decidedAt: null,
      version: 1,
    };
  }

  private createResponseTask(
    connection: BetterSqlite3.Database,
    project: Project,
    title: string,
    ownerRole: string,
    opinion: string,
  ): string {
    const taskId = newObjectId("task");
    this.projects.createTask(connection, {
      id: taskId,
      projectId: project.id,
      title,
      ownerRole,
      specialistTag: ownerRole,
      assignmentReason: opinion,
      priority: project.priority,
      dependencies: [],
      expectedDeliverables: [title, "响应证据"],
      status: TaskStatus.PENDING,
      createdAt: utcNow(),
      startedAt: null,
      endedAt: null,
      version: 1,
    });
    return taskId;
  }

  private executeProjectCommand(
    command: CommandEnvelope,
    projectId: string | null,
    mutate: (
      connection: BetterSqlite3.Database,
      current: Project | null,
    ) => Mutation,
    traceId?: string,
  ): CommandResult {
    const hash = canonicalRequestHash(command);
    return this.database.transaction((connection) => {
      const existing = this.idempotency.get(connection, command.idempotencyKey);
      if (existing)
        return this.idempotency.assertReusable(
          existing,
          hash,
          traceId ?? `trace_${command.commandId}`,
        );
      const current = projectId
        ? this.projects.getProject(connection, projectId)
        : null;
      if (current && current.version !== command.expectedVersion)
        throw new VersionConflictError("项目版本已变化，未覆盖最新事实", {
          data: {
            expectedVersion: command.expectedVersion,
            actualVersion: current.version,
          },
        });
      if (!current && command.expectedVersion !== 0)
        throw new VersionConflictError("新项目命令的 expectedVersion 必须为 0");
      const mutation = mutate(connection, current);
      let eventId = "";
      if (!mutation.noStateChange) {
        const eventCount = this.events.countForAggregate(
          connection,
          "project",
          mutation.projectId,
        );
        const drafts = this.baselineDrafts(
          eventCount,
          current?.version ?? 0,
          mutation.projectId,
          command,
        );
        drafts.push(
          this.eventDraft(
            mutation.eventType,
            mutation.projectId,
            command.actor,
            command,
            mutation.payload,
          ),
        );
        const appended = this.events.append(
          connection,
          "project",
          mutation.projectId,
          eventCount,
          drafts,
          mutation.allowTerminalEvent ?? false,
        );
        const event = appended.events.at(-1);
        if (!event) throw new Error("workflow command must append an event");
        eventId = event.eventId;
        if (mutation.notification)
          this.insertNotification(
            connection,
            event.eventId,
            mutation.projectId,
            mutation.notification,
          );
      }
      const result: CommandResult = {
        aggregateId: command.aggregateId,
        version: mutation.newVersion,
        eventId,
        allowedActions: allowedProjectActions(
          mutation.status ?? ProjectStatus.RUNNING,
        ),
        traceId: traceId ?? `trace_${command.commandId}`,
      };
      this.idempotency.save(connection, {
        id: newObjectId("idempotency"),
        projectId: mutation.projectId,
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        aggregateType: "project",
        aggregateId: command.aggregateId,
        requestHash: hash,
        commandResult: result,
        eventId: eventId || null,
        createdAt: utcNow(),
      });
      return result;
    });
  }

  private executeTaskCommand(
    command: CommandEnvelope,
    current: Task,
    mutate: (connection: BetterSqlite3.Database, current: Task) => TaskMutation,
  ): CommandResult {
    const hash = canonicalRequestHash(command);
    return this.database.transaction((connection) => {
      const existing = this.idempotency.get(connection, command.idempotencyKey);
      if (existing)
        return this.idempotency.assertReusable(
          existing,
          hash,
          `trace_${command.commandId}`,
        );
      const fresh = this.projects.getTask(connection, current.id);
      if (fresh.version !== command.expectedVersion)
        throw new VersionConflictError("任务版本已变化，未覆盖最新事实", {
          data: {
            expectedVersion: command.expectedVersion,
            actualVersion: fresh.version,
          },
        });
      const mutation = mutate(connection, fresh);
      const eventCount = this.events.countForAggregate(
        connection,
        "task",
        fresh.id,
      );
      const drafts = this.baselineDrafts(
        eventCount,
        fresh.version,
        fresh.projectId,
        command,
        "task",
        fresh.id,
      );
      drafts.push(
        this.eventDraft(
          mutation.eventType,
          fresh.projectId,
          command.actor,
          command,
          mutation.payload,
          "task",
          fresh.id,
        ),
      );
      const appended = this.events.append(
        connection,
        "task",
        fresh.id,
        eventCount,
        drafts,
      );
      const event = appended.events[0];
      const result: CommandResult = {
        aggregateId: fresh.id,
        version: mutation.newVersion,
        eventId: event.eventId,
        allowedActions: [],
        traceId: `trace_${command.commandId}`,
      };
      this.idempotency.save(connection, {
        id: newObjectId("idempotency"),
        projectId: fresh.projectId,
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        aggregateType: "task",
        aggregateId: fresh.id,
        requestHash: hash,
        commandResult: result,
        eventId: event.eventId,
        createdAt: utcNow(),
      });
      return result;
    });
  }

  private eventDraft(
    eventType: string,
    projectId: string,
    actor: Actor,
    command: CommandEnvelope,
    payload: Record<string, unknown>,
    aggregateType = "project",
    aggregateId = projectId,
  ): DomainEventDraft {
    return {
      eventType,
      aggregateType,
      aggregateId,
      payload: { projectId, ...payload },
      inputSummary: {
        commandId: command.commandId,
        aggregateId: command.aggregateId,
      },
      outputSummary: { eventType },
      result: "success",
      failure: null,
      retryCount: 0,
      durationMs: 0,
      actor,
      traceId: `trace_${command.commandId}`,
      occurredAt: utcNow(),
      attemptId: null,
      rejectionReason: null,
      redactionReason: "workflow event stores summaries and directions only",
      eventCategory: "ordinary",
    };
  }

  private baselineDrafts(
    eventCount: number,
    version: number,
    projectId: string,
    command: CommandEnvelope,
    aggregateType = "project",
    aggregateId = projectId,
  ): DomainEventDraft[] {
    if (eventCount > version)
      throw new VersionConflictError(
        "项目版本落后于事件链，拒绝写入不一致事实",
      );
    return Array.from({ length: version - eventCount }, (_, index) =>
      this.eventDraft(
        "WorkflowBaselineReconciled",
        projectId,
        { type: "workflow_coordinator", id: "workflow-coordinator" },
        command,
        {
          reason: "legacy aggregate had no complete event baseline",
          sequence: index + 1,
        },
        aggregateType,
        aggregateId,
      ),
    );
  }

  private command(
    input: Record<string, unknown>,
    aggregateId: string,
    defaultPayload: Record<string, unknown> = {},
  ): CommandEnvelope {
    const payload =
      input.payload &&
      typeof input.payload === "object" &&
      !Array.isArray(input.payload)
        ? input.payload
        : stripCommandFields({ ...defaultPayload, ...input });
    return parseCommand({
      commandId: input.commandId ?? newObjectId("command"),
      idempotencyKey:
        input.idempotencyKey ??
        `${aggregateId}:${String(input.action ?? "command")}`,
      aggregateId,
      expectedVersion: input.expectedVersion ?? 0,
      actor: input.actor ?? { type: "boss", id: "boss-local" },
      payload,
    });
  }

  private nextProject(project: Project, patch: Partial<Project>): Project {
    return parseProject({
      ...project,
      ...patch,
      version: project.version + 1,
    });
  }

  private nextTask(task: Task, status: TaskStatus): Task {
    return parseTask({
      ...task,
      status,
      endedAt:
        status === TaskStatus.REWORK || status === TaskStatus.RUNNING
          ? null
          : utcNow(),
      version: task.version + 1,
    });
  }

  private insertPause(
    connection: BetterSqlite3.Database,
    input: PauseInput,
  ): void {
    connection
      .prepare(
        "INSERT INTO workflow_pauses (id,project_id,reason,impact_scope_json,waiting_for,available_actions_json,recovery_condition,previous_status,previous_stage,status,created_at,resolved_at,resolved_by,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        newObjectId("pause"),
        input.projectId,
        input.reason,
        JSON.stringify(input.impactScope),
        input.waitingFor,
        JSON.stringify(input.availableActions),
        input.recoveryCondition,
        input.previousStatus,
        input.previousStage,
        "active",
        input.createdAt,
        null,
        null,
        1,
      );
  }

  private insertCheckpoint(
    connection: BetterSqlite3.Database,
    projectId: string,
    stage: string,
    status: ProjectStatus,
    state: Record<string, unknown>,
  ): void {
    connection
      .prepare(
        "INSERT INTO workflow_checkpoints (id,project_id,task_id,attempt_id,project_status,project_stage,state_json,reason,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        newObjectId("checkpoint"),
        projectId,
        null,
        null,
        status,
        stage,
        JSON.stringify(state),
        String(state.reason ?? "workflow checkpoint"),
        utcNow(),
        1,
      );
  }

  private resolveActivePause(
    connection: BetterSqlite3.Database,
    projectId: string,
    resolvedBy: string,
  ): void {
    connection
      .prepare(
        "UPDATE workflow_pauses SET status='resolved',resolved_at=?,resolved_by=?,version=version+1 WHERE project_id=? AND status='active'",
      )
      .run(utcNow(), resolvedBy, projectId);
  }

  private activePause(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): PauseRow | undefined {
    return connection
      .prepare(
        "SELECT * FROM workflow_pauses WHERE project_id=? AND status='active' ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId) as PauseRow | undefined;
  }

  private openApproval(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): Approval | null {
    const row = connection
      .prepare(
        "SELECT id FROM approvals WHERE project_id=? AND status IN ('pending','waiting_direction') ORDER BY created_at,id LIMIT 1",
      )
      .get(projectId) as { id: string } | undefined;
    return row ? this.evidence.getApproval(connection, row.id) : null;
  }

  private insertNotification(
    connection: BetterSqlite3.Database,
    eventId: string,
    projectId: string,
    notification: NotificationInput,
  ): void {
    // 修改日期：2026-08-16
    // 修改原因：同一领域事件可能因重试再次触发通知，事务内按 event_id 去重且不依赖破坏性唯一索引迁移。
    const insertNotificationSql = `
      INSERT INTO notifications (
        id, project_id, event_id, notification_type, severity, subject_type,
        subject_id, unread, pending, handled_by, action, created_at, read_at, handled_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications WHERE event_id = ?
      )
    `;
    connection
      .prepare(insertNotificationSql)
      .run(
        newObjectId("notification"),
        projectId,
        eventId,
        notification.notificationType,
        notification.severity,
        notification.subjectType,
        notification.subjectId,
        1,
        1,
        null,
        notification.action,
        utcNow(),
        null,
        null,
        eventId,
      );
  }

  private nextTaskId(projectId: string): string | null {
    return (
      (
        this.database.connection
          .prepare(
            "SELECT id FROM tasks WHERE project_id=? AND status IN ('待处理','返工') ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,created_at,id LIMIT 1",
          )
          .get(projectId) as { id: string } | undefined
      )?.id ?? null
    );
  }

  private nextAction(project: Project, approvals: unknown[]): string {
    if (project.status === ProjectStatus.WAITING_BOSS)
      return "等待 Boss 处理人工关卡";
    if (project.status === ProjectStatus.PAUSED)
      return "满足恢复条件后由 Boss 恢复项目";
    if (project.status === ProjectStatus.BLOCKED)
      return "解除阻塞原因后由 Boss 恢复或终止项目";
    if (project.status === ProjectStatus.CLOSING)
      return "执行结项检查并提交完成命令";
    if (
      project.status === ProjectStatus.COMPLETED ||
      project.status === ProjectStatus.TERMINATED
    )
      return "只读历史存档";
    if (approvals.length > 0) return "查看并处理待审批事项";
    return "按固定流程完成当前阶段交付物";
  }

  private notificationRow(
    connection: BetterSqlite3.Database,
    id: string,
  ): NotificationRow {
    const row = connection
      .prepare("SELECT * FROM notifications WHERE id=?")
      .get(id) as NotificationRow | undefined;
    if (!row) throw new NotFoundError("通知不存在");
    return row;
  }
}

/** 创建项目/命令响应中的通知输入，不能携带凭据或任意事件正文。 */
type NotificationInput = {
  notificationType: string;
  severity: string;
  subjectType: string;
  subjectId: string;
  action: string;
};
type Mutation = {
  projectId: string;
  newVersion: number;
  eventType: string;
  payload: Record<string, unknown>;
  notification: NotificationInput | null;
  status?: ProjectStatus;
  noStateChange?: boolean;
  allowTerminalEvent?: boolean;
};
type TaskMutation = {
  projectId: string;
  newVersion: number;
  eventType: string;
  payload: Record<string, unknown>;
};
type PauseInput = {
  projectId: string;
  reason: string;
  impactScope: string[];
  waitingFor: string;
  availableActions: string[];
  recoveryCondition: string;
  previousStatus: ProjectStatus;
  previousStage: string;
  createdAt: string;
};
type PauseRow = {
  previous_stage: string;
};
type TerminationRow = {
  id: string;
  expected_version: number;
  reason: string;
  expires_at: string;
};
type NotificationRow = {
  id: string;
  project_id: string;
  event_id: string;
  notification_type: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  unread: number;
  pending: number;
  handled_by: string | null;
  action: string | null;
  created_at: string;
  read_at: string | null;
  handled_at: string | null;
  payload_json?: string;
  trace_id?: string;
};
export type RiskInput = {
  id: string;
  projectId: string;
  taskId?: string;
  severity: "P0" | "P1" | "P2" | "P3";
  reason: string;
  impactScope: string[];
  evidence: string[];
  recommendation: string;
};

function assertBoss(actor: Actor): void {
  if (actor.type !== "boss")
    throw new PolicyDeniedError("只有 Boss 可以执行当前项目控制或审批命令");
}
function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new InvalidArgumentError(`${field} 必须是非空字符串`);
  return value;
}
function requirePriority(value: unknown): "P0" | "P1" | "P2" | "P3" {
  if (value !== "P0" && value !== "P1" && value !== "P2" && value !== "P3")
    throw new InvalidArgumentError("priority 必须是 P0/P1/P2/P3");
  return value;
}
function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new InvalidArgumentError(`${field} 必须是有效 ISO 时间`);
  return new Date(value).toISOString();
}
function requireJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidArgumentError(`${field} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
function pauseDetailsFromPayload(
  payload: Record<string, unknown>,
): Omit<
  PauseInput,
  "projectId" | "reason" | "previousStatus" | "previousStage" | "createdAt"
> {
  const impactScope = Array.isArray(payload.impactScope)
    ? payload.impactScope.map((item) => requireText(item, "impactScope"))
    : ["当前项目流程"];
  const availableActions = Array.isArray(payload.availableActions)
    ? payload.availableActions.map((item) =>
        requireText(item, "availableActions"),
      )
    : ["查看项目状态", "满足条件后恢复"];
  return {
    impactScope,
    waitingFor:
      typeof payload.waitingFor === "string" && payload.waitingFor.trim()
        ? payload.waitingFor
        : "Boss",
    availableActions,
    recoveryCondition:
      typeof payload.recoveryCondition === "string" &&
      payload.recoveryCondition.trim()
        ? payload.recoveryCondition
        : "暂停原因已处理",
  };
}
function allowedProjectActions(status: ProjectStatus): string[] {
  if (status === ProjectStatus.PREPARING) return ["start", "terminate_preview"];
  if (status === ProjectStatus.RUNNING)
    return ["pause", "resume", "terminate_preview"];
  if (status === ProjectStatus.WAITING_BOSS)
    return ["pause", "terminate_preview"];
  if (status === ProjectStatus.PAUSED || status === ProjectStatus.BLOCKED)
    return ["resume", "terminate_preview"];
  if (status === ProjectStatus.CLOSING) return ["terminate_preview"];
  return [];
}
function nextStageOrThrow(stage: string): string {
  const order = Object.values(WorkflowStage);
  const index = order.indexOf(stage as WorkflowStage);
  if (index < 0 || index >= order.length - 1)
    throw workflowBlocked("固定工作流已到达末端或阶段无效", { stage });
  return order[index + 1];
}
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** 从终止命令读取确认 token；token 不进入命令摘要或事件正文。 */
function confirmationTokenFromInput(input: Record<string, unknown>): string {
  const payload = input.payload;
  const value =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).confirmationToken
      : input.confirmationToken;
  return requireText(value, "confirmationToken");
}
/** 用不可逆证明替换敏感 token，保留幂等指纹而不把 token 写入领域命令。 */
function withConfirmationProof(
  input: Record<string, unknown>,
  token: string,
): Record<string, unknown> {
  const payload =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? { ...(input.payload as Record<string, unknown>) }
      : stripCommandFields({ ...input });
  delete payload.confirmationToken;
  payload.confirmationProof = hashToken(token);
  return { ...input, payload };
}
function safePayloadReason(payload: string): string | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return typeof value.reason === "string" ? value.reason : null;
  } catch (_error) {
    return null;
  }
}
/** 从非信封形式的 HTTP body 中移除命令字段，避免业务 payload 伪装信封。 */
function stripCommandFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...value };
  for (const field of [
    "commandId",
    "command_id",
    "idempotencyKey",
    "idempotency_key",
    "aggregateId",
    "aggregate_id",
    "expectedVersion",
    "expected_version",
    "actor",
    "payload",
    "action",
  ])
    delete payload[field];
  return payload;
}
function workflowBlocked(
  message: string,
  data: Record<string, unknown>,
): WorkflowGuardBlockedError {
  return new WorkflowGuardBlockedError(message, {
    data,
    impact: "业务状态未改变，已有数据和证据保持不变",
    dataPreserved: true,
    nextAction: "查看当前状态、关卡和恢复条件后提交合法命令",
  });
}
