import BetterSqlite3 from "better-sqlite3";
import { Defect, Task, TestCase, TestRun } from "../../domain/entities.js";
import {
  IdempotencyKeyReusedError,
  NotFoundError,
  VersionConflictError,
} from "../../domain/errors.js";
import {
  ensureProject,
  ensureProjectWritable,
  jsonText,
  jsonValue,
} from "./common.js";

/** Task 8 任务规格；它把任务版本、验收关联和执行边界冻结为可审计输入。 */
export type TaskQualitySpecRecord = {
  id: string;
  projectId: string;
  taskId: string;
  taskVersion: number;
  goal: string;
  acceptanceCriteriaRefs: string[];
  expectedArtifactTypes: string[];
  workspacePolicy: string;
  verificationProfile: string;
  stackProfile: string;
  baselineCommit: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  conversionNote: string;
  createdBy: string;
  createdAt: string;
};

/** 测试策略及其覆盖范围；用例必须引用策略而不是绕过策略直接创建。 */
export type TestStrategyRecord = {
  id: string;
  projectId: string;
  title: string;
  scope: string;
  acceptanceCriteriaRefs: string[];
  testTypes: string[];
  environment: Record<string, unknown>;
  ownerRole: string;
  status: "draft" | "ready";
  createdAt: string;
  version: number;
};

/** 质量 Review 事实；approved 版本是测试基线的唯一来源。 */
export type QualityReviewRecord = {
  id: string;
  projectId: string;
  taskId: string;
  sessionId: string | null;
  handoffId: string | null;
  artifactVersionId: string | null;
  decision: "approved" | "changes_requested" | "blocked";
  comments: string;
  reviewerRole: string;
  reviewerId: string;
  evidenceVersion: number | null;
  taskVersion: number;
  reworkTaskId: string | null;
  createdAt: string;
  decidedAt: string;
  traceId: string;
  idempotencyKey: string;
};

/** NPI 分析事实；它记录复现、根因和建议，但不改变回归结果。 */
export type NpiAnalysisRecord = {
  id: string;
  projectId: string;
  defectId: string;
  reproduction: string;
  rootCause: string;
  impact: string;
  recommendedFix: string;
  ownerRole: string;
  createdAt: string;
  traceId: string;
  idempotencyKey: string;
};

/** NPI 修复交接事实；提交后缺陷只能等待测试回归。 */
export type FixRequestRecord = {
  id: string;
  projectId: string;
  defectId: string;
  fixDescription: string;
  fixedVersionId: string | null;
  fixArtifactRef: string | null;
  submittedBy: string;
  status: "submitted" | "awaiting_regression";
  createdAt: string;
  traceId: string;
  idempotencyKey: string;
};

/** 回归请求事实；请求与真实回归结果分开保存，防止 NPI 自行宣称通过。 */
export type RegressionRequestRecord = {
  id: string;
  projectId: string;
  defectId: string;
  fixRequestId: string;
  testCaseId: string | null;
  scope: string;
  requestedBy: string;
  status: "pending" | "running" | "passed" | "failed" | "blocked";
  createdAt: string;
  traceId: string;
  idempotencyKey: string;
};

/** 回归执行事实；只有测试角色产生的 passed 记录可以关闭缺陷。 */
export type RegressionResultRecord = {
  id: string;
  projectId: string;
  defectId: string;
  regressionRequestId: string;
  testRunId: string;
  status: "passed" | "failed" | "blocked";
  evidenceRefs: string[];
  actualResult: string;
  executedByRole: string;
  createdAt: string;
  traceId: string;
  idempotencyKey: string;
};

