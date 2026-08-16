import type BetterSqlite3 from "better-sqlite3";
import { newObjectId, utcNow } from "../domain/common.js";
import { NotFoundError, PolicyDeniedError } from "../domain/errors.js";
import type { Database } from "../infra/database.js";

/** Task 10 评分卡规则版本；旧快照不因规则升级而被覆盖。 */
export const SCORECARD_RULE_VERSION = "score-rule-v1" as const;

/** 评分维度；每一维只消费上游事实表并返回证据索引。 */
export type ScorecardDimension = {
  dimensionId: string;
  label: string;
  score: number | null;
  status: "PASS" | "NEEDS_REMEDIATION" | "DATA_INSUFFICIENT";
  ruleVersion: string;
  evidenceIds: string[];
  issues: string[];
  missingData: string[];
  calculatedAt: string;
};

/** 硬性门槛单独返回，防止总分掩盖安全、追踪和恢复失败。 */
export type HardGate = {
  gateId: string;
  label: string;
  status: "PASS" | "FAIL" | "DATA_INSUFFICIENT";
  evidenceIds: string[];
  reason: string | null;
  remediation: string | null;
};

/** 可持久化评分卡快照；sourceDataVersion 指向计算时的事实版本。 */
export type ScorecardSnapshot = {
  snapshotId: string | null;
  projectId: string;
  scorecardVersion: number;
  ruleVersion: string;
  calculatedAt: string;
  overallScore: number | null;
  releaseStatus: "PASS" | "BLOCKED" | "NEEDS_REMEDIATION" | "DATA_INSUFFICIENT";
  dimensions: ScorecardDimension[];
  hardGates: HardGate[];
  recommendations: string[];
  sourceDataVersion: string;
};

const DIMENSION_DEFINITIONS = [
  ["requirement-coverage", "需求覆盖度"],
  ["research-quality", "调研质量和来源独立性"],
  ["design-implementation", "设计与实现一致性"],
  ["test-validation", "测试通过率和验证充分性"],
  ["review-quality", "Review 质量和缺陷闭环"],
  ["cost-efficiency", "执行成本与资源效率"],
  ["traceability-security-archive", "可追溯性、安全性和归档完整度"],
] as const;

/** 从真实结构化证据计算评分卡，并保存可回看的版本快照。 */
export class ScorecardService {
  /** 绑定评分卡使用的业务数据库。 */
  constructor(private readonly database: Database) {}

  /** 读取最新评分卡；没有快照时返回数据不足的实时结果，不隐式写入历史。 */
  get(projectId: string): ScorecardSnapshot {
    this.assertProject(projectId);
    const row = this.database.connection
      .prepare(
        "SELECT * FROM scorecard_snapshots WHERE project_id=? ORDER BY version_number DESC LIMIT 1",
      )
      .get(projectId) as SnapshotRow | undefined;
    return row ? snapshotFromRow(row) : this.calculate(projectId, null);
  }

