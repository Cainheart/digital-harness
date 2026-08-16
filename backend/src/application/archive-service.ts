import { createHash, randomBytes } from "node:crypto";
import { Database } from "../infra/database.js";
import { FileArtifactStore } from "../infra/artifacts.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import {
  InvalidArgumentError,
  NotFoundError,
  VersionConflictError,
  WorkflowGuardBlockedError,
} from "../domain/errors.js";
import { newObjectId, utcNow } from "../domain/common.js";

/** 管理历史项目删除的预览、二次确认、持久化和最小审计边界。 */
export class ArchiveService {
  private readonly projects = new ProjectTaskRepository();

  /** 注入业务数据库与证据文件库；删除操作只接受最终状态项目。 */
  constructor(
    private readonly database: Database,
    private readonly artifactStore: FileArtifactStore,
  ) {}

  /** 创建短期删除预览，响应只返回一次性 token，数据库仅保存其哈希。 */
  previewDeletion(
    projectId: string,
    input: {
      actorId: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): ArchiveDeletionPreview {
    const project = this.projects.getProject(
      this.database.connection,
      projectId,
    );
    assertFinalProject(project.status);
    assertActor(input.actorId);
    assertIdempotencyKey(input.idempotencyKey);
    assertVersion(input.expectedVersion, project.version);
    const confirmationToken = `archive-delete-${randomBytes(18).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.database.transaction((connection) => {
      connection
        .prepare(
          "INSERT INTO archive_deletion_confirmations (id,project_id,token_hash,expected_version,actor_id,status,created_at,expires_at,confirmed_at,version) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          newObjectId("archive_delete"),
          projectId,
          hashToken(confirmationToken),
          project.version,
          input.actorId,
          "previewed",
          utcNow(),
          expiresAt,
          null,
          1,
        );
    });
    return {
      projectId,
      projectName: project.name,
      status: project.status,
      endedAt: project.endedAt,
      deletionScope: deletionScope(),
      irreversibleWarning:
        "删除后项目业务内容不可恢复，仅保留项目标识、删除时间和操作者审计。",
      requiresSecondConfirmation: true,
      confirmationToken,
      expiresAt,
    };
  }

  /** 完成二次确认并删除在线业务数据；文件删除结果会明确返回，不静默吞错。 */
  confirmDeletion(
    projectId: string,
    input: {
      actorId: string;
      confirmationToken: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): ArchiveDeletionResult {
    assertActor(input.actorId);
    assertIdempotencyKey(input.idempotencyKey);
    if (!input.confirmationToken.trim()) {
      throw new InvalidArgumentError("confirmationToken 必须是非空字符串");
    }
    const project = this.projects.getProject(
      this.database.connection,
      projectId,
    );
    assertFinalProject(project.status);
    assertVersion(input.expectedVersion, project.version);
    const row = this.database.connection
      .prepare(
        "SELECT * FROM archive_deletion_confirmations WHERE project_id=? AND token_hash=? AND status='previewed'",
      )
      .get(projectId, hashToken(input.confirmationToken)) as
      ArchiveConfirmationRow | undefined;
    if (!row) {
      throw new WorkflowGuardBlockedError("删除确认无效、已使用或已过期", {
        data: { projectId },
        impact: "历史项目数据未改变",
        dataPreserved: true,
        nextAction: "重新打开历史项目并创建新的删除预览",
      });
    }
    if (row.actor_id !== input.actorId) {
      throw new WorkflowGuardBlockedError("删除确认操作者不匹配", {
        data: { projectId },
        impact: "历史项目数据未改变",
        dataPreserved: true,
        nextAction: "由创建预览的 Boss 完成二次确认",
      });
    }
    if (row.expected_version !== project.version) {
      throw new VersionConflictError("历史项目版本已变化，删除预览失效", {
        data: {
          expectedVersion: row.expected_version,
          actualVersion: project.version,
        },
      });
    }
    if (new Date(row.expires_at) <= new Date()) {
      this.expire(row.id);
      throw new WorkflowGuardBlockedError("删除确认已过期", {
        data: { projectId },
        impact: "历史项目数据未改变",
        dataPreserved: true,
        nextAction: "重新创建删除预览",
      });
    }

    const deletedAt = utcNow();
    this.database.deleteHistoricalProject(projectId, input.actorId);
    const artifactDeletion = this.artifactStore.deleteForProjectSync(projectId);
    return {
      projectId,
      deletedAt,
      actorId: input.actorId,
      artifactDeletion,
      retainedAudit: "仅保留项目标识、删除时间和操作者",
    };
  }

  /** 将未使用的确认标记为过期，避免旧 token 无限留在可用状态。 */
  private expire(confirmationId: string): void {
    this.database.connection
      .prepare(
        "UPDATE archive_deletion_confirmations SET status='expired',version=version+1 WHERE id=? AND status='previewed'",
      )
      .run(confirmationId);
  }
}

/** 删除预览返回的五类不可恢复提示信息。 */
export type ArchiveDeletionPreview = {
  projectId: string;
  projectName: string;
  status: string;
  endedAt: string | null;
  deletionScope: string[];
  irreversibleWarning: string;
  requiresSecondConfirmation: true;
  confirmationToken: string;
  expiresAt: string;
};

/** 删除结果只返回最小审计字段和文件清理结果。 */
export type ArchiveDeletionResult = {
  projectId: string;
  deletedAt: string;
  actorId: string;
  artifactDeletion: { deletedPaths: string[]; failedPaths: string[] };
  retainedAudit: string;
};

type ArchiveConfirmationRow = {
  id: string;
  expected_version: number;
  actor_id: string;
  expires_at: string;
};

/** 只允许结项和终止项目进入历史删除流程。 */
function assertFinalProject(status: string): void {
  if (status !== "已结项" && status !== "已终止") {
    throw new WorkflowGuardBlockedError("活动项目不能从历史存档删除", {
      data: { status },
      impact: "项目仍保持当前状态",
      dataPreserved: true,
      nextAction: "先通过项目终止流程处理活动项目",
    });
  }
}

/** 校验删除命令的 Boss 操作者边界。 */
function assertActor(actorId: string): void {
  if (!actorId.trim())
    throw new InvalidArgumentError("actorId 必须是非空字符串");
}

/** 校验归档删除命令具备客户端重试所需的稳定幂等键。 */
function assertIdempotencyKey(idempotencyKey: string): void {
  if (!idempotencyKey.trim())
    throw new InvalidArgumentError("idempotencyKey 必须是非空字符串");
}

/** 校验前端携带的 expectedVersion，防止删除过期历史投影。 */
function assertVersion(expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new InvalidArgumentError("expectedVersion 必须是正整数");
  }
  if (expected !== actual) {
    throw new VersionConflictError("项目版本已变化，未执行删除", {
      data: { expectedVersion: expected, actualVersion: actual },
    });
  }
}

/** 将确认 token 转成不可逆摘要，避免敏感操作凭据进入 SQLite。 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 固定删除范围，避免页面或请求体伪造删除边界。 */
function deletionScope(): string[] {
  return [
    "项目当前状态",
    "任务与任务依赖",
    "审批、通知与事件",
    "交付物及版本",
    "测试、缺陷、Review、调研和编码证据",
    "调用与追踪记录",
  ];
}