/** 质量闭环 SQLite 仓储；跨对象写入由上层事务包裹，避免部分成功。 */
export class QualityRepository {
  /** 保存任务版本的质量规格和执行边界。 */
  createTaskQualitySpec(
    connection: BetterSqlite3.Database,
    spec: TaskQualitySpecRecord,
  ): void {
    ensureProjectWritable(connection, spec.projectId);
    this.ensureTask(connection, spec.projectId, spec.taskId);
    connection
      .prepare(
        "INSERT INTO task_quality_specs (id,project_id,task_id,task_version,goal,acceptance_criteria_json,expected_artifact_types_json,workspace_policy,verification_profile,stack_profile,baseline_commit,allowed_paths_json,forbidden_paths_json,conversion_note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        spec.id,
        spec.projectId,
        spec.taskId,
        spec.taskVersion,
        spec.goal,
        jsonText(spec.acceptanceCriteriaRefs),
        jsonText(spec.expectedArtifactTypes),
        spec.workspacePolicy,
        spec.verificationProfile,
        spec.stackProfile,
        spec.baselineCommit,
        jsonText(spec.allowedPaths),
        jsonText(spec.forbiddenPaths),
        spec.conversionNote,
        spec.createdBy,
        spec.createdAt,
      );
  }

  /** 读取当前任务版本的质量规格。 */
  getTaskQualitySpec(
    connection: BetterSqlite3.Database,
    projectId: string,
    taskId: string,
    taskVersion?: number,
  ): TaskQualitySpecRecord | null {
    const row = taskVersion == null
      ? connection
          .prepare(
            "SELECT * FROM task_quality_specs WHERE project_id=? AND task_id=? ORDER BY task_version DESC LIMIT 1",
          )
          .get(projectId, taskId)
      : connection
          .prepare(
            "SELECT * FROM task_quality_specs WHERE project_id=? AND task_id=? AND task_version=?",
          )
          .get(projectId, taskId, taskVersion);
    return row ? taskQualitySpecFromRow(row as TaskQualitySpecRow) : null;
  }

  /** 列出项目全部任务规格，供验收标准覆盖率计算。 */
  listTaskQualitySpecs(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): TaskQualitySpecRecord[] {
    return (
      connection
        .prepare(
          "SELECT * FROM task_quality_specs WHERE project_id=? ORDER BY task_id,task_version",
        )
        .all(projectId) as TaskQualitySpecRow[]
    ).map(taskQualitySpecFromRow);
  }

  /** 保存测试策略；同一幂等请求由应用服务先查重。 */
  createTestStrategy(
    connection: BetterSqlite3.Database,
    strategy: TestStrategyRecord,
  ): void {
    ensureProjectWritable(connection, strategy.projectId);
    connection
      .prepare(
        "INSERT INTO test_strategies (id,project_id,title,scope,acceptance_criteria_json,test_types_json,environment_json,owner_role,status,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        strategy.id,
        strategy.projectId,
        strategy.title,
        strategy.scope,
        jsonText(strategy.acceptanceCriteriaRefs),
        jsonText(strategy.testTypes),
        jsonText(strategy.environment),
        strategy.ownerRole,
        strategy.status,
        strategy.createdAt,
        strategy.version,
      );
  }

  /** 读取项目范围内的测试策略。 */
  getTestStrategy(
    connection: BetterSqlite3.Database,
    projectId: string,
    strategyId: string,
  ): TestStrategyRecord {
    const row = connection
      .prepare("SELECT * FROM test_strategies WHERE project_id=? AND id=?")
      .get(projectId, strategyId) as TestStrategyRow | undefined;
    if (!row) throw new NotFoundError("测试策略不存在");
    return testStrategyFromRow(row);
  }

  /** 列出项目测试策略，报告使用稳定创建顺序。 */
  listTestStrategies(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): TestStrategyRecord[] {
    return (
      connection
        .prepare("SELECT * FROM test_strategies WHERE project_id=? ORDER BY created_at,id")
        .all(projectId) as TestStrategyRow[]
    ).map(testStrategyFromRow);
  }

