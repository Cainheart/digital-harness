import BetterSqlite3 from "better-sqlite3";
import {
  Page,
  ProjectStatus,
  TaskStatus,
  utcNow,
} from "../../domain/common.js";
import {
  Project,
  Task,
  parseProject,
  parseTask,
} from "../../domain/entities.js";
import { NotFoundError, VersionConflictError } from "../../domain/errors.js";
import {
  ensureProject,
  ensureProjectWritable,
  jsonText,
  jsonValue,
  page,
} from "./common.js";

/** Project/Task 的 SQLite 仓储，集中维护版本、项目范围和依赖关系。 */
export class ProjectTaskRepository {
  /** 创建版本为 1 的项目。 */
  createProject(connection: BetterSqlite3.Database, project: Project): void {
    connection
      .prepare(
        "INSERT INTO projects (id,name,business_goal,target_users,priority,deadline,constraints_json,stage,status,created_at,ended_at,version,read_only) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        project.id,
        project.name,
        project.businessGoal,
        project.targetUsers,
        project.priority,
        project.deadline,
        jsonText(project.constraints),
        project.stage,
        project.status,
        project.createdAt,
        project.endedAt,
        project.version,
        project.readOnly ? 1 : 0,
      );
  }
  /** 获取项目；不存在时返回 NOT_FOUND。 */
  getProject(connection: BetterSqlite3.Database, projectId: string): Project {
    const project = this.findProject(connection, projectId);
    if (!project) throw new NotFoundError("项目不存在");
    return project;
  }
  /** 查找项目，不改变数据库。 */
  findProject(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): Project | null {
    const row = connection
      .prepare("SELECT * FROM projects WHERE id=?")
      .get(projectId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }
  /** 创建项目范围内的任务。 */
  createTask(connection: BetterSqlite3.Database, task: Task): void {
    ensureProject(connection, task.projectId);
    connection
      .prepare(
        "INSERT INTO tasks (id,project_id,title,owner_role,specialist_tag,assignment_reason,priority,dependencies_json,expected_deliverables_json,status,started_at,ended_at,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        task.id,
        task.projectId,
        task.title,
        task.ownerRole,
        task.specialistTag,
        task.assignmentReason,
        task.priority,
        jsonText(task.dependencies),
        jsonText(task.expectedDeliverables),
        task.status,
        task.startedAt,
        task.endedAt,
        task.createdAt,
        task.version,
      );
  }
  /** 获取任务；不存在时返回 NOT_FOUND。 */
  getTask(connection: BetterSqlite3.Database, taskId: string): Task {
    const task = this.findTask(connection, taskId);
    if (!task) throw new NotFoundError("任务不存在");
    return task;
  }
  /** 查找任务并恢复 JSON 依赖字段。 */
  findTask(connection: BetterSqlite3.Database, taskId: string): Task | null {
    const row = connection
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }
  /** 按 expectedVersion 更新项目，并返回新版本。 */
  updateProject(
    connection: BetterSqlite3.Database,
    project: Project,
    expectedVersion: number,
  ): Project {
    ensureProjectWritable(connection, project.id);
    const result = connection
      .prepare(
        "UPDATE projects SET name=?,business_goal=?,target_users=?,priority=?,deadline=?,constraints_json=?,stage=?,status=?,created_at=?,ended_at=?,version=?,read_only=? WHERE id=? AND version=?",
      )
      .run(
        project.name,
        project.businessGoal,
        project.targetUsers,
        project.priority,
        project.deadline,
        jsonText(project.constraints),
        project.stage,
        project.status,
        project.createdAt,
        project.endedAt,
        project.version,
        project.readOnly ? 1 : 0,
        project.id,
        expectedVersion,
      );
    if (result.changes !== 1)
      throw this.versionConflict(
        "project",
        project.id,
        expectedVersion,
        this.findProject(connection, project.id)?.version ?? 0,
      );
    return project;
  }
  /** 按 expectedVersion 更新任务，并返回新版本。 */
  updateTask(
    connection: BetterSqlite3.Database,
    task: Task,
    expectedVersion: number,
  ): Task {
    ensureProjectWritable(connection, task.projectId);
    const result = connection
      .prepare(
        "UPDATE tasks SET title=?,owner_role=?,specialist_tag=?,assignment_reason=?,priority=?,dependencies_json=?,expected_deliverables_json=?,status=?,started_at=?,ended_at=?,created_at=?,version=? WHERE id=? AND project_id=? AND version=?",
      )
      .run(
        task.title,
        task.ownerRole,
        task.specialistTag,
        task.assignmentReason,
        task.priority,
        jsonText(task.dependencies),
        jsonText(task.expectedDeliverables),
        task.status,
        task.startedAt,
        task.endedAt,
        task.createdAt,
        task.version,
        task.id,
        task.projectId,
        expectedVersion,
      );
    if (result.changes !== 1)
      throw this.versionConflict(
        "task",
        task.id,
        expectedVersion,
        this.findTask(connection, task.id)?.version ?? 0,
      );
    return task;
  }
  /** 添加同项目任务依赖，重复关系由唯一约束拒绝。 */
  addDependency(
    connection: BetterSqlite3.Database,
    projectId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): void {
    ensureProjectWritable(connection, projectId);
    if (taskId === dependsOnTaskId)
      throw new Error("task cannot depend on itself");
    connection
      .prepare(
        "INSERT INTO task_dependencies (project_id,task_id,depends_on_task_id,created_at) VALUES (?,?,?,?)",
      )
      .run(projectId, taskId, dependsOnTaskId, utcNow());
  }
  /** 按稳定任务 ID 游标分页。 */
  listTasks(
    connection: BetterSqlite3.Database,
    projectId: string,
    cursor: string | null,
    limit: number,
  ): Page<Task> {
    ensureProject(connection, projectId);
    const rows = (
      cursor
        ? connection
            .prepare(
              "SELECT * FROM tasks WHERE project_id=? AND id>? ORDER BY id LIMIT ?",
            )
            .all(projectId, cursor, limit + 1)
        : connection
            .prepare(
              "SELECT * FROM tasks WHERE project_id=? ORDER BY id LIMIT ?",
            )
            .all(projectId, limit + 1)
    ) as TaskRow[];
    return page(rows.map(taskFromRow), limit);
  }
  private versionConflict(
    aggregateType: string,
    aggregateId: string,
    expected: number,
    actual: number,
  ): VersionConflictError {
    return new VersionConflictError("对象版本冲突，未覆盖最新事实", {
      data: {
        aggregateType,
        aggregateId,
        expectedVersion: expected,
        actualVersion: actual,
      },
    });
  }
}

type ProjectRow = {
  id: string;
  name: string;
  business_goal: string;
  target_users: string;
  priority: string;
  deadline: string | null;
  constraints_json: string;
  stage: string;
  status: string;
  created_at: string;
  ended_at: string | null;
  version: number;
  read_only: number;
};
type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  owner_role: string;
  specialist_tag: string;
  assignment_reason: string;
  priority: string;
  dependencies_json: string;
  expected_deliverables_json: string;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  version: number;
};
function projectFromRow(row: ProjectRow): Project {
  return parseProject({
    id: row.id,
    name: row.name,
    businessGoal: row.business_goal,
    targetUsers: row.target_users,
    priority: row.priority,
    deadline: row.deadline,
    constraints: jsonValue(row.constraints_json),
    stage: row.stage,
    status: row.status,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    version: row.version,
    readOnly: Boolean(row.read_only),
  });
}
function taskFromRow(row: TaskRow): Task {
  return parseTask({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ownerRole: row.owner_role,
    specialistTag: row.specialist_tag,
    assignmentReason: row.assignment_reason,
    priority: row.priority,
    dependencies: jsonValue(row.dependencies_json),
    expectedDeliverables: jsonValue(row.expected_deliverables_json),
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    version: row.version,
  });
}

export { ProjectStatus, TaskStatus };
