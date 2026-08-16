import BetterSqlite3 from "better-sqlite3";
import { utcNow } from "../../domain/common.js";
import {
  ExternalDependencyUnavailableError,
  NotFoundError,
  PolicyDeniedError,
} from "../../domain/errors.js";
import type {
  PeerReview,
  PrdVersion,
  ProductSuccessMetric,
  ResearchConclusion,
  ResearchConflict,
  ResearchGrant,
  ResearchReport,
  ResearchRun,
  ResearchSecurityEvent,
  ResearchSource,
  SourceValidation,
} from "../../domain/research/index.js";
import {
  ensureProjectChild,
  ensureProjectWritable,
  jsonText,
  jsonValue,
} from "./common.js";

/** Task 6 研究事实仓储；只负责项目范围校验和 SQLite 读写，不决定业务结论。 */
export class ResearchRepository {
  /** 创建不可覆盖的 ResearchGrant，并固定项目/任务/角色/期限。 */
  createGrant(connection: BetterSqlite3.Database, grant: ResearchGrant): void {
    ensureProjectWritable(connection, grant.projectId);
    ensureProjectChild(connection, "tasks", grant.projectId, grant.taskId);
    connection
      .prepare(
        "INSERT INTO research_grants (id,project_id,task_id,role,allowed_domains_json,allowed_urls_json,max_pages,timeout_seconds,evidence_policy,network,expires_at,trace_id,pages_used,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        grant.grantId,
        grant.projectId,
        grant.taskId,
        grant.role,
        jsonText(grant.allowedDomains),
        jsonText(grant.allowedUrls),
        grant.maxPages,
        grant.timeoutSeconds,
        grant.evidencePolicy,
        grant.network,
        grant.expiresAt,
        grant.traceId,
        grant.pagesUsed,
        grant.status,
        grant.createdAt,
      );
  }

  /** 读取 Grant，并在不存在或跨项目时返回稳定的 NOT_FOUND。 */
  getGrant(connection: BetterSqlite3.Database, grantId: string): ResearchGrant {
    const row = connection
      .prepare("SELECT * FROM research_grants WHERE id=?")
      .get(grantId) as ResearchGrantRow | undefined;
    if (!row) throw new NotFoundError("ResearchGrant 不存在");
    return grantFromRow(row);
  }

  /** 原子消耗一个网页页数配额，避免并发调研超过 Grant 上限。 */
  reservePage(
    connection: BetterSqlite3.Database,
    grantId: string,
  ): ResearchGrant {
    const current = this.getGrant(connection, grantId);
    if (Date.parse(current.expiresAt) <= Date.now()) {
      connection
        .prepare(
          "UPDATE research_grants SET status='expired' WHERE id=? AND status='active'",
        )
        .run(grantId);
      throw new PolicyDeniedError("ResearchGrant 已过期，网页访问被拒绝");
    }
    const result = connection
      .prepare(
        "UPDATE research_grants SET pages_used=pages_used+1,status=CASE WHEN pages_used+1 >= max_pages THEN 'exhausted' ELSE status END WHERE id=? AND status='active' AND pages_used < max_pages",
      )
      .run(grantId);
    if (result.changes !== 1)
      throw new PolicyDeniedError(
        "ResearchGrant 页数配额已用尽，网页访问被拒绝",
      );
    return this.getGrant(connection, grantId);
  }

  /** 外部浏览器在真正打开前失败时归还预留页数，避免阻塞后无法恢复。 */
  releasePage(connection: BetterSqlite3.Database, grantId: string): void {
    connection
      .prepare(
        "UPDATE research_grants SET pages_used=pages_used-1,status=CASE WHEN expires_at <= ? THEN 'expired' ELSE 'active' END WHERE id=? AND pages_used > 0 AND status IN ('active','exhausted')",
      )
      .run(utcNow(), grantId);
  }