  /** 保存质量 Review 和已选择的 Handoff 基线。 */
  createQualityReview(
    connection: BetterSqlite3.Database,
    review: QualityReviewRecord,
  ): void {
    ensureProjectWritable(connection, review.projectId);
    this.ensureTask(connection, review.projectId, review.taskId);
    connection
      .prepare(
        "INSERT INTO quality_reviews (id,project_id,task_id,session_id,handoff_id,artifact_version_id,decision,comments,reviewer_role,reviewer_id,evidence_version,task_version,rework_task_id,created_at,decided_at,trace_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        review.id,
        review.projectId,
        review.taskId,
        review.sessionId,
        review.handoffId,
        review.artifactVersionId,
        review.decision,
        review.comments,
        review.reviewerRole,
        review.reviewerId,
        review.evidenceVersion,
        review.taskVersion,
        review.reworkTaskId,
        review.createdAt,
        review.decidedAt,
        review.traceId,
        review.idempotencyKey,
      );
  }

  /** 读取质量 Review。 */
  getQualityReview(
    connection: BetterSqlite3.Database,
    projectId: string,
    reviewId: string,
  ): QualityReviewRecord {
    const row = connection
      .prepare("SELECT * FROM quality_reviews WHERE project_id=? AND id=?")
      .get(projectId, reviewId) as QualityReviewRow | undefined;
    if (!row) throw new NotFoundError("质量 Review 不存在");
    return qualityReviewFromRow(row);
  }

  /** 返回任务最新已批准 Review，作为测试基线门禁。 */
  getApprovedReviewForTask(
    connection: BetterSqlite3.Database,
    projectId: string,
    taskId: string,
  ): QualityReviewRecord | null {
    const row = connection
      .prepare(
        "SELECT * FROM quality_reviews WHERE project_id=? AND task_id=? AND decision='approved' ORDER BY task_version DESC,decided_at DESC,id DESC LIMIT 1",
      )
      .get(projectId, taskId) as QualityReviewRow | undefined;
    return row ? qualityReviewFromRow(row) : null;
  }

  /** 按幂等键读取质量对象，确保重复请求不重复创建副作用。 */
  getIdempotency(
    connection: BetterSqlite3.Database,
    key: string,
  ): { operation: string; requestHash: string; response: Record<string, unknown> } | null {
    const row = connection
      .prepare("SELECT operation,request_hash,response_json FROM quality_idempotency WHERE idempotency_key=?")
      .get(key) as QualityIdempotencyRow | undefined;
    if (!row) return null;
    return {
      operation: row.operation,
      requestHash: row.request_hash,
      response: jsonValue<Record<string, unknown>>(row.response_json),
    };
  }

  /** 保存质量命令幂等结果；同键不同请求由调用方拒绝。 */
  saveIdempotency(
    connection: BetterSqlite3.Database,
    input: {
      id: string;
      projectId: string;
      operation: string;
      idempotencyKey: string;
      requestHash: string;
      response: Record<string, unknown>;
      createdAt: string;
    },
  ): void {
    ensureProject(connection, input.projectId);
    connection
      .prepare(
        "INSERT INTO quality_idempotency (id,project_id,operation,idempotency_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.projectId,
        input.operation,
        input.idempotencyKey,
        input.requestHash,
        jsonText(input.response),
        input.createdAt,
      );
  }

  /** 保存 NPI 分析。 */
  createNpiAnalysis(
    connection: BetterSqlite3.Database,
    analysis: NpiAnalysisRecord,
  ): void {
    ensureProjectWritable(connection, analysis.projectId);
    this.ensureDefect(connection, analysis.projectId, analysis.defectId);
    connection
      .prepare(
        "INSERT INTO npi_analyses (id,project_id,defect_id,reproduction,root_cause,impact,recommended_fix,owner_role,created_at,trace_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        analysis.id,
        analysis.projectId,
        analysis.defectId,
        analysis.reproduction,
        analysis.rootCause,
        analysis.impact,
        analysis.recommendedFix,
        analysis.ownerRole,
        analysis.createdAt,
        analysis.traceId,
        analysis.idempotencyKey,
      );
  }

