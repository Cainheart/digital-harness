import { Buffer } from "node:buffer";
import type BetterSqlite3 from "better-sqlite3";
import { newObjectId, utcNow } from "../domain/common.js";
import {
  ExternalDependencyUnavailableError,
  EvidenceIncompleteError,
  InvalidArgumentError,
  NotFoundError,
  PolicyDeniedError,
} from "../domain/errors.js";
import {
  canonicalUrl,
  isAllowedResearchUrl,
  parseResearchGrant,
  type PeerReview,
  type PrdVersion,
  type ProductSuccessMetric,
  type ResearchConclusion,
  type ResearchGrant,
  type ResearchReport,
  type ResearchRun,
  type ResearchSecurityEvent,
  type ResearchSource,
  type SourceValidation,
} from "../domain/research/index.js";
import { parseProductSuccessMetric } from "../domain/product-success-metrics/index.js";
import { Database } from "../infra/database.js";
import { FileArtifactStore } from "../infra/artifacts.js";
import { ResearchRepository } from "../infra/repositories/research.js";
import { TraceRepository } from "../infra/repositories/trace.js";
import { redactJson } from "../security/redaction.js";
import { ResearchAdapter } from "../research/adapter.js";
import { SourceValidator } from "../research/source-validator.js";

/** Task 6 的应用服务，串联 Research Adapter、Artifact、来源规则和 PM 交付物。 */
export class ResearchWorkflow {
  private readonly repository: ResearchRepository;
  private readonly validator: SourceValidator;
  private readonly traces = new TraceRepository();

  /** 绑定数据库、证据存储和受控浏览器适配器；服务不拥有浏览器外的执行权限。 */
  constructor(
    private readonly database: Database,
    private readonly artifactStore: FileArtifactStore,
    private readonly adapter: ResearchAdapter,
    repository = new ResearchRepository(),
    validator = new SourceValidator(),
  ) {
    this.repository = repository;
    this.validator = validator;
  }

  /** 创建与项目/任务/PM 角色/公开域名绑定的 ResearchGrant。 */
  createGrant(
    projectId: string,
    rawInput: Record<string, unknown>,
    traceId: string,
  ): ResearchGrant {
    const input = {
      ...rawInput,
      projectId,
      grantId: rawInput.grantId ?? newObjectId("research_grant"),
      traceId,
      createdAt: utcNow(),
    };
    let grant: ResearchGrant;
    try {
      grant = parseResearchGrant(input);
    } catch (error) {
      throw new InvalidArgumentError(
        error instanceof Error ? error.message : "ResearchGrant 参数无效",
        { traceId },
      );
    }
    this.database.transaction((connection) => {
      this.repository.createGrant(connection, grant);
      this.appendRuntimeEvent(connection, "ResearchGrantCreated", traceId, {
        grantId: grant.grantId,
        projectId,
        taskId: grant.taskId,
        role: grant.role,
        maxPages: grant.maxPages,
      });
    });
    return grant;
  }

