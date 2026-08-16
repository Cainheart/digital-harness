import type BetterSqlite3 from "better-sqlite3";
import { InvalidArgumentError, NotFoundError } from "../domain/errors.js";
import type { DomainEvent } from "../domain/events.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import { EvidenceRepository } from "../infra/repositories/evidence.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import type { Database } from "../infra/database.js";

/** 为 Task 9 页面提供项目范围的只读任务、交付物、事件和历史查询。 */
export class ConsoleQueryService {
  private readonly projects = new ProjectTaskRepository();
  private readonly evidence = new EvidenceRepository();
  private readonly events = new SqliteEventStore();

  /** 读取任务详情并再次校验项目归属，避免跨项目 ID 泄露。 */
  getTask(
    projectId: string,
    taskId: string,
  ): ReturnType<ProjectTaskRepository["getTask"]> {
    const task = this.projects.getTask(this.database.connection, taskId);
    if (task.projectId !== projectId) {
      throw new NotFoundError("任务不属于指定项目");
    }
    return task;
  }

  /** 返回项目交付物及其不可变版本摘要，不读取或渲染敏感文件正文。 */
  listArtifacts(
    projectId: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    this.assertProject(projectId);
    const rows = this.database.connection
      .prepare(
        "SELECT id FROM artifacts WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
      )
      .all(projectId, limit) as Array<{ id: string }>;
    return rows.map((row) => {
      const view = this.artifactView(projectId, row.id);
      return {
        ...(view.artifact as Record<string, unknown>),
        versions: view.versions,
      };
    });
  }

  /** 返回交付物详情及版本历史，保持历史版本只读。 */
  getArtifact(projectId: string, artifactId: string): Record<string, unknown> {
    const artifact = this.evidence.getArtifact(
      this.database.connection,
      artifactId,
    );
    if (artifact.projectId !== projectId) {
      throw new NotFoundError("交付物不属于指定项目");
    }
    return this.artifactView(projectId, artifactId);
  }