  /** 保存 NPI 修复请求。 */
  createFixRequest(
    connection: BetterSqlite3.Database,
    request: FixRequestRecord,
  ): void {
    ensureProjectWritable(connection, request.projectId);
    this.ensureDefect(connection, request.projectId, request.defectId);
    if (request.fixedVersionId)
      this.ensureArtifactVersion(
        connection,
        request.projectId,
        request.fixedVersionId,
      );
    connection
      .prepare(
        "INSERT INTO defect_fix_requests (id,project_id,defect_id,fix_description,fixed_version_id,fix_artifact_ref,submitted_by,status,created_at,trace_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        request.id,
        request.projectId,
        request.defectId,
        request.fixDescription,
        request.fixedVersionId,
        request.fixArtifactRef,
        request.submittedBy,
        request.status,
        request.createdAt,
        request.traceId,
        request.idempotencyKey,
      );
  }

  /** 读取修复请求并确认它属于给定项目和缺陷。 */
  getFixRequest(
    connection: BetterSqlite3.Database,
    projectId: string,
    fixRequestId: string,
  ): FixRequestRecord {
    const row = connection
      .prepare("SELECT * FROM defect_fix_requests WHERE project_id=? AND id=?")
      .get(projectId, fixRequestId) as FixRequestRow | undefined;
    if (!row) throw new NotFoundError("修复请求不存在");
    return fixRequestFromRow(row);
  }

  /** 保存回归请求。 */
  createRegressionRequest(
    connection: BetterSqlite3.Database,
    request: RegressionRequestRecord,
  ): void {
    ensureProjectWritable(connection, request.projectId);
    this.ensureDefect(connection, request.projectId, request.defectId);
    this.ensureFixRequest(connection, request.projectId, request.fixRequestId);
    if (request.testCaseId)
      this.ensureTestCase(connection, request.projectId, request.testCaseId);
    connection
      .prepare(
        "INSERT INTO regression_requests (id,project_id,defect_id,fix_request_id,test_case_id,scope,requested_by,status,created_at,trace_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        request.id,
        request.projectId,
        request.defectId,
        request.fixRequestId,
        request.testCaseId,
        request.scope,
        request.requestedBy,
        request.status,
        request.createdAt,
        request.traceId,
        request.idempotencyKey,
      );
  }

  /** 读取回归请求。 */
  getRegressionRequest(
    connection: BetterSqlite3.Database,
    projectId: string,
    requestId: string,
  ): RegressionRequestRecord {
    const row = connection
      .prepare("SELECT * FROM regression_requests WHERE project_id=? AND id=?")
      .get(projectId, requestId) as RegressionRequestRow | undefined;
    if (!row) throw new NotFoundError("回归请求不存在");
    return regressionRequestFromRow(row);
  }

  /** 保存测试角色提交的回归结果。 */
  createRegressionResult(
    connection: BetterSqlite3.Database,
    result: RegressionResultRecord,
  ): void {
    ensureProjectWritable(connection, result.projectId);
    this.ensureDefect(connection, result.projectId, result.defectId);
    this.ensureRegressionRequest(
      connection,
      result.projectId,
      result.regressionRequestId,
    );
    connection
      .prepare(
        "INSERT INTO regression_results (id,project_id,defect_id,regression_request_id,test_run_id,status,evidence_refs_json,actual_result,executed_by_role,created_at,trace_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        result.id,
        result.projectId,
        result.defectId,
        result.regressionRequestId,
        result.testRunId,
        result.status,
        jsonText(result.evidenceRefs),
        result.actualResult,
        result.executedByRole,
        result.createdAt,
        result.traceId,
        result.idempotencyKey,
      );
  }