  /** 创建调研运行记录；外部浏览器只通过此对象回写状态。 */
  createRun(connection: BetterSqlite3.Database, run: ResearchRun): void {
    ensureProjectWritable(connection, run.projectId);
    ensureProjectChild(connection, "tasks", run.projectId, run.taskId);
    const grant = this.getGrant(connection, run.grantId);
    if (grant.projectId !== run.projectId || grant.taskId !== run.taskId)
      throw new PolicyDeniedError("调研运行与 Grant 的项目/任务范围不一致");
    connection
      .prepare(
        "INSERT INTO research_runs (id,project_id,task_id,grant_id,query,role,status,trace_id,error_code,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        run.runId,
        run.projectId,
        run.taskId,
        run.grantId,
        run.query,
        run.role,
        run.status,
        run.traceId,
        run.errorCode,
        run.createdAt,
        run.completedAt,
      );
  }

  /** 更新调研运行的最终状态，不覆盖已完成运行。 */
  updateRun(
    connection: BetterSqlite3.Database,
    runId: string,
    status: ResearchRun["status"],
    errorCode: string | null,
    completedAt: string | null,
  ): void {
    const result = connection
      .prepare(
        "UPDATE research_runs SET status=?,error_code=?,completed_at=? WHERE id=? AND status='running'",
      )
      .run(status, errorCode, completedAt, runId);
    if (result.changes !== 1)
      throw new PolicyDeniedError("调研运行已结束，不能重复写入结果");
  }

  /** 读取调研运行。 */
  getRun(connection: BetterSqlite3.Database, runId: string): ResearchRun {
    const row = connection
      .prepare("SELECT * FROM research_runs WHERE id=?")
      .get(runId) as ResearchRunRow | undefined;
    if (!row) throw new NotFoundError("调研运行不存在");
    return runFromRow(row);
  }