  /** 读取项目已经提交的事件，支持 Last-Event-ID/after 补齐历史。 */
  listEvents(
    projectId: string,
    after: string | null,
    limit: number,
  ): { items: DomainEvent[]; nextCursor: string | null; hasMore: boolean } {
    this.assertProject(projectId);
    this.assertCursorProject(after, projectId);
    const events = this.events.listAfter(
      this.database.connection,
      after,
      projectId,
      limit + 1,
    );
    const hasMore = events.length > limit;
    const items = hasMore ? events.slice(0, limit) : events;
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.eventId ?? null) : null,
      hasMore,
    };
  }

  /** 读取结项/终止项目的历史摘要；活动项目不出现在历史投影中。 */
  listArchive(filters: ArchiveFilters = {}): {
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
    hasMore: boolean;
  } {
    const limit = filters.limit ?? 100;
    const clauses = ["p.status IN ('已结项','已终止')"];
    const values: unknown[] = [];
    if (filters.search) {
      clauses.push("p.name LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(filters.search)}%`);
    }
    if (filters.status) {
      clauses.push("p.status = ?");
      values.push(filters.status);
    }
    if (filters.priority) {
      clauses.push("p.priority = ?");
      values.push(filters.priority);
    }
    if (filters.from) {
      clauses.push("p.created_at >= ?");
      values.push(filters.from);
    }
    if (filters.to) {
      clauses.push("p.created_at <= ?");
      values.push(filters.to);
    }
    if (filters.cursor) {
      clauses.push("p.id < ?");
      values.push(filters.cursor);
    }
    const rows = this.database.connection
      .prepare(
        `SELECT p.* FROM projects p WHERE ${clauses.join(
          " AND ",
        )} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`,
      )
      .all(...values, limit + 1) as ProjectRow[];
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: visible.map((row) => this.archiveView(row)),
      nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
      hasMore,
    };
  }

  /** 重新打开历史项目只返回只读资料，不返回任何可执行项目命令。 */
  getArchive(projectId: string): Record<string, unknown> {
    const row = this.database.connection
      .prepare(
        "SELECT * FROM projects WHERE id=? AND status IN ('已结项','已终止')",
      )
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new NotFoundError("历史项目不存在或尚未进入最终状态");
    return {
      ...this.archiveView(row),
      readOnly: true,
      dashboard: {
        project: this.projects.getProject(this.database.connection, projectId),
        tasks: this.projects.listTasks(
          this.database.connection,
          projectId,
          null,
          500,
        ).items,
        artifacts: this.listArtifacts(projectId, 500),
        events: this.listEvents(projectId, null, 500).items,
      },
    };
  }

  private readonly database: Database;

  /** 绑定只读查询使用的 SQLite 连接。 */
  constructor(database: Database) {
    this.database = database;
  }

  /** 校验项目存在，避免空列表掩盖错误项目 ID。 */
  private assertProject(projectId: string): void {
    this.projects.getProject(this.database.connection, projectId);
  }

  /** 校验项目事件游标归属，避免跨项目游标造成状态补齐遗漏。 */
  private assertCursorProject(after: string | null, projectId: string): void {
    if (!after) return;
    const row = this.database.connection
      .prepare("SELECT project_id FROM domain_events WHERE event_id=?")
      .get(after) as { project_id: string | null } | undefined;
    if (row && row.project_id !== projectId) {
      throw new InvalidArgumentError("事件游标不属于当前项目");
    }
  }

  /** 组装交付物摘要和版本信息，正文仍由 ArtifactStore 的受控入口负责。 */
  private artifactView(
    projectId: string,
    artifactId: string,
  ): Record<string, unknown> {
    const artifact = this.evidence.getArtifact(
      this.database.connection,
      artifactId,
    );
    if (artifact.projectId !== projectId) {
      throw new NotFoundError("交付物不属于指定项目");
    }
    return {
      artifact,
      versions: this.evidence.listArtifactVersions(
        this.database.connection,
        artifactId,
      ),
    };
  }

  /** 生成历史列表字段，所有统计均从持久化事实表即时计算。 */
  private archiveView(row: ProjectRow): Record<string, unknown> {
    const defectCounts = this.database.connection
      .prepare(
        "SELECT COUNT(*) AS total,SUM(status NOT IN ('closed','resolved')) AS open FROM defects WHERE project_id=?",
      )
      .get(row.id) as { total: number; open: number | null };
    const modelCost = this.database.connection
      .prepare(
        "SELECT COUNT(*) AS calls,COALESCE(SUM(duration_ms),0) AS duration,COALESCE(SUM(total_tokens),0) AS tokens,COALESCE(SUM(cost_micros),0) AS cost,COALESCE(SUM(error_code IS NOT NULL),0) AS errors FROM model_calls WHERE project_id=?",
      )
      .get(row.id) as {
      calls: number;
      duration: number;
      tokens: number;
      cost: number;
      errors: number;
    };
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      finalStatus: row.status,
      priority: row.priority,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      runtimeMs: runtimeMs(row.created_at, row.ended_at),
      finalEvaluation:
        row.status === "已结项" ? "流程放行并完成结项检查" : "Boss 已终止项目",
      defects: {
        total: defectCounts.total,
        open: defectCounts.open ?? 0,
      },
      modelCost: {
        callCount: modelCost.calls,
        durationMs: modelCost.duration,
        totalTokens: modelCost.tokens,
        costMicros: modelCost.cost,
        errors: modelCost.errors,
      },
    };
  }
}

/** 历史查询只允许固定状态、优先级和 ISO 时间过滤值。 */
export type ArchiveFilters = {
  search?: string;
  status?: "已结项" | "已终止";
  priority?: "P0" | "P1" | "P2" | "P3";
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
};

type ProjectRow = {
  id: string;
  name: string;
  priority: string;
  status: string;
  created_at: string;
  ended_at: string | null;
  version: number;
};

/** 计算历史项目运行时长；时间缺失或不合法时返回 null 而不是伪造 0。 */
function runtimeMs(start: string, end: string | null): number | null {
  if (!end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

/** 对名称搜索中的 LIKE 通配符做字面化，避免查询语义被用户输入扩大。 */
function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