  /** 以 expectedVersion 更新缺陷状态，防止并发 NPI/回归覆盖彼此结果。 */
  updateDefect(
    connection: BetterSqlite3.Database,
    input: {
      projectId: string;
      defectId: string;
      expectedVersion: number;
      status: string;
      fixedVersionId?: string | null;
      regressionTestRunId?: string | null;
      resolvedAt?: string | null;
    },
  ): Defect {
    ensureProjectWritable(connection, input.projectId);
    const result = connection
      .prepare(
        "UPDATE defects SET status=?,fixed_version_id=COALESCE(?,fixed_version_id),regression_test_run_id=COALESCE(?,regression_test_run_id),resolved_at=COALESCE(?,resolved_at),version=version+1 WHERE project_id=? AND id=? AND version=?",
      )
      .run(
        input.status,
        input.fixedVersionId ?? null,
        input.regressionTestRunId ?? null,
        input.resolvedAt ?? null,
        input.projectId,
        input.defectId,
        input.expectedVersion,
      );
    if (result.changes !== 1) {
      const current = connection
        .prepare("SELECT version FROM defects WHERE project_id=? AND id=?")
        .get(input.projectId, input.defectId) as { version: number } | undefined;
      throw new VersionConflictError("缺陷版本已变化，未覆盖最新 NPI 事实", {
        data: {
          defectId: input.defectId,
          expectedVersion: input.expectedVersion,
          actualVersion: current?.version ?? 0,
        },
      });
    }
    const row = connection
      .prepare("SELECT * FROM defects WHERE project_id=? AND id=?")
      .get(input.projectId, input.defectId) as DefectRow | undefined;
    if (!row) throw new NotFoundError("缺陷不存在");
    return defectFromRow(row);
  }

  /** 列出测试策略关联用例，供覆盖率和测试报告使用。 */
  listTestCasesForStrategy(
    connection: BetterSqlite3.Database,
    projectId: string,
    strategyId: string,
  ): TestCase[] {
    return (
      connection
        .prepare("SELECT * FROM test_cases WHERE project_id=? AND strategy_id=? ORDER BY id")
        .all(projectId, strategyId) as TestCaseRow[]
    ).map(testCaseFromRow);
  }

  /** 列出项目测试运行，报告只读查询不改变执行事实。 */
  listTestRuns(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): TestRun[] {
    return (
      connection
        .prepare("SELECT * FROM test_runs WHERE project_id=? ORDER BY started_at,id")
        .all(projectId) as TestRunRow[]
    ).map(testRunFromRow);
  }

  /** 列出项目缺陷，测试放行和质量报告共用同一查询来源。 */
  listDefects(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): Defect[] {
    return (
      connection
        .prepare("SELECT * FROM defects WHERE project_id=? ORDER BY created_at,id")
        .all(projectId) as DefectRow[]
    ).map(defectFromRow);
  }

  /** 获取项目范围内的原始任务，拒绝跨项目引用。 */
  getTask(
    connection: BetterSqlite3.Database,
    projectId: string,
    taskId: string,
  ): Task {
    const row = connection
      .prepare("SELECT * FROM tasks WHERE project_id=? AND id=?")
      .get(projectId, taskId) as TaskRow | undefined;
    if (!row) throw new NotFoundError("任务不存在或不属于当前项目");
    return taskFromRow(row);
  }

  private ensureTask(
    connection: BetterSqlite3.Database,
    projectId: string,
    taskId: string,
  ): void {
    if (!connection.prepare("SELECT 1 FROM tasks WHERE project_id=? AND id=?").get(projectId, taskId))
      throw new NotFoundError("任务不存在或不属于当前项目");
  }
  private ensureDefect(
    connection: BetterSqlite3.Database,
    projectId: string,
    defectId: string,
  ): void {
    if (!connection.prepare("SELECT 1 FROM defects WHERE project_id=? AND id=?").get(projectId, defectId))
      throw new NotFoundError("缺陷不存在或不属于当前项目");
  }
  private ensureFixRequest(
    connection: BetterSqlite3.Database,
    projectId: string,
    requestId: string,
  ): void {
    if (!connection.prepare("SELECT 1 FROM defect_fix_requests WHERE project_id=? AND id=?").get(projectId, requestId))
      throw new NotFoundError("修复请求不存在或不属于当前项目");
  }
  private ensureRegressionRequest(
    connection: BetterSqlite3.Database,
    projectId: string,
    requestId: string,
  ): void {
    if (!connection.prepare("SELECT 1 FROM regression_requests WHERE project_id=? AND id=?").get(projectId, requestId))
      throw new NotFoundError("回归请求不存在或不属于当前项目");
  }
  private ensureTestCase(
    connection: BetterSqlite3.Database,
    projectId: string,
    testCaseId: string,
  ): void {
    if (!connection.prepare("SELECT 1 FROM test_cases WHERE project_id=? AND id=?").get(projectId, testCaseId))
      throw new NotFoundError("测试用例不存在或不属于当前项目");
  }
  private ensureArtifactVersion(
    connection: BetterSqlite3.Database,
    projectId: string,
    versionId: string,
  ): void {
    if (!connection.prepare("SELECT 1 FROM artifact_versions WHERE project_id=? AND id=?").get(projectId, versionId))
      throw new NotFoundError("修复 ArtifactVersion 不存在或不属于当前项目");
  }
}