  /** 执行一次搜索/打开/提取/来源固化流程，并生成报告 Artifact。 */
  async startRun(
    projectId: string,
    rawInput: Record<string, unknown>,
    traceId: string,
  ): Promise<{
    run: ResearchRun;
    report: ResearchReport;
    sources: ResearchSource[];
    securityEvents: ResearchSecurityEvent[];
  }> {
    const grantId = requireText(rawInput.grantId, "grantId", traceId);
    const query = requireText(rawInput.query, "query", traceId);
    const grant = this.repository.getGrant(this.database.connection, grantId);
    if (grant.projectId !== projectId)
      throw new PolicyDeniedError("ResearchGrant 不属于当前项目", { traceId });
    const run: ResearchRun = {
      runId: newObjectId("research_run"),
      projectId,
      taskId: grant.taskId,
      grantId,
      query,
      role: grant.role,
      status: "running",
      traceId,
      errorCode: null,
      createdAt: utcNow(),
      completedAt: null,
    };
    this.database.transaction((connection) =>
      this.repository.createRun(connection, run),
    );
    const sourceIds: string[] = [];
    const securityEvents: ResearchSecurityEvent[] = [];
    try {
      const urls = await this.resolveSourceUrls(
        grant,
        rawInput,
        query,
        traceId,
      );
      if (urls.length === 0)
        throw new ExternalDependencyUnavailableError(
          "搜索未返回 Grant 白名单内的公开来源",
          { traceId },
        );
      for (const url of urls) {
        const page = await this.adapter.open(grant, url);
        const extracted = await this.adapter.extract(grant, page, {
          quote:
            typeof rawInput.quote === "string" ? rawInput.quote : undefined,
        });
        const sourceId = newObjectId("research_source");
        const snapshot = await this.artifactStore.put(
          Buffer.from(extracted.cleanedText, "utf8"),
          "text/plain",
          { projectId, artifactId: newObjectId("research_snapshot") },
        );
        const previous = this.repository
          .listSources(this.database.connection, projectId)
          .find(
            (candidate) =>
              canonicalUrl(candidate.url) === canonicalUrl(url) ||
              candidate.contentHash === extracted.contentHash,
          );
        const sourceType = this.validator.classify({
          url,
          publisher: page.publisher,
          declaredOfficial: rawInput.declaredOfficial === true,
          duplicateOf: previous ?? null,
          accessible: page.accessible,
        });
        const source: ResearchSource = {
          sourceId,
          projectId,
          taskId: grant.taskId,
          runId: run.runId,
          title: page.title || url,
          url,
          publisher: page.publisher,
          publishedAt: page.publishedAt,
          visitedAt: page.visitedAt,
          sourceType,
          status: page.accessible ? "accessed" : "failed",
          httpStatus: page.httpStatus,
          accessible: page.accessible,
          supportsConclusions: [],
          quote: extracted.quote,
          summary: extracted.summary,
          contentHash: extracted.contentHash,
          snapshotArtifactRef: snapshot.storeRef,
          verifiedBy: null,
          verifiedAt: null,
          verificationResult: "unverified",
          independent: previous ? false : null,
          conflictEvidence: [],
          traceId,
          createdAt: utcNow(),
        };
        this.database.transaction((connection) => {
          this.repository.createSource(connection, source);
          this.linkTrace(
            connection,
            projectId,
            "research_run",
            run.runId,
            "research_source",
            sourceId,
            "produced_source",
            traceId,
          );
          this.appendRuntimeEvent(
            connection,
            "ResearchSourceRecorded",
            traceId,
            {
              runId: run.runId,
              sourceId,
              sourceType,
              accessible: source.accessible,
              contentHash: source.contentHash,
            },
          );
        });
        sourceIds.push(sourceId);
        if (extracted.injectionDetected) {
          const event: ResearchSecurityEvent = {
            securityEventId: newObjectId("research_security"),
            projectId,
            taskId: grant.taskId,
            runId: run.runId,
            sourceId,
            categories: extracted.injectionCategories,
            result: "continued_with_untrusted_text",
            redactionReason:
              extracted.riskSummary ?? "网页正文按不可信输入处理",
            traceId,
            createdAt: utcNow(),
          };
          this.database.transaction((connection) => {
            this.repository.createSecurityEvent(connection, event);
            this.appendRuntimeEvent(
              connection,
              "ResearchPromptInjectionDetected",
              traceId,
              {
                runId: run.runId,
                sourceId,
                categories: event.categories,
                result: event.result,
                redactionReason: event.redactionReason,
              },
            );
          });
          securityEvents.push(event);
        }
      }
      const report = await this.createReport(run, sourceIds, grant.role);
      this.database.transaction((connection) => {
        this.repository.updateRun(
          connection,
          run.runId,
          "completed",
          null,
          utcNow(),
        );
        this.appendRuntimeEvent(connection, "ResearchRunCompleted", traceId, {
          runId: run.runId,
          reportId: report.reportId,
          sourceCount: sourceIds.length,
        });
      });
      return {
        run: this.repository.getRun(this.database.connection, run.runId),
        report,
        sources: this.repository
          .listSources(this.database.connection, projectId)
          .filter((source) => sourceIds.includes(source.sourceId)),
        securityEvents,
      };
    } catch (error) {
      const errorCode =
        error instanceof ExternalDependencyUnavailableError
          ? error.code
          : error instanceof PolicyDeniedError
            ? error.code
            : "RESEARCH_BROWSER_FAILED";
      this.database.transaction((connection) => {
        this.repository.updateRun(
          connection,
          run.runId,
          "blocked",
          errorCode,
          utcNow(),
        );
        this.appendRuntimeEvent(connection, "ResearchRunBlocked", traceId, {
          runId: run.runId,
          errorCode,
          dataPreserved: true,
        });
      });
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof PolicyDeniedError
      )
        throw error;
      throw new ExternalDependencyUnavailableError(
        "公开网页访问失败，调研任务保持阻塞",
        {
          traceId,
          data: { runId: run.runId, errorCode },
        },
      );
    }
  }

  /** 按官方事实/方向性结论来源规则校验并保存结论。 */
  validateConclusion(
    projectId: string,
    rawInput: Record<string, unknown>,
    traceId: string,
  ): ResearchConclusion {
    const taskId = requireText(rawInput.taskId, "taskId", traceId);
    const statement = requireText(rawInput.statement, "statement", traceId);
    const sourceIds = requireStringArray(
      rawInput.sourceIds,
      "sourceIds",
      traceId,
    );
    const conclusionType = requireConclusionType(
      rawInput.conclusionType,
      traceId,
    );
    const independenceDeclaration = rawInput.independenceDeclaration === true;
    const sources = this.repository.getSources(
      this.database.connection,
      projectId,
      sourceIds,
    );
    if (sources.some((source) => source.taskId !== taskId))
      throw new PolicyDeniedError("结论引用的来源不属于当前任务", { traceId });
    const existing = this.repository.listConclusions(
      this.database.connection,
      projectId,
    );
    const sourceRunIds = new Set(
      sources
        .map((source) => source.runId)
        .filter((runId): runId is string => Boolean(runId)),
    );
    const requestedRunId =
      rawInput.runId === undefined
        ? null
        : requireText(rawInput.runId, "runId", traceId);
    const runId =
      requestedRunId ?? (sourceRunIds.size === 1 ? [...sourceRunIds][0] : null);
    if (runId) {
      const run = this.repository.getRun(this.database.connection, runId);
      if (
        run.projectId !== projectId ||
        run.taskId !== taskId ||
        [...sourceRunIds].some((sourceRunId) => sourceRunId !== runId)
      )
        throw new PolicyDeniedError(
          "结论关联的调研运行不属于当前项目/任务或来源",
          { traceId },
        );
    }
    const result = this.validator.validateConclusion(
      { conclusionType, statement, sources, independenceDeclaration },
      existing,
    );
    const conclusion: ResearchConclusion = {
      conclusionId: newObjectId("research_conclusion"),
      projectId,
      taskId,
      runId,
      conclusionType,
      statement,
      sourceIds,
      independenceDeclaration,
      status: result.status,
      requiredSources: result.requiredSources,
      validIndependentSources: result.validIndependentSources,
      conflicts: result.conflicts.map((conflict) => conflict.conflictId),
      assumptionLabel: result.assumptionLabel,
      reviewer:
        typeof rawInput.reviewer === "string" ? rawInput.reviewer : null,
      evidenceRefs: sources
        .map((source) => source.snapshotArtifactRef)
        .filter((ref): ref is string => Boolean(ref)),
      createdAt: utcNow(),
      validatedAt: utcNow(),
    };
    this.database.transaction((connection) => {
      this.repository.createConclusion(connection, conclusion);
      for (const sourceId of conclusion.sourceIds)
        this.linkTrace(
          connection,
          projectId,
          "research_source",
          sourceId,
          "research_conclusion",
          conclusion.conclusionId,
          "supports_conclusion",
          traceId,
        );
      for (const conflict of result.conflicts) {
        this.repository.createConflict(connection, {
          ...conflict,
          conclusionId: conclusion.conclusionId,
        });
        this.linkTrace(
          connection,
          projectId,
          "research_conclusion",
          conclusion.conclusionId,
          "research_conflict",
          conflict.conflictId,
          "has_conflict",
          traceId,
        );
      }
      if (conclusion.runId) {
        const reportId = this.repository.appendReportConclusion(
          connection,
          projectId,
          conclusion.runId,
          conclusion.conclusionId,
        );
        if (reportId)
          this.linkTrace(
            connection,
            projectId,
            "research_report",
            reportId,
            "research_conclusion",
            conclusion.conclusionId,
            "contains_conclusion",
            traceId,
          );
      }
      this.appendRuntimeEvent(
        connection,
        "ResearchConclusionValidated",
        traceId,
        {
          conclusionId: conclusion.conclusionId,
          status: conclusion.status,
          requiredSources: conclusion.requiredSources,
          validIndependentSources: conclusion.validIndependentSources,
          conflictCount: conclusion.conflicts.length,
        },
      );
    });
    return conclusion;
  }

  /** 创建 PM 项目成功指标；指标缺少交叉评审时不能进入 PRD 审批。 */
  createMetric(
    projectId: string,
    rawInput: Record<string, unknown>,
    traceId: string,
  ): ProductSuccessMetric {
    const taskId = requireText(rawInput.taskId, "taskId", traceId);
    let parsed: ReturnType<typeof parseProductSuccessMetric>;
    try {
      parsed = parseProductSuccessMetric(rawInput, projectId, taskId);
    } catch (error) {
      throw new InvalidArgumentError(
        error instanceof Error ? error.message : "成功指标参数无效",
        { traceId },
      );
    }
    const metric: ProductSuccessMetric = {
      ...parsed,
      metricId: newObjectId("metric"),
      reviewId: null,
      createdAt: utcNow(),
      reviewedAt: null,
    };
    this.database.transaction((connection) => {
      this.repository.createMetric(connection, metric);
      this.appendRuntimeEvent(
        connection,
        "ProductSuccessMetricCreated",
        traceId,
        {
          metricId: metric.metricId,
          projectId,
          owner: metric.owner,
          reviewer: metric.reviewer,
        },
      );
    });
    return metric;
  }

  /** 创建第二位 PM 的 PRD/来源交叉评审，并将指标更新为 reviewed/rejected。 */
  peerReview(
    projectId: string,
    rawInput: Record<string, unknown>,
    traceId: string,
  ): PeerReview {
    const taskId = requireText(rawInput.taskId, "taskId", traceId);
    const prdVersionId = requireText(
      rawInput.prdVersionId,
      "prdVersionId",
      traceId,
    );
    const reviewerId = requireText(rawInput.reviewerId, "reviewerId", traceId);
    const reviewerRole = requireReviewerRole(rawInput.reviewerRole, traceId);
    const decision =
      rawInput.decision === "approved" || rawInput.decision === "rejected"
        ? rawInput.decision
        : null;
    if (!decision)
      throw new InvalidArgumentError("decision 必须是 approved 或 rejected", {
        traceId,
      });
    const comments = requireText(
      rawInput.comments ?? "PM 交叉评审",
      "comments",
      traceId,
    );
    const metricIds =
      rawInput.metricIds === undefined
        ? []
        : requireStringArray(rawInput.metricIds, "metricIds", traceId);
    const sourceValidations =
      rawInput.sourceValidations === undefined
        ? []
        : requireRecordArray(
            rawInput.sourceValidations,
            "sourceValidations",
            traceId,
          );
    const review: PeerReview = {
      peerReviewId: newObjectId("pm_peer_review"),
      projectId,
      taskId,
      prdVersionId,
      reviewerRole,
      reviewerId,
      decision,
      sourceValidationSummary: requireText(
        rawInput.sourceValidationSummary ??
          "已核验来源可访问性、支持度和独立性",
        "sourceValidationSummary",
        traceId,
      ),
      conflictIds:
        rawInput.conflictIds === undefined
          ? []
          : requireStringArray(rawInput.conflictIds, "conflictIds", traceId),
      comments,
      traceId,
      createdAt: utcNow(),
    };
    this.database.transaction((connection) => {
      const prd = this.repository.getPrd(connection, prdVersionId);
      if (prd.projectId !== projectId || prd.taskId !== taskId)
        throw new PolicyDeniedError("PM 评审不属于当前项目/任务", { traceId });
      if (samePmRole(prd.createdBy, reviewerRole))
        throw new PolicyDeniedError("PRD 交叉评审必须由另一位 PM 执行", {
          traceId,
        });
      const validations = sourceValidations.map((input) =>
        this.buildSourceValidation(
          connection,
          prd,
          input,
          reviewerRole,
          reviewerId,
          traceId,
        ),
      );
      if (decision === "approved") {
        const reviewedSourceIds = new Set(
          validations.map((validation) => validation.sourceId),
        );
        if (prd.sourceIds.some((sourceId) => !reviewedSourceIds.has(sourceId)))
          throw new EvidenceIncompleteError(
            "通过评审必须逐条核验 PRD 引用的来源",
            { traceId },
          );
        if (validations.some((validation) => validation.result !== "supported"))
          throw new EvidenceIncompleteError(
            "存在未被第二位 PM 支持的来源，不能通过评审",
            { traceId },
          );
      }
      this.repository.createPeerReview(connection, review);
      for (const validation of validations) {
        this.repository.createSourceValidation(connection, validation);
        this.repository.updateSourceVerification(
          connection,
          validation.sourceId,
          reviewerId,
          validation.result,
          validation.independent,
          validation.createdAt,
        );
        this.linkTrace(
          connection,
          projectId,
          "research_source",
          validation.sourceId,
          "research_source_validation",
          validation.validationId,
          "validated_by_pm",
          traceId,
        );
        this.linkTrace(
          connection,
          projectId,
          "research_source_validation",
          validation.validationId,
          "research_conclusion",
          validation.conclusionId,
          "validates_conclusion",
          traceId,
        );
        for (const conflictId of validation.conflictIds)
          this.linkTrace(
            connection,
            projectId,
            "research_source_validation",
            validation.validationId,
            "research_conflict",
            conflictId,
            "records_conflict",
            traceId,
          );
      }
      for (const metricId of metricIds) {
        const metric = this.repository.getMetric(connection, metricId);
        if (metric.projectId !== projectId || metric.taskId !== taskId)
          throw new PolicyDeniedError("成功指标不属于当前项目/任务", {
            traceId,
          });
        this.repository.updateMetricReview(
          connection,
          metricId,
          decision === "approved" ? "reviewed" : "rejected",
          review.peerReviewId,
          review.createdAt,
        );
      }
      this.linkTrace(
        connection,
        projectId,
        "prd_version",
        prdVersionId,
        "pm_peer_review",
        review.peerReviewId,
        "reviewed_by_pm",
        traceId,
      );
      for (const metricId of metricIds)
        this.linkTrace(
          connection,
          projectId,
          "product_success_metric",
          metricId,
          "pm_peer_review",
          review.peerReviewId,
          "metric_review",
          traceId,
        );
      const peerReviewIds = [...prd.peerReviewIds, review.peerReviewId];
      connection
        .prepare(
          "UPDATE prd_versions SET peer_review_ids_json=? WHERE id=? AND status='draft'",
        )
        .run(JSON.stringify(peerReviewIds), prd.prdVersionId);
      this.tryMarkPrdReady(connection, { ...prd, peerReviewIds });
      this.appendRuntimeEvent(connection, "PmPeerReviewRecorded", traceId, {
        peerReviewId: review.peerReviewId,
        prdVersionId,
        decision,
        metricCount: metricIds.length,
        sourceValidationCount: validations.length,
      });
    });
    return review;
  }

  /** 创建 PRD 草稿或申请 Boss 审批；ready_for_approval 必须通过完整证据门禁。 */
  async createPrd(
    projectId: string,
    rawInput: Record<string, unknown>,
    traceId: string,
  ): Promise<PrdVersion> {
    const taskId = requireText(rawInput.taskId, "taskId", traceId);
    const createdBy = requireResearchRole(rawInput.createdBy, traceId);
    const content = requireText(rawInput.content, "content", traceId);
    const sourceIds = requireStringArray(
      rawInput.sourceIds,
      "sourceIds",
      traceId,
    );
    const conclusionIds = requireStringArray(
      rawInput.conclusionIds,
      "conclusionIds",
      traceId,
    );
    const metricIds = requireStringArray(
      rawInput.metricIds,
      "metricIds",
      traceId,
    );
    const peerReviewIds =
      rawInput.peerReviewIds === undefined
        ? []
        : requireStringArray(rawInput.peerReviewIds, "peerReviewIds", traceId);
    const disputeRefs =
      rawInput.disputeRefs === undefined
        ? []
        : requireStringArray(rawInput.disputeRefs, "disputeRefs", traceId);
    const requestedStatus =
      rawInput.status === "ready_for_approval" ? "ready_for_approval" : "draft";
    const artifact = await this.artifactStore.put(
      Buffer.from(content, "utf8"),
      "text/markdown",
      {
        projectId,
        artifactId: newObjectId("prd_artifact"),
      },
    );
    const prd: PrdVersion = {
      prdVersionId: newObjectId("prd_version"),
      projectId,
      taskId,
      versionNumber: this.nextPrdVersion(projectId),
      contentArtifactRef: artifact.storeRef,
      sourceIds,
      conclusionIds,
      metricIds,
      peerReviewIds,
      disputeRefs,
      status: requestedStatus,
      createdBy,
      createdAt: utcNow(),
    };
    this.database.transaction((connection) => {
      for (const metricId of metricIds) {
        const metric = this.repository.getMetric(connection, metricId);
        if (metric.projectId !== projectId || metric.taskId !== taskId)
          throw new PolicyDeniedError("PRD 引用了其他项目的成功指标", {
            traceId,
          });
      }
      for (const peerReviewId of peerReviewIds) {
        const peer = connection
          .prepare("SELECT project_id,task_id FROM pm_peer_reviews WHERE id=?")
          .get(peerReviewId) as { project_id: string; task_id: string } | undefined;
        if (
          !peer ||
          peer.project_id !== projectId ||
          peer.task_id !== taskId
        )
          throw new PolicyDeniedError("PRD 引用了其他项目或不存在的 PM 评审", {
            traceId,
          });
      }
      if (requestedStatus === "ready_for_approval")
        this.assertPrdEvidenceComplete(connection, prd);
      this.repository.createPrd(connection, prd);
      for (const sourceId of prd.sourceIds)
        this.linkTrace(
          connection,
          projectId,
          "research_source",
          sourceId,
          "prd_version",
          prd.prdVersionId,
          "prd_source",
          traceId,
        );
      for (const conclusionId of prd.conclusionIds)
        this.linkTrace(
          connection,
          projectId,
          "research_conclusion",
          conclusionId,
          "prd_version",
          prd.prdVersionId,
          "prd_conclusion",
          traceId,
        );
      for (const metricId of prd.metricIds)
        this.linkTrace(
          connection,
          projectId,
          "product_success_metric",
          metricId,
          "prd_version",
          prd.prdVersionId,
          "prd_metric",
          traceId,
        );
      for (const peerReviewId of prd.peerReviewIds)
        this.linkTrace(
          connection,
          projectId,
          "pm_peer_review",
          peerReviewId,
          "prd_version",
          prd.prdVersionId,
          "prd_peer_review",
          traceId,
        );
      this.appendRuntimeEvent(connection, "PrdVersionCreated", traceId, {
        prdVersionId: prd.prdVersionId,
        versionNumber: prd.versionNumber,
        status: prd.status,
      });
    });
    return prd;
  }

  /** 返回项目调研对象，供 API、看板和审查页面使用。 */
  getProjectResearch(projectId: string): Record<string, unknown> {
    const connection = this.database.connection;
    return {
      grants: this.listGrants(projectId),
      runs: this.repository.listRuns(connection, projectId),
      sources: this.repository.listSources(connection, projectId),
      reports: this.repository.listReports(connection, projectId),
      conclusions: this.repository.listConclusions(connection, projectId),
      sourceValidations: this.repository.listSourceValidations(
        connection,
        projectId,
      ),
      conflicts: this.repository.listConflicts(connection, projectId),
      metrics: this.repository.listMetrics(connection, projectId),
      prds: this.repository.listPrds(connection, projectId),
      peerReviews: this.repository.listPeerReviews(connection, projectId),
      securityEvents: this.repository.listSecurityEvents(connection, projectId),
    };
  }

  /** 供工作流审批门禁查询：当前项目必须存在可进入 Boss 审批的 PRD。 */
  assertPrdReadyForApproval(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): void {
    const row = connection
      .prepare(
        "SELECT id FROM prd_versions WHERE project_id=? AND status='ready_for_approval' ORDER BY version_number DESC LIMIT 1",
      )
      .get(projectId) as { id: string } | undefined;
    if (!row)
      throw new EvidenceIncompleteError(
        "PRD 缺少来源、成功指标或双 PM 评审，不能进入 Boss 审批",
        { data: { projectId } },
      );
    try {
      this.assertPrdEvidenceComplete(
        connection,
        this.repository.getPrd(connection, row.id),
      );
    } catch (error) {
      if (error instanceof EvidenceIncompleteError) throw error;
      throw new EvidenceIncompleteError(
        "PRD 的来源、结论或评审引用已失效，不能进入 Boss 审批",
        {
          data: {
            projectId,
            reason:
              error instanceof Error
                ? error.message
                : "evidence_reference_invalid",
          },
        },
      );
    }
  }

  /** 将第二位 PM 的逐来源核验输入转换为不可变核验事实。 */
  private buildSourceValidation(
    connection: BetterSqlite3.Database,
    prd: PrdVersion,
    input: Record<string, unknown>,
    reviewerRole: PeerReview["reviewerRole"],
    reviewerId: string,
    traceId: string,
  ): SourceValidation {
    const sourceId = requireText(
      input.sourceId,
      "sourceValidation.sourceId",
      traceId,
    );
    const conclusionId = requireText(
      input.conclusionId,
      "sourceValidation.conclusionId",
      traceId,
    );
    const conclusion = this.repository.getConclusion(connection, conclusionId);
    const source = this.repository.getSource(connection, sourceId);
    if (
      conclusion.projectId !== prd.projectId ||
      conclusion.taskId !== prd.taskId ||
      !prd.conclusionIds.includes(conclusionId) ||
      !prd.sourceIds.includes(sourceId) ||
      !conclusion.sourceIds.includes(sourceId) ||
      source.projectId !== prd.projectId ||
      source.taskId !== prd.taskId
    )
      throw new PolicyDeniedError("来源核验必须属于当前 PRD 的同一任务和结论", {
        traceId,
      });
    const result = input.result;
    if (
      result !== "supported" &&
      result !== "unsupported" &&
      result !== "conflicted"
    )
      throw new InvalidArgumentError("sourceValidation.result 无效", {
        traceId,
      });
    const rationale = requireText(
      input.rationale,
      "sourceValidation.rationale",
      traceId,
    );
    const conflictIds =
      input.conflictIds === undefined
        ? []
        : requireStringArray(
            input.conflictIds,
            "sourceValidation.conflictIds",
            traceId,
          );
    for (const conflictId of conflictIds) {
      const conflict = connection
        .prepare(
          "SELECT project_id,conclusion_id FROM research_conflicts WHERE id=?",
        )
        .get(conflictId) as
        | { project_id: string; conclusion_id: string }
        | undefined;
      if (
        !conflict ||
        conflict.project_id !== prd.projectId ||
        conflict.conclusion_id !== conclusionId
      )
        throw new PolicyDeniedError(
          "来源核验引用了其他项目或其他结论的冲突证据",
          { traceId },
        );
    }
    const accessible = requireBoolean(
      input.accessible,
      "sourceValidation.accessible",
      traceId,
    );
    const supportsStatement = requireBoolean(
      input.supportsStatement,
      "sourceValidation.supportsStatement",
      traceId,
    );
    const independent = requireBoolean(
      input.independent,
      "sourceValidation.independent",
      traceId,
    );
    if (result === "supported" && (!accessible || !supportsStatement))
      throw new EvidenceIncompleteError(
        "来源核验标记为 supported 时必须可访问且支持结论",
        { traceId },
      );
    return {
      validationId: newObjectId("research_source_validation"),
      projectId: prd.projectId,
      conclusionId,
      sourceId,
      reviewerRole,
      reviewerId,
      accessible,
      supportsStatement,
      independent,
      result,
      rationale,
      conflictIds,
      traceId,
      createdAt: utcNow(),
    };
  }

  private async resolveSourceUrls(
    grant: ResearchGrant,
    rawInput: Record<string, unknown>,
    query: string,
    traceId: string,
  ): Promise<string[]> {
    const directUrls =
      rawInput.sourceUrls === undefined
        ? []
        : requireStringArray(rawInput.sourceUrls, "sourceUrls", traceId);
    if (directUrls.length > 0) {
      if (directUrls.length > grant.maxPages)
        throw new PolicyDeniedError(
          "sourceUrls 数量超过 ResearchGrant 页数配额",
          { traceId },
        );
      const allowed = directUrls.filter((url) =>
        isAllowedResearchUrl(grant, url),
      );
      if (allowed.length !== directUrls.length)
        throw new PolicyDeniedError(
          "sourceUrls 中包含不在 Grant 白名单内的 URL",
        );
      return allowed;
    }
    const results = await this.adapter.search(grant, query);
    return results
      .map((result) => result.url)
      .filter((url) => {
        try {
          return isAllowedResearchUrl(grant, url);
        } catch (_error) {
          return false;
        }
      })
      .slice(0, Math.min(grant.maxPages, 20));
  }

  private async createReport(
    run: ResearchRun,
    sourceIds: string[],
    createdBy: ResearchGrant["role"],
  ): Promise<ResearchReport> {
    const summary = `调研运行 ${run.runId} 已保存 ${sourceIds.length} 条来源证据；网页正文按不可信输入处理。`;
    const artifact = await this.artifactStore.put(
      Buffer.from(
        JSON.stringify({ runId: run.runId, sourceIds, summary }),
        "utf8",
      ),
      "application/json",
      {
        projectId: run.projectId,
        artifactId: newObjectId("research_report_artifact"),
      },
    );
    const report: ResearchReport = {
      reportId: newObjectId("research_report"),
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.runId,
      artifactRef: artifact.storeRef,
      summary,
      sourceIds,
      conclusionIds: [],
      createdBy,
      createdAt: utcNow(),
    };
    this.database.transaction((connection) => {
      this.repository.createReport(connection, report);
      this.linkTrace(
        connection,
        run.projectId,
        "research_run",
        run.runId,
        "research_report",
        report.reportId,
        "produced_report",
        run.traceId,
      );
    });
    return report;
  }

  private listGrants(projectId: string): ResearchGrant[] {
    const rows = this.database.connection
      .prepare(
        "SELECT id FROM research_grants WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId) as { id: string }[];
    return rows.map((row) =>
      this.repository.getGrant(this.database.connection, row.id),
    );
  }

  private nextPrdVersion(projectId: string): number {
    const row = this.database.connection
      .prepare(
        "SELECT COALESCE(MAX(version_number),0) AS version FROM prd_versions WHERE project_id=?",
      )
      .get(projectId) as { version: number };
    return row.version + 1;
  }

  private tryMarkPrdReady(
    connection: BetterSqlite3.Database,
    prd: PrdVersion,
  ): void {
    try {
      this.assertPrdEvidenceComplete(connection, prd);
      connection
        .prepare(
          "UPDATE prd_versions SET status='ready_for_approval' WHERE id=? AND status='draft'",
        )
        .run(prd.prdVersionId);
    } catch (error) {
      if (!(error instanceof EvidenceIncompleteError)) throw error;
    }
  }

  private assertPrdEvidenceComplete(
    connection: BetterSqlite3.Database,
    prd: PrdVersion,
  ): void {
    const sources = prd.sourceIds.map((id) =>
      this.repository.getSource(connection, id),
    );
    const conclusions = prd.conclusionIds.map((id) =>
      this.repository.getConclusion(connection, id),
    );
    const metrics = prd.metricIds.map((id) =>
      this.repository.getMetric(connection, id),
    );
    const reviews = prd.peerReviewIds.map((id) => {
      const row = connection
        .prepare("SELECT * FROM pm_peer_reviews WHERE id=?")
        .get(id) as
        | {
            id: string;
            project_id: string;
            task_id: string;
            prd_version_id: string;
            reviewer_role: PeerReview["reviewerRole"];
            decision: "approved" | "rejected";
          }
        | undefined;
      if (!row) throw new NotFoundError("PM 评审不存在");
      return row;
    });
    const validations = this.repository.listSourceValidations(
      connection,
      prd.projectId,
    );
    const supportedSourceIds = new Set(
      validations
        .filter(
          (validation) =>
            prd.conclusionIds.includes(validation.conclusionId) &&
            prd.sourceIds.includes(validation.sourceId) &&
            validation.result === "supported" &&
            validation.accessible,
        )
        .map((validation) => validation.sourceId),
    );
    const incompleteSources = sources.filter(
      (source) =>
        source.projectId !== prd.projectId ||
        source.taskId !== prd.taskId ||
        !source.accessible ||
        source.status !== "accessed",
    );
    const incompleteConclusions = conclusions.filter(
      (conclusion) => conclusion.status !== "accepted_for_prd",
    );
    const approvedReviewIds = new Set(
      reviews
        .filter((review) => review.decision === "approved")
        .map((review) => review.id),
    );
    const incompleteMetrics = metrics.filter(
      (metric) =>
        metric.projectId !== prd.projectId ||
        metric.taskId !== prd.taskId ||
        metric.status !== "reviewed" ||
        !metric.reviewId ||
        !approvedReviewIds.has(metric.reviewId),
    );
    const incompleteConclusionRefs = conclusions.filter(
      (conclusion) =>
        conclusion.projectId !== prd.projectId ||
        conclusion.taskId !== prd.taskId ||
        conclusion.sourceIds.some(
          (sourceId) => !prd.sourceIds.includes(sourceId),
        ),
    );
    const approvedReview = reviews.some(
      (review) => review.decision === "approved",
    );
    const invalidReviews = reviews.filter(
      (review) =>
        review.project_id !== prd.projectId ||
        review.task_id !== prd.taskId ||
        review.prd_version_id !== prd.prdVersionId ||
        samePmRole(prd.createdBy, review.reviewer_role),
    );
    if (
      sources.length === 0 ||
      incompleteSources.length > 0 ||
      incompleteConclusions.length > 0 ||
      incompleteConclusionRefs.length > 0 ||
      incompleteMetrics.length > 0 ||
      prd.sourceIds.some((sourceId) => !supportedSourceIds.has(sourceId)) ||
      !approvedReview ||
      reviews.length === 0 ||
      invalidReviews.length > 0
    )
      throw new EvidenceIncompleteError(
        "PRD 缺少已接受方向结论、已评审成功指标或通过的 PM 交叉评审",
        {
          data: {
            incompleteSourceIds: incompleteSources.map((item) => item.sourceId),
            incompleteConclusionIds: incompleteConclusions.map(
              (item) => item.conclusionId,
            ),
            incompleteConclusionRefs: incompleteConclusionRefs.map(
              (item) => item.conclusionId,
            ),
            incompleteMetricIds: incompleteMetrics.map((item) => item.metricId),
            unverifiedSourceIds: prd.sourceIds.filter(
              (sourceId) => !supportedSourceIds.has(sourceId),
            ),
            approvedPeerReview: approvedReview,
            invalidPeerReviewIds: invalidReviews.map((item) => item.id),
          },
        },
      );
  }

  private appendRuntimeEvent(
    connection: BetterSqlite3.Database,
    eventType: string,
    traceId: string,
    metadata: Record<string, unknown>,
  ): void {
    connection
      .prepare(
        "INSERT INTO runtime_events (event_type,trace_id,payload,occurred_at) VALUES (?,?,?,?)",
      )
      .run(eventType, traceId, redactJson(metadata), utcNow());
  }

  /** 用现有 TraceRepository 建立调研对象的双向追踪链。 */
  private linkTrace(
    connection: BetterSqlite3.Database,
    projectId: string,
    sourceType: string,
    sourceId: string,
    targetType: string,
    targetId: string,
    relation: string,
    traceId: string,
  ): void {
    this.traces.create(connection, {
      id: newObjectId("trace_link"),
      projectId,
      sourceType,
      sourceId,
      targetType,
      targetId,
      relation,
      traceId,
      createdAt: utcNow(),
      version: 1,
    });
  }
}

