import BetterSqlite3 from "better-sqlite3";
import {
  newObjectId,
  ProjectStatus,
  TaskStatus,
  utcNow,
} from "../domain/common.js";
import { WorkflowGuardBlockedError } from "../domain/errors.js";
import { DomainEventDraft } from "../domain/events.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import { assertTaskTransition } from "./state-machine.js";

/** Worker 领取任务时必须携带的项目、任务、角色、版本、工具和期限快照。 */
export type ExecutionGrant = {
  grantId: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  roleId: string;
  roleVersion: number;
  taskVersion: number;
  modelConfigVersion: string;
  workspaceRef: string;
  toolPolicy: string[];
  commandPolicy: string[];
  expiresAt: string;
  leaseExpiresAt: string;
  traceId: string;
};

/** 一次成功领取产生的独立租约和 Attempt 摘要。 */
export type TaskLease = {
  leaseId: string;
  attemptId: string;
  projectId: string;
  taskId: string;
  roleId: string;
  taskVersion: number;
  workspaceRef: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  status: "active" | "released" | "expired";
  traceId: string;
};

/** 任务释放后的调度决定，供 Worker 和 Workflow Coordinator 继续推进。 */
export type ScheduleDecision = {
  lease: TaskLease;
  taskStatus: TaskStatus;
  retryScheduled: boolean;
  nextRunnableTaskId: string | null;
  reason: string;
};

/** 校验 Grant 的范围、版本、工具和时间边界，过期授权默认拒绝。 */
export function assertGrantUsable(
  grant: ExecutionGrant,
  now = new Date(),
): void {
  const requiredStrings: Array<[string, unknown]> = [
    ["grantId", grant.grantId],
    ["projectId", grant.projectId],
    ["taskId", grant.taskId],
    ["attemptId", grant.attemptId],
    ["roleId", grant.roleId],
    ["modelConfigVersion", grant.modelConfigVersion],
    ["workspaceRef", grant.workspaceRef],
    ["traceId", grant.traceId],
  ];
  for (const [name, value] of requiredStrings)
    if (typeof value !== "string" || !value.trim())
      throw schedulerBlocked(`${name} 缺失，不能领取任务`, { name });
  const workspacePrefix = `workspace://${grant.projectId}/${grant.attemptId}`;
  const workspaceInScope =
    grant.workspaceRef === workspacePrefix ||
    grant.workspaceRef.startsWith(`${workspacePrefix}/`);
  if (!grant.workspaceRef.startsWith("workspace://") || !workspaceInScope) {
    // 修改日期：2026-08-16
    // 修改原因：Grant 不能只校验字符串非空，工作区必须绑定当前项目和 Attempt，防止 Worker 使用跨范围路径。
    throw schedulerBlocked("Grant 的工作区引用超出项目或 Attempt 范围", {
      workspaceRef: grant.workspaceRef,
      projectId: grant.projectId,
      attemptId: grant.attemptId,
    });
  }
  if (!Number.isInteger(grant.roleVersion) || grant.roleVersion < 1)
    throw schedulerBlocked("Grant 的 roleVersion 无效", {
      roleVersion: grant.roleVersion,
    });
  if (!Number.isInteger(grant.taskVersion) || grant.taskVersion < 1)
    throw schedulerBlocked("Grant 的 taskVersion 无效", {
      taskVersion: grant.taskVersion,
    });
  if (!Array.isArray(grant.toolPolicy) || !Array.isArray(grant.commandPolicy))
    throw schedulerBlocked("Grant 缺少工具或命令策略", {
      grantId: grant.grantId,
    });
  const expiresAt = parseDate(grant.expiresAt, "expiresAt");
  const leaseExpiresAt = parseDate(grant.leaseExpiresAt, "leaseExpiresAt");
  if (expiresAt <= now || leaseExpiresAt <= now)
    throw schedulerBlocked("Grant 或租约已经过期", { grantId: grant.grantId });
  if (leaseExpiresAt > expiresAt)
    throw schedulerBlocked("租约期限不能超过 Grant 有效期", {
      grantId: grant.grantId,
    });
}

/**
 * 事务内执行依赖、项目状态、角色可用性和唯一租约检查；成功后才把任务置为进行中。
 */
export class TaskScheduler {
  constructor(private readonly eventStore = new SqliteEventStore()) {}