type TaskQualitySpecRow = {
  id: string;
  project_id: string;
  task_id: string;
  task_version: number;
  goal: string;
  acceptance_criteria_json: string;
  expected_artifact_types_json: string;
  workspace_policy: string;
  verification_profile: string;
  stack_profile: string;
  baseline_commit: string;
  allowed_paths_json: string;
  forbidden_paths_json: string;
  conversion_note: string;
  created_by: string;
  created_at: string;
};
type TestStrategyRow = {
  id: string;
  project_id: string;
  title: string;
  scope: string;
  acceptance_criteria_json: string;
  test_types_json: string;
  environment_json: string;
  owner_role: string;
  status: "draft" | "ready";
  created_at: string;
  version: number;
};
type QualityReviewRow = {
  id: string;
  project_id: string;
  task_id: string;
  session_id: string | null;
  handoff_id: string | null;
  artifact_version_id: string | null;
  decision: QualityReviewRecord["decision"];
  comments: string;
  reviewer_role: string;
  reviewer_id: string;
  evidence_version: number | null;
  task_version: number;
  rework_task_id: string | null;
  created_at: string;
  decided_at: string;
  trace_id: string;
  idempotency_key: string;
};
type NpiAnalysisRow = {
  id: string;
  project_id: string;
  defect_id: string;
  reproduction: string;
  root_cause: string;
  impact: string;
  recommended_fix: string;
  owner_role: string;
  created_at: string;
  trace_id: string;
  idempotency_key: string;
};
type FixRequestRow = {
  id: string;
  project_id: string;
  defect_id: string;
  fix_description: string;
  fixed_version_id: string | null;
  fix_artifact_ref: string | null;
  submitted_by: string;
  status: FixRequestRecord["status"];
  created_at: string;
  trace_id: string;
  idempotency_key: string;
};
type RegressionRequestRow = {
  id: string;
  project_id: string;
  defect_id: string;
  fix_request_id: string;
  test_case_id: string | null;
  scope: string;
  requested_by: string;
  status: RegressionRequestRecord["status"];
  created_at: string;
  trace_id: string;
  idempotency_key: string;
};
type RegressionResultRow = {
  id: string;
  project_id: string;
  defect_id: string;
  regression_request_id: string;
  test_run_id: string;
  status: RegressionResultRecord["status"];
  evidence_refs_json: string;
  actual_result: string;
  executed_by_role: string;
  created_at: string;
  trace_id: string;
  idempotency_key: string;
};
type QualityIdempotencyRow = {
  operation: string;
  request_hash: string;
  response_json: string;
};
type TestCaseRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  acceptance_criteria_json: string;
  preconditions: string;
  steps: string;
  expected_result: string;
  test_type: string;
  owner_role: string;
  strategy_id: string | null;
  created_at: string;
  version: number;
};
type TestRunRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  test_case_id: string;
  baseline_version_id: string | null;
  baseline_review_id: string | null;
  command_or_steps: string;
  environment_json: string;
  started_at: string;
  ended_at: string | null;
  actual_result: string;
  exit_code: number | null;
  status: string;
  evidence_version_id: string | null;
  evidence_refs_json: string;
  executed_by_role: string | null;
  trace_id: string;
};
type DefectRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  source_test_run_id: string;
  reproduction: string;
  severity: string;
  actual_result: string;
  expected_result: string;
  evidence_version_id: string | null;
  npi_owner_role: string;
  status: string;
  fixed_version_id: string | null;
  regression_test_run_id: string | null;
  created_at: string;
  resolved_at: string | null;
  version: number;
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
  status: Task["status"];
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  version: number;
};