  /** 重新计算并追加一条不可变评分卡快照；只允许 Boss 或系统评估角色触发。 */
  recalculate(projectId: string, actor: { type: string; id: string }): ScorecardSnapshot {
    if (actor.type !== "boss" && actor.type !== "system") {
      throw new PolicyDeniedError("只有项目负责人或系统评估角色可以重新计算评分卡");
    }
    this.assertProject(projectId);
    return this.database.transaction((connection) => {
      const previous = connection
        .prepare(
          "SELECT COALESCE(MAX(version_number),0) AS version FROM scorecard_snapshots WHERE project_id=?",
        )
        .get(projectId) as { version: number };
      const snapshot = this.calculate(projectId, previous.version + 1);
      connection
        .prepare(
          `INSERT INTO scorecard_snapshots
           (id,project_id,version_number,rule_version,calculated_at,overall_score,
            release_status,dimensions_json,hard_gates_json,recommendations_json,source_data_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          newObjectId("scorecard"),
          projectId,
          snapshot.scorecardVersion,
          snapshot.ruleVersion,
          snapshot.calculatedAt,
          // 修改日期：2026-08-17
          // 修改原因：DATA_INSUFFICIENT 必须在持久化层保持 NULL，
          // 不能让前端把未知结果误读成 0 分。
          snapshot.overallScore,
          snapshot.releaseStatus,
          JSON.stringify(snapshot.dimensions),
          JSON.stringify(snapshot.hardGates),
          JSON.stringify(snapshot.recommendations),
          snapshot.sourceDataVersion,
        );
      const saved = connection
        .prepare(
          "SELECT * FROM scorecard_snapshots WHERE project_id=? AND version_number=?",
        )
        .get(projectId, snapshot.scorecardVersion) as SnapshotRow;
      return snapshotFromRow(saved);
    });
  }

  /** 返回评分卡所有证据 ID，供前端下钻而不暴露未经授权的正文。 */
  listEvidence(projectId: string): Record<string, unknown> {
    const snapshot = this.get(projectId);
    return {
      projectId,
      scorecardVersion: snapshot.scorecardVersion,
      calculatedAt: snapshot.calculatedAt,
      dimensions: snapshot.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        evidenceIds: dimension.evidenceIds,
        issues: dimension.issues,
        missingData: dimension.missingData,
      })),
      hardGates: snapshot.hardGates.map((gate) => ({
        gateId: gate.gateId,
        status: gate.status,
        evidenceIds: gate.evidenceIds,
        reason: gate.reason,
      })),
    };
  }

  /** 返回项目的评分卡历史版本，旧版本只读且不覆盖。 */
  listHistory(projectId: string, limit = 50): ScorecardSnapshot[] {
    this.assertProject(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("scorecard history limit must be between 1 and 100");
    }
    const rows = this.database.connection
      .prepare(
        "SELECT * FROM scorecard_snapshots WHERE project_id=? ORDER BY version_number DESC LIMIT ?",
      )
      .all(projectId, limit) as SnapshotRow[];
    return rows.map(snapshotFromRow);
  }

  private calculate(projectId: string, version: number | null): ScorecardSnapshot {
    const calculatedAt = utcNow();
    const facts = collectFacts(this.database.connection, projectId);
    const dimensions = DIMENSION_DEFINITIONS.map(([dimensionId, label]) =>
      evaluateDimension(dimensionId, label, facts, calculatedAt),
    );
    const hardGates = evaluateHardGates(facts);
    const scores = dimensions
      .map((dimension) => dimension.score)
      .filter((score): score is number => score !== null);
    const overallScore = scores.length
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : null;
    const hasInsufficientData =
      dimensions.some((dimension) => dimension.status === "DATA_INSUFFICIENT") ||
      hardGates.some((gate) => gate.status === "DATA_INSUFFICIENT");
    const hasFailedGate = hardGates.some((gate) => gate.status === "FAIL");
    const releaseStatus = hasFailedGate
      ? "BLOCKED"
      : hasInsufficientData
        ? "DATA_INSUFFICIENT"
        : dimensions.some((dimension) => dimension.status === "NEEDS_REMEDIATION")
          ? "NEEDS_REMEDIATION"
          : "PASS";
    return {
      snapshotId: null,
      projectId,
      scorecardVersion: version ?? 0,
      ruleVersion: SCORECARD_RULE_VERSION,
      calculatedAt,
      overallScore,
      releaseStatus,
      dimensions,
      hardGates,
      recommendations: recommendations(dimensions, hardGates),
      sourceDataVersion: `events-${facts.latestEventSequence}`,
    };
  }

  private assertProject(projectId: string): void {
    const found = this.database.connection
      .prepare("SELECT 1 FROM projects WHERE id=?")
      .get(projectId);
    if (!found) throw new NotFoundError("项目不存在");
  }
}

type Facts = {
  taskCount: number;
  taskQualityCount: number;
  testCaseCount: number;
  testRunCount: number;
  passedTestRunCount: number;
  evidenceTestRunCount: number;
  researchSourceCount: number;
  independentSourceCount: number;
  researchConclusionCount: number;
  artifactCount: number;
  designArtifactCount: number;
  patchArtifactCount: number;
  traceLinkCount: number;
  eventCount: number;
  latestEventSequence: number;
  reviewCount: number;
  approvedReviewCount: number;
  openDefectCount: number;
  modelCallCount: number;
  failedModelCallCount: number;
  redactionFailureCount: number;
  policyDecisionCount: number;
  deniedPolicyCount: number;
  restoreEvidenceCount: number;
};

type SnapshotRow = {
  id: string;
  project_id: string;
  version_number: number;
  rule_version: string;
  calculated_at: string;
  overall_score: number | null;
  release_status: ScorecardSnapshot["releaseStatus"];
  dimensions_json: string;
  hard_gates_json: string;
  recommendations_json: string;
  source_data_version: string;
};

function collectFacts(connection: BetterSqlite3.Database, projectId: string): Facts {
  /** 执行项目范围的单值计数查询。 */
  const count = (sql: string): number => {
    return (connection.prepare(sql).get(projectId) as { count: number }).count;
  };
  /** 执行总数和满足条件数的成对统计查询。 */
  const pair = (sql: string): { total: number; value: number } => {
    return connection.prepare(sql).get(projectId) as {
      total: number;
      value: number;
    };
  };
  const testRuns = pair(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status IN ('passed','PASS','通过')),0) AS value
     FROM test_runs WHERE project_id=?`,
  );
  const sources = pair(
    `SELECT COUNT(*) AS total,COALESCE(SUM(independent=1),0) AS value
     FROM research_sources WHERE project_id=?`,
  );
  const modelCalls = pair(
    `SELECT COUNT(*) AS total,COALESCE(SUM(final_status='failed'),0) AS value
     FROM model_calls WHERE project_id=?`,
  );
  const policy = pair(
    `SELECT COUNT(*) AS total,COALESCE(SUM(decision IN ('denied','blocked','rejected')),0) AS value
     FROM policy_decisions WHERE project_id=?`,
  );
  const latest = connection
    .prepare(
      "SELECT COALESCE(MAX(global_sequence),0) AS sequence FROM domain_events WHERE project_id=?",
    )
    .get(projectId) as { sequence: number };
  const reviewCount = (
    connection
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM reviews WHERE project_id=?) +
           (SELECT COUNT(*) FROM quality_reviews WHERE project_id=?) AS count`,
      )
      .get(projectId, projectId) as { count: number }
  ).count;
  return {
    taskCount: count("SELECT COUNT(*) AS count FROM tasks WHERE project_id=?"),
    taskQualityCount: count("SELECT COUNT(*) AS count FROM task_quality_specs WHERE project_id=?"),
    testCaseCount: count("SELECT COUNT(*) AS count FROM test_cases WHERE project_id=?"),
    testRunCount: testRuns.total,
    passedTestRunCount: testRuns.value,
    evidenceTestRunCount: count(
      `SELECT COUNT(*) AS count
       FROM test_runs
       WHERE project_id=?
         AND (evidence_version_id IS NOT NULL OR evidence_refs_json != '[]')`,
    ),
    researchSourceCount: sources.total,
    independentSourceCount: sources.value,
    researchConclusionCount: count("SELECT COUNT(*) AS count FROM research_conclusions WHERE project_id=?"),
    artifactCount: count("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=?"),
    designArtifactCount: count(
      `SELECT COUNT(*) AS count
       FROM artifacts
       WHERE project_id=? AND lower(artifact_type) IN ('design','prd','report')`,
    ),
    patchArtifactCount: count(
      `SELECT COUNT(*) AS count
       FROM artifacts
       WHERE project_id=? AND lower(artifact_type) IN ('patch','diff','code_change')`,
    ),
    traceLinkCount: count("SELECT COUNT(*) AS count FROM trace_links WHERE project_id=?"),
    eventCount: count("SELECT COUNT(*) AS count FROM domain_events WHERE project_id=?"),
    latestEventSequence: latest.sequence,
    reviewCount,
    approvedReviewCount: (
      connection
        .prepare(
          `SELECT COUNT(*) AS count FROM reviews WHERE project_id=? AND decision IN ('approved','通过')
           UNION ALL
           SELECT COUNT(*) AS count
           FROM quality_reviews
           WHERE project_id=? AND decision IN ('approved','通过')`,
        )
        .all(projectId, projectId) as Array<{ count: number }>
    ).reduce((sum, row) => sum + row.count, 0),
    openDefectCount: count(
      `SELECT COUNT(*) AS count
       FROM defects
       WHERE project_id=? AND status NOT IN ('closed','resolved','已关闭','已解决')`,
    ),
    modelCallCount: modelCalls.total,
    failedModelCallCount: modelCalls.value,
    redactionFailureCount: count(
      "SELECT COUNT(*) AS count FROM model_calls WHERE project_id=? AND redaction_status='failed'",
    ),
    policyDecisionCount: policy.total,
    deniedPolicyCount: policy.value,
    restoreEvidenceCount: count(
      `SELECT COUNT(*) AS count
       FROM artifacts
       WHERE project_id=?
         AND lower(artifact_type) IN ('restore_report','backup_restore_report')`,
    ),
  };
}

/** 依据结构化事实计算一个维度，并保留缺失数据和证据索引。 */
function evaluateDimension(
  dimensionId: string,
  label: string,
  facts: Facts,
  calculatedAt: string,
): ScorecardDimension {
  const evidenceIds: string[] = [];
  const issues: string[] = [];
  const missingData: string[] = [];
  let score: number | null = null;
  if (dimensionId === "requirement-coverage") {
    if (facts.taskCount === 0 || facts.testCaseCount === 0) missingData.push("任务或测试用例");
    else {
      score = Math.round(Math.min(1, facts.taskQualityCount / facts.taskCount) * 100);
      if (facts.taskQualityCount < facts.taskCount) issues.push("仍有任务缺少质量规格或验收关联");
    }
  } else if (dimensionId === "research-quality") {
    if (
      facts.researchSourceCount === 0 ||
      facts.researchConclusionCount === 0
    ) {
      missingData.push("调研来源或结论");
    }
    else {
      score = Math.round((facts.independentSourceCount / facts.researchSourceCount) * 100);
      if (facts.independentSourceCount < facts.researchSourceCount) issues.push("存在未声明独立性的来源");
    }
  } else if (dimensionId === "design-implementation") {
    if (facts.designArtifactCount === 0 || facts.patchArtifactCount === 0) missingData.push("设计或实现产物");
    else score = facts.traceLinkCount > 0 ? 100 : 50;
    if (facts.traceLinkCount === 0) issues.push("设计、实现和测试之间没有 TraceLink");
  } else if (dimensionId === "test-validation") {
    if (facts.testRunCount === 0) missingData.push("真实测试运行");
    else {
      score = Math.round((facts.passedTestRunCount / facts.testRunCount) * 100);
      if (facts.evidenceTestRunCount < facts.testRunCount) issues.push("部分测试运行缺少真实证据引用");
    }
  } else if (dimensionId === "review-quality") {
    if (facts.reviewCount === 0) missingData.push("Review 记录");
    else score = Math.round((facts.approvedReviewCount / facts.reviewCount) * 100);
    if (facts.openDefectCount > 0) issues.push(`存在 ${facts.openDefectCount} 个未关闭缺陷`);
  } else if (dimensionId === "cost-efficiency") {
    if (facts.modelCallCount === 0) missingData.push("模型调用账本");
    else {
      score =
        facts.failedModelCallCount === 0
          ? 100
          : Math.max(
              0,
              100 -
                Math.round(
                  (facts.failedModelCallCount / facts.modelCallCount) * 100,
                ),
            );
      if (facts.failedModelCallCount > 0) issues.push("存在模型调用失败");
    }
  } else {
    if (facts.eventCount === 0 || facts.traceLinkCount === 0) missingData.push("事件或 TraceLink");
    else score = facts.redactionFailureCount === 0 ? 100 : 0;
    if (facts.redactionFailureCount > 0) issues.push("存在脱敏失败的调用记录");
  }
  if (score !== null) evidenceIds.push(`facts:${dimensionId}:${facts.latestEventSequence}`);
  const status = missingData.length
    ? "DATA_INSUFFICIENT"
    : issues.length || score === 0
      ? "NEEDS_REMEDIATION"
      : "PASS";
  return {
    dimensionId,
    label,
    score,
    status,
    ruleVersion: SCORECARD_RULE_VERSION,
    evidenceIds,
    issues,
    missingData,
    calculatedAt,
  };
}

/** 独立计算九条硬门槛，缺证据时返回 DATA_INSUFFICIENT 而非伪造通过。 */
function evaluateHardGates(facts: Facts): HardGate[] {
  const requirementEvidence = facts.taskQualityCount
    ? [`tasks:${facts.taskQualityCount}`]
    : [];
  const researchEvidence = facts.researchSourceCount
    ? [`sources:${facts.researchSourceCount}`]
    : [];
  const testEvidence = facts.evidenceTestRunCount
    ? [`test-runs:${facts.evidenceTestRunCount}`]
    : [];
  const modelEvidence = facts.modelCallCount
    ? [`model-redaction:${facts.redactionFailureCount ? "failed" : "passed"}`]
    : [];
  const executionEvidence =
    facts.eventCount > 0 && facts.artifactCount > 0
      ? [`events:${facts.eventCount}`, `artifacts:${facts.artifactCount}`]
      : [];
  return [
    gate(
      "requirements-covered",
      "关键需求有覆盖证据",
      facts.taskCount > 0 && facts.taskQualityCount >= facts.taskCount,
      requirementEvidence,
      "补齐任务质量规格和验收关联",
    ),
    gate(
      "research-independent",
      "关键来源满足独立性规则",
      facts.researchSourceCount > 0 && facts.independentSourceCount >= 2,
      researchEvidence,
      "补齐至少两个独立调研来源",
    ),
    gate(
      "trace-links-complete",
      "设计、实现和测试存在 TraceLink",
      facts.traceLinkCount > 0,
      facts.traceLinkCount ? [`trace-links:${facts.traceLinkCount}`] : [],
      "建立并校验对象之间的 TraceLink",
    ),
    gate(
      "no-blocking-defects",
      "不存在未关闭阻塞性缺陷",
      facts.openDefectCount === 0 && facts.testRunCount > 0,
      facts.openDefectCount ? [`open-defects:${facts.openDefectCount}`] : [],
      "关闭阻塞缺陷并保留回归证据",
    ),
    gate(
      "tests-reproducible",
      "关键测试有可复现报告",
      facts.testRunCount > 0 &&
        facts.evidenceTestRunCount === facts.testRunCount &&
        facts.passedTestRunCount === facts.testRunCount,
      testEvidence,
      "补齐真实测试报告并处理失败测试",
    ),
    gate(
      "no-secret-leak",
      "没有敏感信息泄露",
      facts.modelCallCount > 0 && facts.redactionFailureCount === 0,
      modelEvidence,
      "执行敏感信息扫描并修复脱敏失败",
    ),
    gate(
      "coding-authorized",
      "Coding Agent 未越权执行",
      facts.policyDecisionCount > 0 && facts.deniedPolicyCount === 0,
      facts.policyDecisionCount ? [`policy-decisions:${facts.policyDecisionCount}`] : [],
      "补齐执行授权审计并关闭越权拒绝",
    ),
    gate(
      "execution-traceable",
      "关键执行记录和产物可追溯",
      facts.eventCount > 0 && facts.artifactCount > 0,
      executionEvidence,
      "补齐事件、执行记录和产物关联",
    ),
    gate(
      "backup-restore-verified",
      "备份和恢复校验通过",
      facts.restoreEvidenceCount > 0,
      facts.restoreEvidenceCount
        ? [`restore-reports:${facts.restoreEvidenceCount}`]
        : [],
      "完成一次恢复演练并保存恢复报告",
    ),
  ];
}

/** 将通过事实、失败证据和缺失证据统一转换为硬门槛状态。 */
function gate(
  gateId: string,
  label: string,
  passed: boolean,
  evidenceIds: string[],
  remediation: string,
): HardGate {
  const hasEvidence = evidenceIds.length > 0;
  return {
    gateId,
    label,
    status: passed ? "PASS" : hasEvidence ? "FAIL" : "DATA_INSUFFICIENT",
    evidenceIds,
    reason: passed ? null : hasEvidence ? "硬性门槛未满足" : "缺少判定所需结构化证据",
    remediation: passed ? null : remediation,
  };
}

/** 合并维度问题和门槛整改建议，并保持推荐项稳定去重。 */
function recommendations(
  dimensions: ScorecardDimension[],
  gates: HardGate[],
): string[] {
  const suggestions = dimensions
    .flatMap((dimension) => [...dimension.issues, ...dimension.missingData.map((item) => `${item}数据不足`)]);
  return [
    ...gates
      .filter((gate) => gate.status !== "PASS" && gate.remediation)
      .map((gate) => gate.remediation as string),
    ...suggestions,
  ].filter((item, index, all) => all.indexOf(item) === index);
}

/** 将持久化 JSON 快照恢复为评分卡 API 对象。 */
function snapshotFromRow(row: SnapshotRow): ScorecardSnapshot {
  return {
    snapshotId: row.id,
    projectId: row.project_id,
    scorecardVersion: row.version_number,
    ruleVersion: row.rule_version,
    calculatedAt: row.calculated_at,
    overallScore: row.overall_score,
    releaseStatus: row.release_status,
    dimensions: parseArray(row.dimensions_json) as ScorecardDimension[],
    hardGates: parseArray(row.hard_gates_json) as HardGate[],
    recommendations: parseArray(row.recommendations_json) as string[],
    sourceDataVersion: row.source_data_version,
  };
}

/** 安全解析评分卡数组字段，坏快照不把原始 JSON 直接返回前端。 */
function parseArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}
