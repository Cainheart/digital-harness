import BetterSqlite3 from "better-sqlite3";
import { Page, ProjectStatus } from "../../domain/common.js";
import { ReadOnlyProjectError, NotFoundError } from "../../domain/errors.js";

/** 将 SQLite 行中的 JSON 文本解析为结构化值。 */
export function jsonValue<T = unknown>(value: string): T { return JSON.parse(value) as T; }
/** 将结构化值编码为稳定 JSON 文本。 */
export function jsonText(value: unknown): string { const text = JSON.stringify(value); if (text === undefined) throw new Error("value must be JSON serializable"); return text; }
/** 确认项目存在。 */
export function ensureProject(connection: BetterSqlite3.Database, projectId: string): void { if (!connection.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new NotFoundError("项目不存在"); }
/** 确认项目允许写入，并阻止已结项/已终止/显式只读项目变更。 */
export function ensureProjectWritable(connection: BetterSqlite3.Database, projectId: string): void { const row = connection.prepare("SELECT status,read_only FROM projects WHERE id=?").get(projectId) as { status: string; read_only: number } | undefined; if (!row) throw new NotFoundError("项目不存在"); if (row.read_only || row.status === ProjectStatus.COMPLETED || row.status === ProjectStatus.TERMINATED) throw new ReadOnlyProjectError(); }
/** 保证项目子对象的复合项目边界。 */
export function ensureProjectChild(connection: BetterSqlite3.Database, table: string, projectId: string, id: string, idColumn = "id"): void { if (!connection.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND ${idColumn}=?`).get(projectId, id)) throw new NotFoundError("项目范围对象不存在"); }
/** 根据游标和 limit 构造稳定分页结果。 */
export function page<T extends { id?: string; eventId?: string }>(items: T[], limit: number): Page<T> { const hasMore = items.length > limit; const visible = hasMore ? items.slice(0, limit) : items; const last = visible.at(-1); return { items: visible, nextCursor: hasMore && last ? String(last.id ?? last.eventId) : null, hasMore }; }