function taskQualitySpecFromRow(row: TaskQualitySpecRow): TaskQualitySpecRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskVersion: row.task_version,
    goal: row.goal,
    acceptanceCriteriaRefs: jsonValue(row.acceptance_criteria_json),
    expectedArtifactTypes: jsonValue(row.expected_artifact_types_json),
    workspacePolicy: row.workspace_policy,
    verificationProfile: row.verification_profile,
    stackProfile: row.stack_profile,
    baselineCommit: row.baseline_commit,
    allowedPaths: jsonValue(row.allowed_paths_json),
    forbiddenPaths: jsonValue(row.forbidden_paths_json),
    conversionNote: row.conversion_note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function testStrategyFromRow(row: TestStrategyRow): TestStrategyRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    scope: row.scope,
    acceptanceCriteriaRefs: jsonValue(row.acceptance_criteria_json),
    testTypes: jsonValue(row.test_types_json),
    environment: jsonValue(row.environment_json),
    ownerRole: row.owner_role,
    status: row.status,
    createdAt: row.created_at,
    version: row.version,
  };
}

function qualityReviewFromRow(row: QualityReviewRow): QualityReviewRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    handoffId: row.handoff_id,
    artifactVersionId: row.artifact_version_id,
    decision: row.decision,
    comments: row.comments,
    reviewerRole: row.reviewer_role,
    reviewerId: row.reviewer_id,
    evidenceVersion: row.evidence_version,
    taskVersion: row.task_version,
    reworkTaskId: row.rework_task_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
  };
}

function fixRequestFromRow(row: FixRequestRow): FixRequestRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    defectId: row.defect_id,
    fixDescription: row.fix_description,
    fixedVersionId: row.fixed_version_id,
    fixArtifactRef: row.fix_artifact_ref,
    submittedBy: row.submitted_by,
    status: row.status,
    createdAt: row.created_at,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
  };
}

function regressionRequestFromRow(
  row: RegressionRequestRow,
): RegressionRequestRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    defectId: row.defect_id,
    fixRequestId: row.fix_request_id,
    testCaseId: row.test_case_id,
    scope: row.scope,
    requestedBy: row.requested_by,
    status: row.status,
    createdAt: row.created_at,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
  };
}

function testCaseFromRow(row: TestCaseRow): TestCase {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    acceptanceCriteria: jsonValue(row.acceptance_criteria_json),
    preconditions: jsonValue(row.preconditions),
    steps: jsonValue(row.steps),
    expectedResult: row.expected_result,
    testType: row.test_type,
    ownerRole: row.owner_role,
    strategyId: row.strategy_id,
    createdAt: row.created_at,
    version: row.version,
  };
}

function testRunFromRow(row: TestRunRow): TestRun {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    testCaseId: row.test_case_id,
    baselineVersionId: row.baseline_version_id,
    baselineReviewId: row.baseline_review_id,
    commandOrSteps: row.command_or_steps,
    environment: jsonValue(row.environment_json),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    actualResult: row.actual_result,
    exitCode: row.exit_code,
    status: row.status,
    evidenceVersionId: row.evidence_version_id,
    evidenceRefs: jsonValue(row.evidence_refs_json),
    executedByRole: row.executed_by_role,
    traceId: row.trace_id,
  };
}

function defectFromRow(row: DefectRow): Defect {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sourceTestRunId: row.source_test_run_id,
    reproduction: row.reproduction,
    severity: row.severity,
    actualResult: row.actual_result,
    expectedResult: row.expected_result,
    evidenceVersionId: row.evidence_version_id,
    npiOwnerRole: row.npi_owner_role,
    status: row.status,
    fixedVersionId: row.fixed_version_id,
    regressionTestRunId: row.regression_test_run_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    version: row.version,
  };
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ownerRole: row.owner_role,
    specialistTag: row.specialist_tag,
    assignmentReason: row.assignment_reason,
    priority: row.priority as Task["priority"],
    dependencies: jsonValue(row.dependencies_json),
    expectedDeliverables: jsonValue(row.expected_deliverables_json),
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    version: row.version,
  };
}
