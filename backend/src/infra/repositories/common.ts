import BetterSqlite3 from "better-sqlite3";
import { Page, ProjectStatus } from "../../domain/common.js";
import { ReadOnlyProjectError, NotFoundError } from "../../domain/errors.js";

/** 允许拼接到项目子对象查询中的固定表/主键映射，拒绝外部字符串进入 SQL 标识符。 */
const PROJECT_CHILD_ID_COLUMNS: Record<string, string> = {
  tasks: "id",
  artifacts: "id",
  artifact_versions: "id",
  approvals: "id",
  reviews: "id",
  test_cases: "id",
  test_runs: "id",
  defects: "id",
  execution_attempts: "id",
  model_calls: "id",
  tool_calls: "id",
  notifications: "id",
  domain_events: "event_id",
  coding_sessions: "id",
  coding_actions: "id",
  coding_observations: "id",
  coding_checkpoints: "id",
  coding_verification_runs: "id",
  coding_handoffs: "id",
};

/** 将 SQLite 行中的 JSON 文本解析为结构化值。 */
export function jsonValue<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}
/** 将结构化值编码为稳定 JSON 文本。 */
export function jsonText(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("value must be JSON serializable");
  return text;
}
/** 确认项目存在。 */
export function ensureProject(
  connection: BetterSqlite3.Database,
  projectId: string,
): void {
  if (!connection.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId))
    throw new NotFoundError("项目不存在");
}
/** 确认项目允许写入，并阻止已结项/已终止/显式只读项目变更。 */
export function ensureProjectWritable(
  connection: BetterSqlite3.Database,
  projectId: string,
): void {
  const row = connection
    .prepare("SELECT status,read_only FROM projects WHERE id=?")
    .get(projectId) as { status: string; read_only: number } | undefined;
  if (!row) throw new NotFoundError("项目不存在");
  if (
    row.read_only ||
    row.status === ProjectStatus.COMPLETED ||
    row.status === ProjectStatus.TERMINATED
  )
    throw new ReadOnlyProjectError();
}
/** 保证项目子对象的复合项目边界。 */
export function ensureProjectChild(
  connection: BetterSqlite3.Database,
  table: string,
  projectId: string,
  id: string,
  idColumn = "id",
): void {
  const allowedIdColumn = PROJECT_CHILD_ID_COLUMNS[table];
  if (!allowedIdColumn || allowedIdColumn !== idColumn) {
    throw new Error("unsupported project child table or identifier column");
  }

  if (
    !connection
      .prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND ${idColumn}=?`)
      .get(projectId, id)
  )
    throw new NotFoundError("项目范围对象不存在");
}
/** 根据游标和 limit 构造稳定分页结果。 */
export function page<T>(items: T[], limit: number): Page<T> {
  const hasMore = items.length > limit;
  const visible = hasMore ? items.slice(0, limit) : items;
  const last = visible.at(-1) as
    | { id?: string; eventId?: string; messageId?: string }
    | undefined;
  return {
    items: visible,
    nextCursor:
      hasMore && last
        ? String(last.id ?? last.eventId ?? last.messageId)
        : null,
    hasMore,
  };
}