  /** 原子领取任务，并为并行任务生成独立 Attempt、Worker Lease 和工作区引用。 */
  claim(
    connection: BetterSqlite3.Database,
    grant: ExecutionGrant,
    now = new Date(),
  ): TaskLease {
    assertGrantUsable(grant, now);
    const current = this.taskRow(connection, grant.taskId);
    if (!current || current.project_id !== grant.projectId)
      throw schedulerBlocked("任务不属于 Grant 指定项目", {
        taskId: grant.taskId,
        projectId: grant.projectId,
      });
    if (current.version !== grant.taskVersion)
      throw schedulerBlocked("Grant 的任务版本已过期", {
        expectedVersion: grant.taskVersion,
        actualVersion: current.version,
      });
    const project = connection
      .prepare("SELECT status FROM projects WHERE id=?")
      .get(grant.projectId) as { status: string } | undefined;
    if (project?.status !== ProjectStatus.RUNNING)
      throw schedulerBlocked("项目当前不可领取新任务", {
        status: project?.status ?? null,
      });
    if (
      current.status !== TaskStatus.PENDING &&
      current.status !== TaskStatus.REWORK
    )
      throw schedulerBlocked("任务当前状态不可领取", {
        status: current.status,
      });
    if (!this.dependenciesSatisfied(connection, current))
      throw schedulerBlocked("任务依赖尚未全部完成", { taskId: grant.taskId });
    this.assertRoleAvailable(connection, grant.roleId);
    const higherPriority = this.hasRunnableHigherPriority(
      connection,
      grant.projectId,
      current.priority,
    );
    if (current.priority === "P3" && higherPriority)
      throw schedulerBlocked("P3 任务不能延迟更高优先级任务", {
        taskId: grant.taskId,
        reason: "higher_priority_task_available",
      });
    const existing = connection
      .prepare("SELECT * FROM workflow_leases WHERE attempt_id=?")
      .get(grant.attemptId) as LeaseRow | undefined;
    if (existing) {
      if (
        existing.project_id !== grant.projectId ||
        existing.task_id !== grant.taskId
      )
        throw schedulerBlocked("Attempt 已绑定其他项目或任务", {
          attemptId: grant.attemptId,
        });
      return leaseFromRow(existing);
    }
    const active = connection
      .prepare(
        "SELECT id FROM workflow_leases WHERE task_id=? AND status='active'",
      )
      .get(grant.taskId) as { id: string } | undefined;
    if (active)
      throw schedulerBlocked("任务已经被其他 Worker 领取", {
        leaseId: active.id,
      });

    const acquiredAt = now.toISOString();
    const leaseId = newObjectId("lease");
    const workerLeaseId = leaseId;
    const version = current.version + 1;
    connection
      .prepare(
        "INSERT INTO worker_leases (worker_id,heartbeat_at,status) VALUES (?,?,?)",
      )
      .run(workerLeaseId, acquiredAt, "busy");
    connection
      .prepare(
        "INSERT INTO execution_attempts (id,project_id,task_id,role,model_config_version,workspace_ref,worker_lease_id,status,started_at,ended_at,retry_of_attempt_id,retry_count,trace_id,version,role_version,policy_snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        grant.attemptId,
        grant.projectId,
        grant.taskId,
        grant.roleId,
        grant.modelConfigVersion,
        grant.workspaceRef,
        workerLeaseId,
        "running",
        acquiredAt,
        null,
        null,
        0,
        grant.traceId,
        1,
        grant.roleVersion,
        JSON.stringify({
          toolPolicy: grant.toolPolicy,
          commandPolicy: grant.commandPolicy,
          grantId: grant.grantId,
        }),
      );
    connection
      .prepare(
        "UPDATE tasks SET status=?,started_at=?,version=? WHERE id=? AND version=?",
      )
      .run(
        TaskStatus.RUNNING,
        acquiredAt,
        version,
        grant.taskId,
        current.version,
      );
    const lease = {
      leaseId,
      attemptId: grant.attemptId,
      projectId: grant.projectId,
      taskId: grant.taskId,
      roleId: grant.roleId,
      taskVersion: version,
      workspaceRef: grant.workspaceRef,
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: grant.leaseExpiresAt,
      status: "active" as const,
      traceId: grant.traceId,
    };
    connection
      .prepare(
        "INSERT INTO workflow_leases (id,project_id,task_id,attempt_id,role_id,task_version,workspace_ref,trace_id,acquired_at,heartbeat_at,expires_at,status,release_result,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        lease.leaseId,
        lease.projectId,
        lease.taskId,
        lease.attemptId,
        lease.roleId,
        lease.taskVersion,
        lease.workspaceRef,
        lease.traceId,
        lease.acquiredAt,
        lease.heartbeatAt,
        lease.expiresAt,
        lease.status,
        null,
        1,
      );
    this.appendTaskEvent(connection, lease, "TaskLeaseClaimed", {
      priority: current.priority,
      taskVersion: lease.taskVersion,
      workspaceRef: lease.workspaceRef,
    });
    return lease;
  }

