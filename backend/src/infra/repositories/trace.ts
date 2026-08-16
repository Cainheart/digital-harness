import BetterSqlite3 from "better-sqlite3";
import { Page } from "../../domain/common.js";
import { TraceLink, parseTraceLink } from "../../domain/entities.js";
import { TraceLinkInvalidError } from "../../domain/errors.js";
import { ensureProjectWritable, page } from "./common.js";

/** TraceLink 的双向查询和覆盖率仓储。 */
export class TraceRepository {
  /** 创建项目范围追踪关系；数据库 trigger 再做一次实体隔离校验。 */
  create(connection: BetterSqlite3.Database, link: TraceLink): void {
    ensureProjectWritable(connection, link.projectId);
    try {
      connection
        .prepare(
          "INSERT INTO trace_links (id,project_id,source_type,source_id,target_type,target_id,relation,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          link.id,
          link.projectId,
          link.sourceType,
          link.sourceId,
          link.targetType,
          link.targetId,
          link.relation,
          link.traceId,
          link.createdAt,
        );
    } catch (_error) {
      throw new TraceLinkInvalidError("TraceLink 关系无效", {
        data: { projectId: link.projectId },
      });
    }
  }
  /** 查询 source 指向的目标。 */
  listForward(
    connection: BetterSqlite3.Database,
    projectId: string,
    sourceType: string,
    sourceId: string,
    cursor: string | null,
    limit: number,
  ): Page<TraceLink> {
    return this.list(
      connection,
      projectId,
      "source_type",
      sourceType,
      sourceId,
      cursor,
      limit,
    );
  }
  /** 查询 target 反向关联的来源。 */
  listReverse(
    connection: BetterSqlite3.Database,
    projectId: string,
    targetType: string,
    targetId: string,
    cursor: string | null,
    limit: number,
  ): Page<TraceLink> {
    return this.list(
      connection,
      projectId,
      "target_type",
      targetType,
      targetId,
      cursor,
      limit,
    );
  }
  /** 统计指定节点在追踪链上的覆盖率。 */
  coverage(
    connection: BetterSqlite3.Database,
    projectId: string,
    sourceType: string,
    sourceIds: string[],
  ): { expectedCount: number; actualCount: number; missingIds: string[] } {
    const rows = connection
      .prepare(
        "SELECT source_id FROM trace_links WHERE project_id=? AND source_type=?",
      )
      .all(projectId, sourceType) as { source_id: string }[];
    const actual = new Set(rows.map((row) => row.source_id));
    const missingIds = sourceIds.filter((id) => !actual.has(id));
    return {
      expectedCount: sourceIds.length,
      actualCount: sourceIds.length - missingIds.length,
      missingIds,
    };
  }
  private list(
    connection: BetterSqlite3.Database,
    projectId: string,
    column: "source_type" | "target_type",
    type: string,
    id: string,
    cursor: string | null,
    limit: number,
  ): Page<TraceLink> {
    const rows = (
      cursor
        ? connection
            .prepare(
              `SELECT * FROM trace_links WHERE project_id=? AND ${column}=? AND ${column === "source_type" ? "source_id" : "target_id"}=? AND id>? ORDER BY id LIMIT ?`,
            )
            .all(projectId, type, id, cursor, limit + 1)
        : connection
            .prepare(
              `SELECT * FROM trace_links WHERE project_id=? AND ${column}=? AND ${column === "source_type" ? "source_id" : "target_id"}=? ORDER BY id LIMIT ?`,
            )
            .all(projectId, type, id, limit + 1)
    ) as TraceRow[];
    return page(
      rows.map((row) =>
        parseTraceLink({
          id: row.id,
          projectId: row.project_id,
          sourceType: row.source_type,
          sourceId: row.source_id,
          targetType: row.target_type,
          targetId: row.target_id,
          relation: row.relation,
          traceId: row.trace_id,
          createdAt: row.created_at,
          version: 1,
        }),
      ),
      limit,
    );
  }
}
type TraceRow = {
  id: string;
  project_id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relation: string;
  trace_id: string;
  created_at: string;
};
