import type BetterSqlite3 from "better-sqlite3";
import { NotFoundError } from "../domain/errors.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import type { Database } from "../infra/database.js";

/** 像素办公室允许展示的有限状态；它只表达后端事实，不推进业务流程。 */
export type OfficeDisplayStatus =
  | "IDLE"
  | "WORKING"
  | "WAITING_INPUT"
  | "WAITING_APPROVAL"
  | "REVIEWING"
  | "TESTING"
  | "BLOCKED"
  | "DONE"
  | "STOPPED";

/** 单个办公室房间和员工工位的只读投影。 */
export type OfficeRoom = {
  roomId: string;
  label: string;
  status: "ACTIVE" | "IDLE" | "BLOCKED" | "DONE";
  occupants: Array<{
    workerId: string;
    role: string;
    displayName: string;
    specialistTag: string;
    officeZone: string;
    deskGroup: string;
    status: OfficeDisplayStatus;
    statusLabel: string;
    statusIcon: string;
    statusColor: string;
    accessibilityLabel: string;
    taskId: string | null;
    currentActivity: string;
    waitingFor: string | null;
    lastEventId: string | null;
    updatedAt: string;
  }>;
};

/** OfficeProjection 的完整快照；snapshotVersion 来自数据库事实和事件序号。 */
export type OfficeView = {
  projectId: string;
  snapshotVersion: number;
  generatedAt: string;
  projectStatus: string;
  projectStage: string;
  projectStatusLabel: string;
  rooms: OfficeRoom[];
  activeTasks: number;
  blockedTasks: number;
  pendingApprovals: number;
  lastEventId: string | null;
};

const ROOM_DEFINITIONS = [
  { id: "boss", label: "Boss 区域", officeZone: "boss" },
  { id: "product", label: "产品区", officeZone: "产品区" },
  { id: "research", label: "调研区", officeZone: "调研区" },
  { id: "development", label: "开发区", officeZone: "研发区", deskGroup: "开发组" },
  { id: "npi", label: "NPI 区", officeZone: "研发区", deskGroup: "NPI 组" },
  { id: "review", label: "Review 区", officeZone: "Review区" },
  { id: "testing", label: "测试区", officeZone: "测试区" },
  { id: "project-management", label: "项目主管区", officeZone: "项目主管区" },
  { id: "archive", label: "归档区", officeZone: "归档区" },
] as const;

const STATUS_PRESENTATION: Record<
  OfficeDisplayStatus,
  { label: string; icon: string; color: string }
> = {
  IDLE: { label: "空闲", icon: "○", color: "#7b8794" },
  WORKING: { label: "工作中", icon: "▶", color: "#2f80ed" },
  WAITING_INPUT: { label: "等待输入", icon: "?", color: "#8e44ad" },
  WAITING_APPROVAL: { label: "等待审批", icon: "!", color: "#d97706" },
  REVIEWING: { label: "Review 中", icon: "⌕", color: "#0f766e" },
  TESTING: { label: "测试中", icon: "✓", color: "#2563eb" },
  BLOCKED: { label: "已阻塞", icon: "×", color: "#dc2626" },
  DONE: { label: "已完成", icon: "✓", color: "#16a34a" },
  STOPPED: { label: "已终止", icon: "■", color: "#4b5563" },
};

/** 从项目、任务、组织成员、执行会话和事件生成办公室投影。 */
export class OfficeProjection {
  private readonly projects = new ProjectTaskRepository();

  /** 绑定数据库；投影不会写入任何领域表或创建客户端状态。 */
  constructor(private readonly database: Database) {}

  /** 返回单项目快照，并校验所有对象均属于该项目。 */
  get(projectId: string): OfficeView {
    const connection = this.database.connection;
    const project = this.projects.findProject(connection, projectId);
    if (!project) throw new NotFoundError("项目不存在");

    const tasks = connection
      .prepare("SELECT id,status FROM tasks WHERE project_id=?")
      .all(projectId) as Array<{ id: string; status: string }>;
    const activeTasks = tasks.filter((task) =>
      ["进行中", "等待 Review", "等待审批", "返工"].includes(task.status),
    ).length;
    const blockedTasks = tasks.filter((task) => task.status === "阻塞").length;
    const pendingApprovals = (
      connection
        .prepare(
          "SELECT COUNT(*) AS count FROM approvals WHERE project_id=? AND status IN ('pending','waiting','open')",
        )
        .get(projectId) as { count: number }
    ).count;
    const rooms = this.buildRooms(connection, projectId, project.status);
    const lastEvent = connection
      .prepare(
        "SELECT event_id FROM domain_events WHERE project_id=? ORDER BY global_sequence DESC LIMIT 1",
      )
      .get(projectId) as { event_id: string } | undefined;
    const latestSequence = (
      connection
        .prepare(
          "SELECT COALESCE(MAX(global_sequence),0) AS sequence FROM domain_events WHERE project_id=?",
        )
        .get(projectId) as { sequence: number }
    ).sequence;

    return {
      projectId,
      snapshotVersion: Math.max(project.version, latestSequence),
      generatedAt: new Date().toISOString(),
      projectStatus: project.status,
      projectStage: project.stage,
      projectStatusLabel: projectStatusLabel(project.status),
      rooms,
      activeTasks,
      blockedTasks,
      pendingApprovals,
      lastEventId: lastEvent?.event_id ?? null,
    };
  }