  /** 延长租约；过期租约不可被心跳复活。 */
  heartbeat(
    connection: BetterSqlite3.Database,
    attemptId: string,
    now = new Date(),
    extensionMs = 30_000,
  ): TaskLease {
    const row = this.leaseRow(connection, attemptId);
    if (row.status !== "active")
      throw schedulerBlocked("租约已经释放或过期", {
        attemptId,
        status: row.status,
      });
    if (parseDate(row.expires_at, "expires_at") <= now) {
      this.expireLease(connection, row, now);
      throw schedulerBlocked("租约已经过期，不能继续执行", { attemptId });
    }
    if (
      !Number.isInteger(extensionMs) ||
      extensionMs < 1 ||
      extensionMs > 300_000
    )
      throw schedulerBlocked("心跳延长时间超出允许范围", { extensionMs });
    const heartbeatAt = now.toISOString();
    const expiresAt = new Date(now.valueOf() + extensionMs).toISOString();
    connection
      .prepare(
        "UPDATE workflow_leases SET heartbeat_at=?,expires_at=?,version=version+1 WHERE attempt_id=? AND status='active'",
      )
      .run(heartbeatAt, expiresAt, attemptId);
    connection
      .prepare(
        "UPDATE worker_leases SET heartbeat_at=?,status='busy' WHERE worker_id=?",
      )
      .run(heartbeatAt, row.id);
    const next = this.leaseRow(connection, attemptId);
    this.appendTaskEvent(connection, next, "TaskLeaseHeartbeat", {
      expiresAt,
    });
    return leaseFromRow(next);
  }

  /** 释放租约并按真实结果推进任务；重复释放只返回已保存的调度决定。 */
  release(
    connection: BetterSqlite3.Database,
    attemptId: string,
    result: ReleaseResult,
    now = new Date(),
  ): ScheduleDecision {
    const row = this.leaseRow(connection, attemptId);
    if (row.status !== "active") {
      const task = this.taskRow(connection, row.task_id);
      return {
        lease: leaseFromRow(row),
        taskStatus: (task?.status ?? TaskStatus.BLOCKED) as TaskStatus,
        retryScheduled: row.release_result === "retry_scheduled",
        nextRunnableTaskId: this.nextRunnableTask(connection, row.project_id),
        reason: row.release_result ?? "租约已处理",
      };
    }
    if (parseDate(row.expires_at, "expires_at") <= now) {
      this.expireLease(connection, row, now);
      throw schedulerBlocked("租约已过期，结果不能提交", { attemptId });
    }
    const task = this.taskRow(connection, row.task_id);
    if (!task)
      throw schedulerBlocked("租约对应任务不存在", { taskId: row.task_id });
    const normalized = normalizeReleaseResult(result);
    const retryCount = this.failureCount(connection, task.id);
    const retryScheduled = normalized.status === "failed" && retryCount < 1;
    let nextStatus: TaskStatus;
    let reason: string;
    if (normalized.status === "succeeded") {
      nextStatus = normalized.requiresReview
        ? TaskStatus.WAITING_REVIEW
        : TaskStatus.COMPLETED;
      assertTaskTransition(TaskStatus.RUNNING, nextStatus, {
        evidenceComplete: normalized.evidenceComplete,
      });
      reason = normalized.requiresReview
        ? "等待开发代表 Review"
        : "任务证据完整并完成";
    } else if (retryScheduled) {
      nextStatus = TaskStatus.REWORK;
      reason = "首次失败已记录，允许一次自动重试";
    } else {
      nextStatus = TaskStatus.BLOCKED;
      reason = normalized.failureReason ?? "任务执行失败，等待人工处理";
    }
    const nextVersion = task.version + 1;
    connection
      .prepare(
        "UPDATE tasks SET status=?,ended_at=?,version=? WHERE id=? AND version=?",
      )
      .run(nextStatus, now.toISOString(), nextVersion, task.id, task.version);
    connection
      .prepare(
        "UPDATE execution_attempts SET status=?,ended_at=?,version=version+1 WHERE id=?",
      )
      .run(
        normalized.status === "succeeded" ? "completed" : "failed",
        now.toISOString(),
        attemptId,
      );
    connection
      .prepare(
        "UPDATE worker_leases SET heartbeat_at=?,status='available' WHERE worker_id=?",
      )
      .run(now.toISOString(), row.id);
    connection
      .prepare(
        "UPDATE workflow_leases SET status='released',heartbeat_at=?,release_result=?,version=version+1 WHERE attempt_id=? AND status='active'",
      )
      .run(
        now.toISOString(),
        retryScheduled ? "retry_scheduled" : normalized.status,
        attemptId,
      );
    const released = this.leaseRow(connection, attemptId);
    this.appendTaskEvent(connection, released, "TaskLeaseReleased", {
      result: normalized.status,
      nextStatus,
      retryScheduled,
      reason,
    });
    if (nextStatus === TaskStatus.BLOCKED)
      this.appendTaskEvent(connection, released, "TaskBlocked", {
        failureReason: normalized.failureReason ?? "execution_failed",
      });
    return {
      lease: leaseFromRow(released),
      taskStatus: nextStatus,
      retryScheduled,
      nextRunnableTaskId: this.nextRunnableTask(connection, row.project_id),
      reason,
    };
  }

