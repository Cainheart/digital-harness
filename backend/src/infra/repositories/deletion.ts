import { Database } from "../database.js";
import { FileArtifactStore, ArtifactDeleteReport } from "../artifacts.js";

/** 协调历史项目在线数据 purge、Artifact 删除和最小删除审计。 */
export class ProjectDeletionRepository {
  constructor(
    private readonly database: Database,
    private readonly artifactStore: FileArtifactStore,
  ) {}
  /** 删除历史项目并在数据库中保留删除审计；文件删除结果由调用方继续验收。 */
  deleteHistoricalProject(
    projectId: string,
    actorId: string,
  ): ArtifactDeleteReport {
    this.database.deleteHistoricalProject(projectId, actorId);
    return this.artifactStore.deleteForProjectSync(projectId);
  }
  /** 判断项目在线记录是否存在。 */
  projectExists(projectId: string): boolean {
    return this.database.projectExists(projectId);
  }
  /** 读取项目最小删除审计。 */
  deletionAudit(projectId: string): Record<string, unknown> | null {
    return this.database.connection
      .prepare(
        "SELECT project_id AS projectId,deleted_at AS deletedAt,actor_id AS actorId FROM project_deletion_audits WHERE project_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(projectId) as Record<string, unknown> | null;
  }
}