  /** 根据领域事件返回 Office SSE 数据；事件乱序由客户端游标和快照补齐处理。 */
  listEvents(
    projectId: string,
    after: string | null,
    limit: number,
  ): Array<Record<string, unknown>> {
    const connection = this.database.connection;
    if (!this.projects.findProject(connection, projectId)) {
      throw new NotFoundError("项目不存在");
    }
    const rows = connection
      .prepare(
        `SELECT event_id,project_id,aggregate_type,aggregate_id,event_type,
                payload_json,occurred_at,global_sequence,trace_id
         FROM domain_events
         WHERE project_id=? AND global_sequence > COALESCE(
           (SELECT global_sequence FROM domain_events WHERE event_id=? AND project_id=?),0
         )
         ORDER BY global_sequence ASC LIMIT ?`,
      )
      .all(projectId, after, projectId, limit) as Array<{
      event_id: string;
      project_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload_json: string;
      occurred_at: string;
      global_sequence: number;
      trace_id: string;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      projectId: row.project_id,
      entityType: row.aggregate_type,
      entityId: row.aggregate_id,
      eventType: row.event_type,
      payload: safeJson(row.payload_json),
      occurredAt: row.occurred_at,
      projectionVersion: row.global_sequence,
      traceId: row.trace_id,
    }));
  }

  private buildRooms(
    connection: BetterSqlite3.Database,
    projectId: string,
    projectStatus: string,
  ): OfficeRoom[] {
    const members = connection
      .prepare(
        `SELECT m.instance_id,m.role_id,m.display_name,m.specialist_tag,
                m.office_zone,m.desk_group,r.title,m.status AS member_status
         FROM organization_members m
         JOIN role_definitions r ON r.role_id=m.role_id
         WHERE r.enabled = 1
         ORDER BY m.office_zone,m.desk_group,m.instance_id`,
      )
      .all() as MemberRow[];
    const occupants = members.map((member) =>
      this.memberView(connection, projectId, member, projectStatus),
    );
    const boss: OfficeRoom["occupants"] = [
      this.bossOccupant(connection, projectId, projectStatus),
    ];

    return ROOM_DEFINITIONS.map((definition) => {
      const roomOccupants =
        definition.id === "boss"
          ? boss
          : occupants.filter(
              (item) =>
                item.officeZone === definition.officeZone &&
                (!("deskGroup" in definition) || item.deskGroup === definition.deskGroup),
            );
      const normalized = roomOccupants;
      return {
        roomId: definition.id,
        label: definition.label,
        status: roomStatus(normalized),
        occupants: normalized,
      };
    });
  }

  private memberView(
    connection: BetterSqlite3.Database,
    projectId: string,
    member: MemberRow,
    projectStatus: string,
  ): OfficeRoom["occupants"][number] {
    const task = connection
      .prepare(
        `SELECT id,title,status,started_at,owner_role FROM tasks
         WHERE project_id=? AND owner_role=?
         ORDER BY CASE status WHEN '进行中' THEN 0 WHEN '阻塞' THEN 1 ELSE 2 END,
                  created_at DESC LIMIT 1`,
      )
      .get(projectId, member.role_id) as TaskRow | undefined;
    const session = task
      ? (connection
          .prepare(
            `SELECT status,updated_at
             FROM coding_sessions
             WHERE project_id=? AND task_id=?
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(projectId, task.id) as SessionRow | undefined)
      : undefined;
    const status = displayStatus(task?.status, session?.status, projectStatus);
    const presentation = STATUS_PRESENTATION[status];
    const updatedAt = session?.updated_at ?? task?.started_at ?? new Date().toISOString();
    const lastEvent = task
      ? (connection
          .prepare(
            `SELECT event_id
             FROM domain_events
             WHERE project_id=? AND aggregate_id=?
             ORDER BY global_sequence DESC LIMIT 1`,
          )
          .get(projectId, task.id) as { event_id: string } | undefined)
      : undefined;
    return {
      workerId: member.instance_id,
      role: member.role_id,
      displayName: member.display_name,
      specialistTag: member.specialist_tag,
      officeZone: member.office_zone,
      deskGroup: member.desk_group,
      status,
      statusLabel: presentation.label,
      statusIcon: presentation.icon,
      statusColor: presentation.color,
      accessibilityLabel: `${member.display_name}，${member.title}，${presentation.label}`,
      taskId: task?.id ?? null,
      currentActivity: activityLabel(status, task?.title ?? null),
      waitingFor: waitingFor(status, projectStatus),
      lastEventId: lastEvent?.event_id ?? null,
      updatedAt,
    };
  }

  private bossOccupant(
    connection: BetterSqlite3.Database,
    projectId: string,
    projectStatus: string,
  ): OfficeRoom["occupants"][number] {
    const approval = connection
      .prepare(
        `SELECT id
         FROM approvals
         WHERE project_id=? AND status IN ('pending','waiting','open')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as { id: string } | undefined;
    const needsApproval = Boolean(approval) || projectStatus === "等待 Boss";
    const status = needsApproval
      ? "WAITING_APPROVAL"
      : displayStatus(undefined, undefined, projectStatus);
    const presentation = STATUS_PRESENTATION[status];
    return {
      workerId: "boss-local",
      role: "boss",
      displayName: "Boss",
      specialistTag: "decision-maker",
      officeZone: "boss",
      deskGroup: "boss",
      status,
      statusLabel: presentation.label,
      statusIcon: presentation.icon,
      statusColor: presentation.color,
      accessibilityLabel: `Boss，${presentation.label}`,
      taskId: null,
      currentActivity: approval ? "处理待审批事项" : "查看项目状态",
      waitingFor: null,
      lastEventId: null,
      updatedAt: new Date().toISOString(),
    };
  }
}

type MemberRow = {
  instance_id: string;
  role_id: string;
  display_name: string;
  specialist_tag: string;
  office_zone: string;
  desk_group: string;
  title: string;
  member_status: string;
};
type TaskRow = {
  id: string;
  title: string;
  status: string;
  started_at: string | null;
  owner_role: string;
};
type SessionRow = { status: string; updated_at: string };

/** 将领域任务、Coding 会话和项目状态映射为有限办公室展示状态。 */
function displayStatus(
  taskStatus: string | undefined,
  sessionStatus: string | undefined,
  projectStatus: string,
): OfficeDisplayStatus {
  if (taskStatus === "阻塞" || projectStatus === "已阻塞") return "BLOCKED";
  if (taskStatus === "已终止" || projectStatus === "已终止") return "STOPPED";
  if (taskStatus === "已完成" || projectStatus === "已结项") return "DONE";
  if (taskStatus === "等待审批" || projectStatus === "等待 Boss") return "WAITING_APPROVAL";
  if (taskStatus === "等待 Review" || sessionStatus === "REVIEW_REQUESTED") return "REVIEWING";
  if (sessionStatus === "VERIFYING" || taskStatus === "返工") return "TESTING";
  if (taskStatus === "进行中" || sessionStatus === "IMPLEMENTING") return "WORKING";
  if (projectStatus === "已暂停") return "WAITING_INPUT";
  return "IDLE";
}

/** 生成不包含敏感正文的当前活动摘要。 */
function activityLabel(
  status: OfficeDisplayStatus,
  taskTitle: string | null,
): string {
  if (taskTitle && ["WORKING", "REVIEWING", "TESTING"].includes(status)) return taskTitle;
  return STATUS_PRESENTATION[status].label;
}

/** 将等待状态转成用户可理解的下一责任方。 */
function waitingFor(
  status: OfficeDisplayStatus,
  projectStatus: string,
): string | null {
  if (status === "WAITING_APPROVAL" || projectStatus === "等待 Boss") return "Boss";
  if (status === "WAITING_INPUT") return "待处理的输入或恢复条件";
  if (status === "BLOCKED") return "责任人处理阻塞原因";
  return null;
}

/** 提供项目状态的稳定展示文本，未来可集中扩展本地化映射。 */
function projectStatusLabel(status: string): string {
  return status === "准备中" ? "准备中" : status;
}

/** 根据员工有限状态计算房间投影状态，不改变任何领域事实。 */
function roomStatus(
  occupants: OfficeRoom["occupants"],
): OfficeRoom["status"] {
  if (occupants.length === 0) return "IDLE";
  if (occupants.some((item) => item.status === "BLOCKED")) return "BLOCKED";
  if (occupants.some((item) => ["WORKING", "REVIEWING", "TESTING"].includes(item.status))) return "ACTIVE";
  if (occupants.every((item) => item.status === "DONE" || item.status === "STOPPED")) return "DONE";
  return "IDLE";
}

/** 解析事件 payload；非法存储值降级为空对象而不把原文穿透到前端。 */
function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (_error) {
    return {};
  }
}