  /** 返回按 P0→P1→P2→P3 排序且依赖满足的任务 ID。 */
  nextRunnableTask(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): string | null {
    const rows = connection
      .prepare(
        "SELECT * FROM tasks WHERE project_id=? AND status IN ('待处理','返工') ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,created_at,id",
      )
      .all(projectId) as TaskRow[];
    return (
      rows.find((row) => this.dependenciesSatisfied(connection, row))?.id ??
      null
    );
  }

  private dependenciesSatisfied(
    connection: BetterSqlite3.Database,
    task: TaskRow,
  ): boolean {
    const declared = JSON.parse(task.dependencies_json) as unknown;
    const fromJson = Array.isArray(declared) ? declared.map(String) : [];
    const fromTable = (
      connection
        .prepare(
          "SELECT depends_on_task_id FROM task_dependencies WHERE project_id=? AND task_id=?",
        )
        .all(task.project_id, task.id) as { depends_on_task_id: string }[]
    ).map((row) => row.depends_on_task_id);
    const dependencyIds = [...new Set([...fromJson, ...fromTable])].filter(
      Boolean,
    );
    if (dependencyIds.length === 0) return true;
    const statuses = connection
      .prepare(
        `SELECT id,status FROM tasks WHERE project_id=? AND id IN (${dependencyIds.map(() => "?").join(",")})`,
      )
      .all(task.project_id, ...dependencyIds) as {
      id: string;
      status: string;
    }[];
    return (
      dependencyIds.length === statuses.length &&
      statuses.every((row) => row.status === TaskStatus.COMPLETED)
    );
  }