function requireText(value: unknown, field: string, traceId: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new InvalidArgumentError(`${field} 必须是非空字符串`, { traceId });
  return value;
}

function requireStringArray(
  value: unknown,
  field: string,
  traceId: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new InvalidArgumentError(`${field} 必须是非空字符串数组`, {
      traceId,
    });
  return value as string[];
}

function requireRecordArray(
  value: unknown,
  field: string,
  traceId: string,
): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  )
    throw new InvalidArgumentError(`${field} 必须是对象数组`, { traceId });
  return value as Record<string, unknown>[];
}

function requireBoolean(
  value: unknown,
  field: string,
  traceId: string,
): boolean {
  if (typeof value !== "boolean")
    throw new InvalidArgumentError(`${field} 必须是布尔值`, { traceId });
  return value;
}

function requireConclusionType(
  value: unknown,
  traceId: string,
): ResearchConclusion["conclusionType"] {
  if (
    value === "official_feature" ||
    value === "market_or_competitive" ||
    value === "user_or_trend" ||
    value === "effectiveness" ||
    value === "other"
  )
    return value;
  throw new InvalidArgumentError("conclusionType 不在允许集合中", { traceId });
}

function requireResearchRole(
  value: unknown,
  traceId: string,
): ResearchGrant["role"] {
  if (
    value === "product_market_pm" ||
    value === "product_solution_pm" ||
    value === "user_market_pm"
  )
    return value;
  throw new InvalidArgumentError("createdBy 必须是 PM 角色", { traceId });
}

function requireReviewerRole(
  value: unknown,
  traceId: string,
): PeerReview["reviewerRole"] {
  if (
    value === "product_market_pm" ||
    value === "product_solution_pm" ||
    value === "user_market_pm"
  )
    return value;
  throw new InvalidArgumentError("reviewerRole 必须是 PM 角色", { traceId });
}

/** 兼容 user_market_pm 旧别名，确保别名不能伪装成第二位 PM。 */
function samePmRole(
  left: PrdVersion["createdBy"],
  right: PeerReview["reviewerRole"],
): boolean {
  const canonical = (role: string): string =>
    role === "user_market_pm" ? "product_market_pm" : role;
  return canonical(left) === canonical(right);
}