  /** 查询项目调研运行状态，外部依赖失败也必须可恢复地展示。 */
  listRuns(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): ResearchRun[] {
    return (
      connection
        .prepare(
          "SELECT * FROM research_runs WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as ResearchRunRow[]
    ).map(runFromRow);
  }

  /** 创建来源目录记录；网页正文必须先写入 Artifact Store 后再传入引用。 */
  createSource(
    connection: BetterSqlite3.Database,
    source: ResearchSource,
  ): void {
    ensureProjectWritable(connection, source.projectId);
    ensureProjectChild(connection, "tasks", source.projectId, source.taskId);
    if (source.runId) {
      const run = this.getRun(connection, source.runId);
      if (run.projectId !== source.projectId || run.taskId !== source.taskId)
        throw new PolicyDeniedError("来源与调研运行的项目/任务范围不一致");
    }
    connection
      .prepare(
        "INSERT INTO research_sources (id,project_id,task_id,run_id,title,url,publisher,published_at,visited_at,source_type,status,http_status,accessible,supports_conclusions_json,quote,summary,content_hash,snapshot_artifact_ref,verified_by,verified_at,verification_result,independent,conflict_evidence_json,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        source.sourceId,
        source.projectId,
        source.taskId,
        source.runId,
        source.title,
        source.url,
        source.publisher,
        source.publishedAt,
        source.visitedAt,
        source.sourceType,
        source.status,
        source.httpStatus,
        source.accessible ? 1 : 0,
        jsonText(source.supportsConclusions),
        source.quote,
        source.summary,
        source.contentHash,
        source.snapshotArtifactRef,
        source.verifiedBy,
        source.verifiedAt,
        source.verificationResult,
        source.independent === null ? null : source.independent ? 1 : 0,
        jsonText(source.conflictEvidence),
        source.traceId,
        source.createdAt,
      );
  }

  /** 查询指定项目来源目录，正文只返回脱敏引用和摘要。 */
  listSources(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): ResearchSource[] {
    return (
      connection
        .prepare(
          "SELECT * FROM research_sources WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as ResearchSourceRow[]
    ).map(sourceFromRow);
  }

  /** 按项目和来源 ID 批量读取，并拒绝缺失或跨项目来源。 */
  getSources(
    connection: BetterSqlite3.Database,
    projectId: string,
    sourceIds: string[],
  ): ResearchSource[] {
    const sources = sourceIds.map((sourceId) =>
      this.getSource(connection, sourceId),
    );
    if (sources.some((source) => source.projectId !== projectId))
      throw new PolicyDeniedError("来源不属于当前项目");
    return sources;
  }

  /** 读取单条来源。 */
  getSource(
    connection: BetterSqlite3.Database,
    sourceId: string,
  ): ResearchSource {
    const row = connection
      .prepare("SELECT * FROM research_sources WHERE id=?")
      .get(sourceId) as ResearchSourceRow | undefined;
    if (!row) throw new NotFoundError("来源不存在");
    return sourceFromRow(row);
  }

  /** 保存调研报告 Artifact 引用和来源/结论目录。 */
  createReport(
    connection: BetterSqlite3.Database,
    report: ResearchReport,
  ): void {
    ensureProjectWritable(connection, report.projectId);
    ensureProjectChild(connection, "tasks", report.projectId, report.taskId);
    const run = this.getRun(connection, report.runId);
    if (run.projectId !== report.projectId || run.taskId !== report.taskId)
      throw new PolicyDeniedError("报告与调研运行范围不一致");
    connection
      .prepare(
        "INSERT INTO research_reports (id,project_id,task_id,run_id,artifact_ref,summary,source_ids_json,conclusion_ids_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        report.reportId,
        report.projectId,
        report.taskId,
        report.runId,
        report.artifactRef,
        report.summary,
        jsonText(report.sourceIds),
        jsonText(report.conclusionIds),
        report.createdBy,
        report.createdAt,
      );
  }

  /** 将已验证结论追加到对应报告目录，不改写报告 Artifact 原文。 */
  appendReportConclusion(
    connection: BetterSqlite3.Database,
    projectId: string,
    runId: string,
    conclusionId: string,
  ): string | null {
    const row = connection
      .prepare(
        "SELECT id,conclusion_ids_json FROM research_reports WHERE project_id=? AND run_id=?",
      )
      .get(projectId, runId) as
      | { id: string; conclusion_ids_json: string }
      | undefined;
    if (!row) return null;
    const conclusionIds = jsonValue(row.conclusion_ids_json) as string[];
    if (conclusionIds.includes(conclusionId)) return row.id;
    connection
      .prepare("UPDATE research_reports SET conclusion_ids_json=? WHERE id=?")
      .run(jsonText([...conclusionIds, conclusionId]), row.id);
    return row.id;
  }

  /** 查询调研报告列表。 */
  listReports(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): ResearchReport[] {
    return (
      connection
        .prepare(
          "SELECT * FROM research_reports WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as ResearchReportRow[]
    ).map(reportFromRow);
  }

  /** 保存来源规则校验后的结论状态。 */
  createConclusion(
    connection: BetterSqlite3.Database,
    conclusion: ResearchConclusion,
  ): void {
    ensureProjectWritable(connection, conclusion.projectId);
    ensureProjectChild(
      connection,
      "tasks",
      conclusion.projectId,
      conclusion.taskId,
    );
    this.getSources(connection, conclusion.projectId, conclusion.sourceIds);
    connection
      .prepare(
        "INSERT INTO research_conclusions (id,project_id,task_id,run_id,conclusion_type,statement,source_ids_json,independence_declaration,status,required_sources,valid_independent_sources,conflicts_json,assumption_label,reviewer,evidence_refs_json,created_at,validated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        conclusion.conclusionId,
        conclusion.projectId,
        conclusion.taskId,
        conclusion.runId,
        conclusion.conclusionType,
        conclusion.statement,
        jsonText(conclusion.sourceIds),
        conclusion.independenceDeclaration ? 1 : 0,
        conclusion.status,
        conclusion.requiredSources,
        conclusion.validIndependentSources,
        jsonText(conclusion.conflicts),
        conclusion.assumptionLabel,
        conclusion.reviewer,
        jsonText(conclusion.evidenceRefs),
        conclusion.createdAt,
        conclusion.validatedAt,
      );
  }

  /** 查询项目结论。 */
  listConclusions(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): ResearchConclusion[] {
    return (
      connection
        .prepare(
          "SELECT * FROM research_conclusions WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as ResearchConclusionRow[]
    ).map(conclusionFromRow);
  }

  /** 查询单条结论。 */
  getConclusion(
    connection: BetterSqlite3.Database,
    conclusionId: string,
  ): ResearchConclusion {
    const row = connection
      .prepare("SELECT * FROM research_conclusions WHERE id=?")
      .get(conclusionId) as ResearchConclusionRow | undefined;
    if (!row) throw new NotFoundError("调研结论不存在");
    return conclusionFromRow(row);
  }

  /** 保存第二位 PM 对来源支持度和独立性的核验。 */
  createSourceValidation(
    connection: BetterSqlite3.Database,
    validation: SourceValidation,
  ): void {
    ensureProjectWritable(connection, validation.projectId);
    const conclusion = this.getConclusion(connection, validation.conclusionId);
    const source = this.getSource(connection, validation.sourceId);
    if (
      conclusion.projectId !== validation.projectId ||
      source.projectId !== validation.projectId
    )
      throw new PolicyDeniedError("来源核验对象不属于当前项目");
    connection
      .prepare(
        "INSERT INTO research_source_validations (id,project_id,conclusion_id,source_id,reviewer_role,reviewer_id,accessible,supports_statement,independent,result,rationale,conflict_ids_json,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        validation.validationId,
        validation.projectId,
        validation.conclusionId,
        validation.sourceId,
        validation.reviewerRole,
        validation.reviewerId,
        validation.accessible ? 1 : 0,
        validation.supportsStatement ? 1 : 0,
        validation.independent ? 1 : 0,
        validation.result,
        validation.rationale,
        jsonText(validation.conflictIds),
        validation.traceId,
        validation.createdAt,
      );
  }

  /** 查询项目全部来源核验记录，保留每次 PM 核验而不覆盖原始来源。 */
  listSourceValidations(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): SourceValidation[] {
    return (
      connection
        .prepare(
          "SELECT * FROM research_source_validations WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as SourceValidationRow[]
    ).map(sourceValidationFromRow);
  }

  /** 将最新来源核验结果写回目录摘要字段，详细判断仍保存在核验表中。 */
  updateSourceVerification(
    connection: BetterSqlite3.Database,
    sourceId: string,
    reviewerId: string,
    result: ResearchSource["verificationResult"],
    independent: boolean,
    verifiedAt: string,
  ): void {
    const updated = connection
      .prepare(
        "UPDATE research_sources SET verified_by=?,verified_at=?,verification_result=?,independent=? WHERE id=?",
      )
      .run(reviewerId, verifiedAt, result, independent ? 1 : 0, sourceId);
    if (updated.changes !== 1)
      throw new NotFoundError("来源不存在，不能保存核验结果");
  }

  /** 保存冲突双方证据，冲突记录只追加不覆盖。 */
  createConflict(
    connection: BetterSqlite3.Database,
    conflict: ResearchConflict,
  ): void {
    ensureProjectWritable(connection, conflict.projectId);
    connection
      .prepare(
        "INSERT INTO research_conflicts (id,project_id,conclusion_id,source_a_id,source_b_id,statement,evidence_a,evidence_b,judgment_reason,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        conflict.conflictId,
        conflict.projectId,
        conflict.conclusionId,
        conflict.sourceAId,
        conflict.sourceBId,
        conflict.statement,
        conflict.evidenceA,
        conflict.evidenceB,
        conflict.judgmentReason,
        conflict.status,
        conflict.createdAt,
      );
  }

  /** 查询项目冲突证据，供 PM 和 Boss 审查页面定位双方证据。 */
  listConflicts(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): ResearchConflict[] {
    return (
      connection
        .prepare(
          "SELECT * FROM research_conflicts WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as ResearchConflictRow[]
    ).map(conflictFromRow);
  }

  /** 创建项目成功指标；完整性由领域解析器先行保证。 */
  createMetric(
    connection: BetterSqlite3.Database,
    metric: ProductSuccessMetric,
  ): void {
    ensureProjectWritable(connection, metric.projectId);
    ensureProjectChild(connection, "tasks", metric.projectId, metric.taskId);
    connection
      .prepare(
        "INSERT INTO product_success_metrics (id,project_id,task_id,name,target_value,measurement_definition,verification_method,owner_role,reviewer_role,status,evidence_refs_json,review_id,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        metric.metricId,
        metric.projectId,
        metric.taskId,
        metric.name,
        metric.targetValue,
        metric.measurementDefinition,
        metric.verificationMethod,
        metric.owner,
        metric.reviewer,
        metric.status,
        jsonText(metric.evidenceRefs),
        metric.reviewId,
        metric.createdAt,
        metric.reviewedAt,
      );
  }

  /** 更新指标评审状态并保留评审对象引用。 */
  updateMetricReview(
    connection: BetterSqlite3.Database,
    metricId: string,
    decision: "reviewed" | "rejected",
    reviewId: string,
    reviewedAt: string,
  ): ProductSuccessMetric {
    const result = connection
      .prepare(
        "UPDATE product_success_metrics SET status=?,review_id=?,reviewed_at=? WHERE id=? AND status IN ('pending_review','draft')",
      )
      .run(decision, reviewId, reviewedAt, metricId);
    if (result.changes !== 1)
      throw new PolicyDeniedError("成功指标已经完成评审，不能重复覆盖");
    return this.getMetric(connection, metricId);
  }

  /** 查询单个成功指标。 */
  getMetric(
    connection: BetterSqlite3.Database,
    metricId: string,
  ): ProductSuccessMetric {
    const row = connection
      .prepare("SELECT * FROM product_success_metrics WHERE id=?")
      .get(metricId) as MetricRow | undefined;
    if (!row) throw new NotFoundError("项目成功指标不存在");
    return metricFromRow(row);
  }

  /** 查询项目成功指标。 */
  listMetrics(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): ProductSuccessMetric[] {
    return (
      connection
        .prepare(
          "SELECT * FROM product_success_metrics WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as MetricRow[]
    ).map(metricFromRow);
  }

  /** 创建 PRD 版本，状态由 ResearchWorkflow 的证据门禁计算后传入。 */
  createPrd(connection: BetterSqlite3.Database, prd: PrdVersion): void {
    ensureProjectWritable(connection, prd.projectId);
    ensureProjectChild(connection, "tasks", prd.projectId, prd.taskId);
    const sources = this.getSources(connection, prd.projectId, prd.sourceIds);
    if (sources.some((source) => source.taskId !== prd.taskId))
      throw new PolicyDeniedError("PRD 引用的来源不属于当前任务");
    for (const conclusionId of prd.conclusionIds) {
      const conclusion = this.getConclusion(connection, conclusionId);
      if (
        conclusion.projectId !== prd.projectId ||
        conclusion.taskId !== prd.taskId
      )
        throw new PolicyDeniedError("PRD 引用了其他项目结论");
    }
    connection
      .prepare(
        "INSERT INTO prd_versions (id,project_id,task_id,version_number,content_artifact_ref,source_ids_json,conclusion_ids_json,metric_ids_json,peer_review_ids_json,dispute_refs_json,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        prd.prdVersionId,
        prd.projectId,
        prd.taskId,
        prd.versionNumber,
        prd.contentArtifactRef,
        jsonText(prd.sourceIds),
        jsonText(prd.conclusionIds),
        jsonText(prd.metricIds),
        jsonText(prd.peerReviewIds),
        jsonText(prd.disputeRefs),
        prd.status,
        prd.createdBy,
        prd.createdAt,
      );
  }

  /** 查询项目 PRD 版本。 */
  listPrds(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): PrdVersion[] {
    return (
      connection
        .prepare(
          "SELECT * FROM prd_versions WHERE project_id=? ORDER BY version_number",
        )
        .all(projectId) as PrdRow[]
    ).map(prdFromRow);
  }

  /** 查询指定 PRD。 */
  getPrd(connection: BetterSqlite3.Database, prdVersionId: string): PrdVersion {
    const row = connection
      .prepare("SELECT * FROM prd_versions WHERE id=?")
      .get(prdVersionId) as PrdRow | undefined;
    if (!row) throw new NotFoundError("PRD 版本不存在");
    return prdFromRow(row);
  }

  /** 保存 PM 交叉评审记录，并防止跨项目引用 PRD。 */
  createPeerReview(
    connection: BetterSqlite3.Database,
    review: PeerReview,
  ): void {
    ensureProjectWritable(connection, review.projectId);
    const prd = this.getPrd(connection, review.prdVersionId);
    if (prd.projectId !== review.projectId || prd.taskId !== review.taskId)
      throw new PolicyDeniedError("PM 评审与 PRD 项目/任务范围不一致");
    connection
      .prepare(
        "INSERT INTO pm_peer_reviews (id,project_id,task_id,prd_version_id,reviewer_role,reviewer_id,decision,source_validation_summary,conflict_ids_json,comments,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        review.peerReviewId,
        review.projectId,
        review.taskId,
        review.prdVersionId,
        review.reviewerRole,
        review.reviewerId,
        review.decision,
        review.sourceValidationSummary,
        jsonText(review.conflictIds),
        review.comments,
        review.traceId,
        review.createdAt,
      );
  }

  /** 查询项目的 PM 交叉评审。 */
  listPeerReviews(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): PeerReview[] {
    return (
      connection
        .prepare(
          "SELECT * FROM pm_peer_reviews WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as PeerReviewRow[]
    ).map(peerReviewFromRow);
  }

  /** 保存提示注入等安全事件的脱敏摘要。 */
  createSecurityEvent(
    connection: BetterSqlite3.Database,
    event: ResearchSecurityEvent,
  ): void {
    ensureProjectWritable(connection, event.projectId);
    connection
      .prepare(
        "INSERT INTO research_security_events (id,project_id,task_id,run_id,source_id,categories_json,result,redaction_reason,trace_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        event.securityEventId,
        event.projectId,
        event.taskId,
        event.runId,
        event.sourceId,
        jsonText(event.categories),
        event.result,
        event.redactionReason,
        event.traceId,
        event.createdAt,
      );
  }

  /** 查询项目安全事件。 */
  listSecurityEvents(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): ResearchSecurityEvent[] {
    return (
      connection
        .prepare(
          "SELECT * FROM research_security_events WHERE project_id=? ORDER BY created_at,id",
        )
        .all(projectId) as SecurityEventRow[]
    ).map(securityEventFromRow);
  }

  /** 将外部依赖失败映射为可解释阻塞，同时保留运行记录。 */
  markRunBlocked(
    connection: BetterSqlite3.Database,
    runId: string,
    errorCode: string,
  ): void {
    try {
      this.updateRun(connection, runId, "blocked", errorCode, utcNow());
    } catch (error) {
      if (error instanceof PolicyDeniedError) throw error;
      throw new ExternalDependencyUnavailableError("调研失败状态无法持久化");
    }
  }
}

type ResearchGrantRow = {
  id: string;
  project_id: string;
  task_id: string;
  role: ResearchGrant["role"];
  allowed_domains_json: string;
  allowed_urls_json: string;
  max_pages: number;
  timeout_seconds: number;
  evidence_policy: ResearchGrant["evidencePolicy"];
  network: ResearchGrant["network"];
  expires_at: string;
  trace_id: string;
  pages_used: number;
  status: ResearchGrant["status"];
  created_at: string;
};
type ResearchRunRow = {
  id: string;
  project_id: string;
  task_id: string;
  grant_id: string;
  query: string;
  role: ResearchRun["role"];
  status: ResearchRun["status"];
  trace_id: string;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
};
type ResearchSourceRow = {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string | null;
  title: string;
  url: string;
  publisher: string | null;
  published_at: string | null;
  visited_at: string;
  source_type: ResearchSource["sourceType"];
  status: ResearchSource["status"];
  http_status: number | null;
  accessible: number;
  supports_conclusions_json: string;
  quote: string;
  summary: string;
  content_hash: string | null;
  snapshot_artifact_ref: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verification_result: ResearchSource["verificationResult"];
  independent: number | null;
  conflict_evidence_json: string;
  trace_id: string;
  created_at: string;
};
type ResearchReportRow = {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  artifact_ref: string;
  summary: string;
  source_ids_json: string;
  conclusion_ids_json: string;
  created_by: ResearchReport["createdBy"];
  created_at: string;
};
type ResearchConclusionRow = {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string | null;
  conclusion_type: ResearchConclusion["conclusionType"];
  statement: string;
  source_ids_json: string;
  independence_declaration: number;
  status: ResearchConclusion["status"];
  required_sources: number;
  valid_independent_sources: number;
  conflicts_json: string;
  assumption_label: ResearchConclusion["assumptionLabel"];
  reviewer: string | null;
  evidence_refs_json: string;
  created_at: string;
  validated_at: string | null;
};
type SourceValidationRow = {
  id: string;
  project_id: string;
  conclusion_id: string;
  source_id: string;
  reviewer_role: SourceValidation["reviewerRole"];
  reviewer_id: string;
  accessible: number;
  supports_statement: number;
  independent: number;
  result: SourceValidation["result"];
  rationale: string;
  conflict_ids_json: string;
  trace_id: string;
  created_at: string;
};
type ResearchConflictRow = {
  id: string;
  project_id: string;
  conclusion_id: string;
  source_a_id: string;
  source_b_id: string;
  statement: string;
  evidence_a: string;
  evidence_b: string;
  judgment_reason: string | null;
  status: ResearchConflict["status"];
  created_at: string;
};
type MetricRow = {
  id: string;
  project_id: string;
  task_id: string;
  name: string;
  target_value: string;
  measurement_definition: string;
  verification_method: string;
  owner_role: ProductSuccessMetric["owner"];
  reviewer_role: ProductSuccessMetric["reviewer"];
  status: ProductSuccessMetric["status"];
  evidence_refs_json: string;
  review_id: string | null;
  created_at: string;
  reviewed_at: string | null;
};
type PrdRow = {
  id: string;
  project_id: string;
  task_id: string;
  version_number: number;
  content_artifact_ref: string;
  source_ids_json: string;
  conclusion_ids_json: string;
  metric_ids_json: string;
  peer_review_ids_json: string;
  dispute_refs_json: string;
  status: PrdVersion["status"];
  created_by: PrdVersion["createdBy"];
  created_at: string;
};
type PeerReviewRow = {
  id: string;
  project_id: string;
  task_id: string;
  prd_version_id: string;
  reviewer_role: PeerReview["reviewerRole"];
  reviewer_id: string;
  decision: PeerReview["decision"];
  source_validation_summary: string;
  conflict_ids_json: string;
  comments: string;
  trace_id: string;
  created_at: string;
};
type SecurityEventRow = {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string | null;
  source_id: string | null;
  categories_json: string;
  result: ResearchSecurityEvent["result"];
  redaction_reason: string;
  trace_id: string;
  created_at: string;
};

function grantFromRow(row: ResearchGrantRow): ResearchGrant {
  return {
    grantId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    role: row.role,
    allowedDomains: jsonValue(row.allowed_domains_json),
    allowedUrls: jsonValue(row.allowed_urls_json),
    maxPages: row.max_pages,
    timeoutSeconds: row.timeout_seconds,
    evidencePolicy: row.evidence_policy,
    network: row.network,
    expiresAt: row.expires_at,
    traceId: row.trace_id,
    pagesUsed: row.pages_used,
    status: row.status,
    createdAt: row.created_at,
  };
}
function runFromRow(row: ResearchRunRow): ResearchRun {
  return {
    runId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    grantId: row.grant_id,
    query: row.query,
    role: row.role,
    status: row.status,
    traceId: row.trace_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
function sourceFromRow(row: ResearchSourceRow): ResearchSource {
  return {
    sourceId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    runId: row.run_id,
    title: row.title,
    url: row.url,
    publisher: row.publisher,
    publishedAt: row.published_at,
    visitedAt: row.visited_at,
    sourceType: row.source_type,
    status: row.status,
    httpStatus: row.http_status,
    accessible: Boolean(row.accessible),
    supportsConclusions: jsonValue(row.supports_conclusions_json),
    quote: row.quote,
    summary: row.summary,
    contentHash: row.content_hash,
    snapshotArtifactRef: row.snapshot_artifact_ref,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    verificationResult: row.verification_result,
    independent: row.independent === null ? null : Boolean(row.independent),
    conflictEvidence: jsonValue(row.conflict_evidence_json),
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}
function reportFromRow(row: ResearchReportRow): ResearchReport {
  return {
    reportId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    runId: row.run_id,
    artifactRef: row.artifact_ref,
    summary: row.summary,
    sourceIds: jsonValue(row.source_ids_json),
    conclusionIds: jsonValue(row.conclusion_ids_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
function conclusionFromRow(row: ResearchConclusionRow): ResearchConclusion {
  return {
    conclusionId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    runId: row.run_id,
    conclusionType: row.conclusion_type,
    statement: row.statement,
    sourceIds: jsonValue(row.source_ids_json),
    independenceDeclaration: Boolean(row.independence_declaration),
    status: row.status,
    requiredSources: row.required_sources,
    validIndependentSources: row.valid_independent_sources,
    conflicts: jsonValue(row.conflicts_json),
    assumptionLabel: row.assumption_label,
    reviewer: row.reviewer,
    evidenceRefs: jsonValue(row.evidence_refs_json),
    createdAt: row.created_at,
    validatedAt: row.validated_at,
  };
}
function sourceValidationFromRow(row: SourceValidationRow): SourceValidation {
  return {
    validationId: row.id,
    projectId: row.project_id,
    conclusionId: row.conclusion_id,
    sourceId: row.source_id,
    reviewerRole: row.reviewer_role,
    reviewerId: row.reviewer_id,
    accessible: Boolean(row.accessible),
    supportsStatement: Boolean(row.supports_statement),
    independent: Boolean(row.independent),
    result: row.result,
    rationale: row.rationale,
    conflictIds: jsonValue(row.conflict_ids_json),
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}
function conflictFromRow(row: ResearchConflictRow): ResearchConflict {
  return {
    conflictId: row.id,
    projectId: row.project_id,
    conclusionId: row.conclusion_id,
    sourceAId: row.source_a_id,
    sourceBId: row.source_b_id,
    statement: row.statement,
    evidenceA: row.evidence_a,
    evidenceB: row.evidence_b,
    judgmentReason: row.judgment_reason,
    status: row.status,
    createdAt: row.created_at,
  };
}
function metricFromRow(row: MetricRow): ProductSuccessMetric {
  return {
    metricId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    name: row.name,
    targetValue: row.target_value,
    measurementDefinition: row.measurement_definition,
    verificationMethod: row.verification_method,
    owner: row.owner_role,
    reviewer: row.reviewer_role,
    status: row.status,
    evidenceRefs: jsonValue(row.evidence_refs_json),
    reviewId: row.review_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}
function prdFromRow(row: PrdRow): PrdVersion {
  return {
    prdVersionId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    versionNumber: row.version_number,
    contentArtifactRef: row.content_artifact_ref,
    sourceIds: jsonValue(row.source_ids_json),
    conclusionIds: jsonValue(row.conclusion_ids_json),
    metricIds: jsonValue(row.metric_ids_json),
    peerReviewIds: jsonValue(row.peer_review_ids_json),
    disputeRefs: jsonValue(row.dispute_refs_json),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
function peerReviewFromRow(row: PeerReviewRow): PeerReview {
  return {
    peerReviewId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    prdVersionId: row.prd_version_id,
    reviewerRole: row.reviewer_role,
    reviewerId: row.reviewer_id,
    decision: row.decision,
    sourceValidationSummary: row.source_validation_summary,
    conflictIds: jsonValue(row.conflict_ids_json),
    comments: row.comments,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}
function securityEventFromRow(row: SecurityEventRow): ResearchSecurityEvent {
  return {
    securityEventId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    runId: row.run_id,
    sourceId: row.source_id,
    categories: jsonValue(row.categories_json),
    result: row.result,
    redactionReason: row.redaction_reason,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}