  private hasRunnableHigherPriority(
    connection: BetterSqlite3.Database,
    projectId: string,
    priority: string,
  ): boolean {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 } as Record<string, number>;
    const rows = connection
      .prepare(
        "SELECT * FROM tasks WHERE project_id=? AND status IN ('待处理','返工')",
      )
      .all(projectId) as TaskRow[];
    return rows.some(
      (row) =>
        order[row.priority] < order[priority] &&
        this.dependenciesSatisfied(connection, row),
    );
  }

  private assertRoleAvailable(
    connection: BetterSqlite3.Database,
    roleId: string,
  ): void {
    const member = connection
      .prepare(
        "SELECT 1 FROM organization_members WHERE role_id=? AND status='available' LIMIT 1",
      )
      .get(roleId);
    if (!member) throw schedulerBlocked("责任岗位当前不可用", { roleId });
  }

  /** 失败次数来自不可变 Attempt 历史，避免把重试计数写入可覆盖的任务摘要。 */
  private failureCount(
    connection: BetterSqlite3.Database,
    taskId: string,
  ): number {
    return (
      connection
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_attempts WHERE task_id=? AND status IN ('failed','expired')",
        )
        .get(taskId) as { count: number }
    ).count;
  }

  private taskRow(
    connection: BetterSqlite3.Database,
    taskId: string,
  ): TaskRow | undefined {
    return connection.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as
      | TaskRow
      | undefined;
  }

  private leaseRow(
    connection: BetterSqlite3.Database,
    attemptId: string,
  ): LeaseRow {
    const row = connection
      .prepare("SELECT * FROM workflow_leases WHERE attempt_id=?")
      .get(attemptId) as LeaseRow | undefined;
    if (!row) throw schedulerBlocked("租约不存在", { attemptId });
    return row;
  }

  private expireLease(
    connection: BetterSqlite3.Database,
    row: LeaseRow,
    now: Date,
  ): void {
    connection
      .prepare(
        "UPDATE workflow_leases SET status='expired',release_result='expired',version=version+1 WHERE id=? AND status='active'",
      )
      .run(row.id);
    connection
      .prepare(
        "UPDATE worker_leases SET heartbeat_at=?,status='expired' WHERE worker_id=?",
      )
      .run(now.toISOString(), row.id);
    connection
      .prepare(
        "UPDATE execution_attempts SET status='expired',ended_at=?,version=version+1 WHERE id=?",
      )
      .run(now.toISOString(), row.attempt_id);
    const task = this.taskRow(connection, row.task_id);
    if (task?.status === TaskStatus.RUNNING) {
      connection
        .prepare(
          "UPDATE tasks SET status='阻塞',ended_at=?,version=? WHERE id=? AND version=?",
        )
        .run(now.toISOString(), task.version + 1, task.id, task.version);
    }
    this.appendTaskEvent(connection, row, "TaskLeaseExpired", {
      reason: "lease_expired",
    });
  }

  private appendTaskEvent(
    connection: BetterSqlite3.Database,
    lease: LeaseRow | TaskLease,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const projectId =
      "project_id" in lease ? lease.project_id : lease.projectId;
    const taskId = "task_id" in lease ? lease.task_id : lease.taskId;
    const attemptId =
      "attempt_id" in lease ? lease.attempt_id : lease.attemptId;
    const traceId = "trace_id" in lease ? lease.trace_id : lease.traceId;
    const eventCount = this.eventStore.countForAggregate(
      connection,
      "task",
      taskId,
    );
    const draft: DomainEventDraft = {
      eventType,
      aggregateType: "task",
      aggregateId: taskId,
      payload: { projectId, taskId, attemptId, ...payload },
      inputSummary: { taskId },
      outputSummary: { status: eventType },
      result:
        eventType === "TaskBlocked" || eventType === "TaskLeaseExpired"
          ? "blocked"
          : "success",
      failure:
        eventType === "TaskBlocked" || eventType === "TaskLeaseExpired"
          ? String(payload.reason ?? "workflow_blocked")
          : null,
      retryCount: 0,
      durationMs: 0,
      actor: { type: "workflow_coordinator", id: "workflow-coordinator" },
      traceId,
      occurredAt: utcNow(),
      attemptId,
      rejectionReason: eventType === "TaskLeaseExpired" ? "租约已过期" : null,
      redactionReason: "workflow event stores summaries only",
      eventCategory: "ordinary",
    };
    this.eventStore.append(connection, "task", taskId, eventCount, [draft]);
  }
}

/** 释放结果的最小契约；模型/工具输出不能直接改变业务状态。 */
export type ReleaseResult = {
  status: "succeeded" | "failed";
  requiresReview?: boolean;
  evidenceComplete?: boolean;
  failureReason?: string;
};

type TaskRow = {
  id: string;
  project_id: string;
  priority: string;
  status: string;
  dependencies_json: string;
  version: number;
  created_at: string;
};
type LeaseRow = {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  role_id: string;
  task_version: number;
  workspace_ref: string;
  trace_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  status: "active" | "released" | "expired";
  release_result: string | null;
  version: number;
};

function leaseFromRow(row: LeaseRow): TaskLease {
  return {
    leaseId: row.id,
    attemptId: row.attempt_id,
    projectId: row.project_id,
    taskId: row.task_id,
    roleId: row.role_id,
    taskVersion: row.task_version,
    workspaceRef: row.workspace_ref,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    status: row.status,
    traceId: row.trace_id,
  };
}

function normalizeReleaseResult(
  result: ReleaseResult,
): Required<ReleaseResult> {
  if (result.status !== "succeeded" && result.status !== "failed")
    throw schedulerBlocked("任务结果状态无效", { status: result.status });
  return {
    status: result.status,
    requiresReview: result.requiresReview ?? false,
    evidenceComplete: result.evidenceComplete ?? result.status === "succeeded",
    failureReason: result.failureReason ?? "",
  };
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf()))
    throw schedulerBlocked(`${field} 不是有效时间`, { field });
  return date;
}

function schedulerBlocked(
  message: string,
  data: Record<string, unknown>,
): WorkflowGuardBlockedError {
  return new WorkflowGuardBlockedError(message, {
    data,
    impact: "任务未获得或未延长执行授权，已有数据保持不变",
    dataPreserved: true,
    nextAction: "检查项目状态、任务依赖、角色可用性和 Grant 有效期",
  });
}
