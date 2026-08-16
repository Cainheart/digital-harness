import BetterSqlite3 from "better-sqlite3";
import {
  ensureProjectChild,
  ensureProjectWritable,
  jsonText,
  jsonValue,
} from "./common.js";
import {
  Artifact,
  ArtifactRef,
  ArtifactVersion,
  Approval,
  Defect,
  Review,
  TestCase,
  TestRun,
  parseArtifactRef,
} from "../../domain/entities.js";
import { NotFoundError } from "../../domain/errors.js";
import {
  ArtifactReference,
  ArtifactVerification,
  FileArtifactStore,
} from "../artifacts.js";

/** Task 2 证据对象仓储，统一维护项目边界和不可覆盖的版本引用。 */
export class EvidenceRepository {
  /** 创建 Artifact 逻辑对象。 */
  createArtifact(connection: BetterSqlite3.Database, artifact: Artifact): void {
    ensureProjectWritable(connection, artifact.projectId);
    if (artifact.taskId)
      ensureProjectChild(
        connection,
        "tasks",
        artifact.projectId,
        artifact.taskId,
      );
    connection
      .prepare(
        "INSERT INTO artifacts (id,project_id,task_id,name,artifact_type,owner_role,status,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        artifact.id,
        artifact.projectId,
        artifact.taskId,
        artifact.name,
        artifact.artifactType,
        artifact.ownerRole,
        artifact.status,
        artifact.createdAt,
        artifact.createdBy,
      );
  }
  /** 读取 Artifact。 */
  getArtifact(
    connection: BetterSqlite3.Database,
    artifactId: string,
  ): Artifact {
    const row = connection
      .prepare("SELECT * FROM artifacts WHERE id=?")
      .get(artifactId) as ArtifactRow | undefined;
    if (!row) throw new NotFoundError("Artifact 不存在");
    return artifactFromRow(connection, row);
  }
  /** 创建不可覆盖的 ArtifactVersion，并校验父版本与项目范围。 */
  createArtifactVersion(
    connection: BetterSqlite3.Database,
    version: ArtifactVersion,
  ): void {
    ensureProjectWritable(connection, version.projectId);
    ensureProjectChild(
      connection,
      "artifacts",
      version.projectId,
      version.artifactId,
    );
    if (version.taskId)
      ensureProjectChild(
        connection,
        "tasks",
        version.projectId,
        version.taskId,
      );
    if (version.parentVersionId)
      ensureProjectChild(
        connection,
        "artifact_versions",
        version.projectId,
        version.parentVersionId,
      );
    connection
      .prepare(
        "INSERT INTO artifact_versions (id,artifact_id,project_id,task_id,version_number,parent_version_id,change_reason,store_ref,sha256,media_type,size_bytes,relative_path,created_at,created_by,integrity_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        version.id,
        version.artifactId,
        version.projectId,
        version.taskId,
        version.version,
        version.parentVersionId,
        version.changeReason,
        version.storeRef,
        version.contentRef.sha256,
        version.contentRef.mediaType,
        version.contentRef.size,
        version.contentRef.relativePath,
        version.createdAt,
        version.createdBy,
        version.integrityStatus ?? "unknown",
      );
  }
  /** 读取不可变 ArtifactVersion。 */
  getArtifactVersion(
    connection: BetterSqlite3.Database,
    versionId: string,
  ): ArtifactVersion {
    const row = connection
      .prepare("SELECT * FROM artifact_versions WHERE id=?")
      .get(versionId) as ArtifactVersionRow | undefined;
    if (!row) throw new NotFoundError("ArtifactVersion 不存在");
    return versionFromRow(row);
  }
  /** 按 Artifact ID 返回版本历史。 */
  listArtifactVersions(
    connection: BetterSqlite3.Database,
    artifactId: string,
  ): ArtifactVersion[] {
    return (
      connection
        .prepare(
          "SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version_number",
        )
        .all(artifactId) as ArtifactVersionRow[]
    ).map(versionFromRow);
  }
  /** 校验 ArtifactVersion 文件并把结果持久化为可审计状态。 */
  async verifyArtifactVersion(
    connection: BetterSqlite3.Database,
    store: FileArtifactStore,
    versionId: string,
  ): Promise<ArtifactVerification> {
    const version = this.getArtifactVersion(connection, versionId);
    const reference: ArtifactReference = {
      artifactId: version.contentRef.artifactId,
      projectId: version.projectId,
      sha256: version.contentRef.sha256,
      mediaType: version.contentRef.mediaType,
      sizeBytes: version.contentRef.size,
      createdAt: version.contentRef.createdAt,
      relativePath: version.contentRef.relativePath,
      storeRef: version.storeRef,
    };
    const result = await store.verify(reference);
    connection
      .prepare("UPDATE artifact_versions SET integrity_status=? WHERE id=?")
      .run(result.valid ? "verified" : "invalid", versionId);
    return result;
  }
  /** 创建审批对象，并验证其任务/证据引用属于同一项目。 */
  createApproval(connection: BetterSqlite3.Database, approval: Approval): void {
    ensureProjectWritable(connection, approval.projectId);
    if (approval.taskId)
      ensureProjectChild(
        connection,
        "tasks",
        approval.projectId,
        approval.taskId,
      );
    if (approval.artifactVersionId)
      ensureProjectChild(
        connection,
        "artifact_versions",
        approval.projectId,
        approval.artifactVersionId,
      );
    if (approval.evidenceVersionId)
      ensureProjectChild(
        connection,
        "artifact_versions",
        approval.projectId,
        approval.evidenceVersionId,
      );
    connection
      .prepare(
        "INSERT INTO approvals (id,project_id,task_id,approval_type,subject_type,subject_id,artifact_version_id,evidence_version_id,decision,direction,boss_id,status,response_task_id,created_at,decided_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        approval.id,
        approval.projectId,
        approval.taskId,
        approval.approvalType,
        approval.subjectType,
        approval.subjectId,
        approval.artifactVersionId,
        approval.evidenceVersionId,
        approval.decision,
        approval.direction,
        approval.bossId,
        approval.status,
        approval.responseTaskId,
        approval.createdAt,
        approval.decidedAt,
        approval.version,
      );
  }
  /** 创建 Review 对象。 */
  createReview(connection: BetterSqlite3.Database, review: Review): void {
    ensureProjectWritable(connection, review.projectId);
    ensureProjectChild(
      connection,
      "artifact_versions",
      review.projectId,
      review.artifactVersionId,
    );
    connection
      .prepare(
        "INSERT INTO reviews (id,project_id,task_id,artifact_version_id,reviewer_role,reviewer_id,decision,comments,evidence_version_id,rework_task_id,created_at,decided_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        review.id,
        review.projectId,
        review.taskId,
        review.artifactVersionId,
        review.reviewerRole,
        review.reviewerId,
        review.decision,
        review.comments,
        review.evidenceVersionId,
        review.reworkTaskId,
        review.createdAt,
        review.decidedAt,
        review.version,
      );
  }
  /** 创建测试用例。 */
  createTestCase(connection: BetterSqlite3.Database, testCase: TestCase): void {
    ensureProjectWritable(connection, testCase.projectId);
    connection
      .prepare(
        "INSERT INTO test_cases (id,project_id,task_id,acceptance_criteria_json,preconditions,steps,expected_result,test_type,owner_role,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        testCase.id,
        testCase.projectId,
        testCase.taskId,
        jsonText(testCase.acceptanceCriteria),
        typeof testCase.preconditions === "string"
          ? testCase.preconditions
          : jsonText(testCase.preconditions),
        typeof testCase.steps === "string"
          ? testCase.steps
          : jsonText(testCase.steps),
        testCase.expectedResult,
        testCase.testType,
        testCase.ownerRole,
        testCase.createdAt,
        testCase.version,
      );
  }
  /** 创建测试运行记录。 */
  createTestRun(connection: BetterSqlite3.Database, run: TestRun): void {
    ensureProjectWritable(connection, run.projectId);
    ensureProjectChild(connection, "test_cases", run.projectId, run.testCaseId);
    connection
      .prepare(
        "INSERT INTO test_runs (id,project_id,task_id,test_case_id,baseline_version_id,command_or_steps,environment_json,started_at,ended_at,actual_result,exit_code,status,evidence_version_id,trace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        run.id,
        run.projectId,
        run.taskId,
        run.testCaseId,
        run.baselineVersionId,
        run.commandOrSteps,
        jsonText(run.environment),
        run.startedAt,
        run.endedAt,
        run.actualResult,
        run.exitCode,
        run.status,
        run.evidenceVersionId,
        run.traceId,
      );
  }
  /** 创建缺陷记录，保留测试/证据/修复版本链。 */
  createDefect(connection: BetterSqlite3.Database, defect: Defect): void {
    ensureProjectWritable(connection, defect.projectId);
    ensureProjectChild(
      connection,
      "test_runs",
      defect.projectId,
      defect.sourceTestRunId,
    );
    connection
      .prepare(
        "INSERT INTO defects (id,project_id,task_id,source_test_run_id,reproduction,severity,actual_result,expected_result,evidence_version_id,npi_owner_role,status,fixed_version_id,regression_test_run_id,created_at,resolved_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        defect.id,
        defect.projectId,
        defect.taskId,
        defect.sourceTestRunId,
        defect.reproduction,
        defect.severity,
        defect.actualResult,
        defect.expectedResult,
        defect.evidenceVersionId,
        defect.npiOwnerRole,
        defect.status,
        defect.fixedVersionId,
        defect.regressionTestRunId,
        defect.createdAt,
        defect.resolvedAt,
        defect.version,
      );
  }
  /** 读取测试运行。 */
  getTestRun(connection: BetterSqlite3.Database, id: string): TestRun {
    const row = connection
      .prepare("SELECT * FROM test_runs WHERE id=?")
      .get(id) as TestRunRow | undefined;
    if (!row) throw new NotFoundError("TestRun 不存在");
    return testRunFromRow(row);
  }
  /** 读取缺陷。 */
  getDefect(connection: BetterSqlite3.Database, id: string): Defect {
    const row = connection
      .prepare("SELECT * FROM defects WHERE id=?")
      .get(id) as DefectRow | undefined;
    if (!row) throw new NotFoundError("Defect 不存在");
    return defectFromRow(row);
  }
  /** 读取审批。 */
  getApproval(connection: BetterSqlite3.Database, id: string): Approval {
    const row = connection
      .prepare("SELECT * FROM approvals WHERE id=?")
      .get(id) as ApprovalRow | undefined;
    if (!row) throw new NotFoundError("Approval 不存在");
    return approvalFromRow(row);
  }
  /** 读取 Review。 */
  getReview(connection: BetterSqlite3.Database, id: string): Review {
    const row = connection
      .prepare("SELECT * FROM reviews WHERE id=?")
      .get(id) as ReviewRow | undefined;
    if (!row) throw new NotFoundError("Review 不存在");
    return reviewFromRow(row);
  }
  /** 读取测试用例。 */
  getTestCase(connection: BetterSqlite3.Database, id: string): TestCase {
    const row = connection
      .prepare("SELECT * FROM test_cases WHERE id=?")
      .get(id) as TestCaseRow | undefined;
    if (!row) throw new NotFoundError("TestCase 不存在");
    return testCaseFromRow(row);
  }
}

type ArtifactRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  name: string;
  artifact_type: string;
  owner_role: string;
  status: string;
  created_at: string;
  created_by: string;
};
type ArtifactVersionRow = {
  id: string;
  artifact_id: string;
  project_id: string;
  task_id: string | null;
  version_number: number;
  parent_version_id: string | null;
  change_reason: string;
  store_ref: string;
  sha256: string;
  media_type: string;
  size_bytes: number;
  relative_path: string;
  created_at: string;
  created_by: string;
  integrity_status: "unknown" | "verified" | "invalid";
};
type ApprovalRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  approval_type: string;
  subject_type: string;
  subject_id: string;
  artifact_version_id: string | null;
  evidence_version_id: string | null;
  decision: string | null;
  direction: string | null;
  boss_id: string;
  status: string;
  response_task_id: string | null;
  created_at: string;
  decided_at: string | null;
  version: number;
};
type ReviewRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  artifact_version_id: string;
  reviewer_role: string;
  reviewer_id: string;
  decision: string;
  comments: string;
  evidence_version_id: string | null;
  rework_task_id: string | null;
  created_at: string;
  decided_at: string | null;
  version: number;
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
  created_at: string;
  version: number;
};
type TestRunRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  test_case_id: string;
  baseline_version_id: string | null;
  command_or_steps: string;
  environment_json: string;
  started_at: string;
  ended_at: string | null;
  actual_result: string;
  exit_code: number | null;
  status: string;
  evidence_version_id: string | null;
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
function artifactFromRow(
  connection: BetterSqlite3.Database,
  row: ArtifactRow,
): Artifact {
  const latest = connection
    .prepare(
      "SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version_number DESC LIMIT 1",
    )
    .get(row.id) as ArtifactVersionRow | undefined;
  const upstreamLinks = (
    connection
      .prepare(
        "SELECT source_id FROM trace_links WHERE project_id=? AND target_type='artifact' AND target_id=? ORDER BY id",
      )
      .all(row.project_id, row.id) as { source_id: string }[]
  ).map((link) => link.source_id);
  const downstreamLinks = (
    connection
      .prepare(
        "SELECT target_id FROM trace_links WHERE project_id=? AND source_type='artifact' AND source_id=? ORDER BY id",
      )
      .all(row.project_id, row.id) as { target_id: string }[]
  ).map((link) => link.target_id);
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    name: row.name,
    artifactType: row.artifact_type,
    ownerRole: row.owner_role,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    contentRef: latest
      ? parseArtifactRef({
          artifactId: latest.artifact_id,
          sha256: latest.sha256,
          mediaType: latest.media_type,
          size: latest.size_bytes,
          createdAt: latest.created_at,
          relativePath: latest.relative_path,
          storeRef: latest.store_ref,
        })
      : null,
    upstreamLinks,
    downstreamLinks,
    version: latest?.version_number ?? 1,
  };
}
function versionFromRow(row: ArtifactVersionRow): ArtifactVersion {
  const contentRef = parseArtifactRef({
    artifactId: row.artifact_id,
    sha256: row.sha256,
    mediaType: row.media_type,
    size: row.size_bytes,
    createdAt: row.created_at,
    relativePath: row.relative_path,
    storeRef: row.store_ref,
  });
  return {
    id: row.id,
    artifactId: row.artifact_id,
    projectId: row.project_id,
    taskId: row.task_id,
    version: row.version_number,
    parentVersionId: row.parent_version_id,
    changeReason: row.change_reason,
    contentRef,
    storeRef: row.store_ref,
    createdAt: row.created_at,
    createdBy: row.created_by,
    integrityStatus: row.integrity_status,
  };
}
function approvalFromRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    approvalType: row.approval_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    artifactVersionId: row.artifact_version_id,
    evidenceVersionId: row.evidence_version_id,
    decision: row.decision,
    direction: row.direction,
    bossId: row.boss_id,
    status: row.status,
    responseTaskId: row.response_task_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    version: row.version,
  };
}
function reviewFromRow(row: ReviewRow): Review {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    artifactVersionId: row.artifact_version_id,
    reviewerRole: row.reviewer_role,
    reviewerId: row.reviewer_id,
    decision: row.decision,
    comments: row.comments,
    evidenceVersionId: row.evidence_version_id,
    reworkTaskId: row.rework_task_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    version: row.version,
  };
}
function testCaseFromRow(row: TestCaseRow): TestCase {
  const parseTextOrJson = (value: string): string | string[] => {
    try {
      const result = JSON.parse(value) as unknown;
      return Array.isArray(result) ? result.map(String) : value;
    } catch (_error) {
      return value;
    }
  };
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    acceptanceCriteria: jsonValue(row.acceptance_criteria_json),
    preconditions: parseTextOrJson(row.preconditions),
    steps: parseTextOrJson(row.steps),
    expectedResult: row.expected_result,
    testType: row.test_type,
    ownerRole: row.owner_role,
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
    commandOrSteps: row.command_or_steps,
    environment: jsonValue(row.environment_json),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    actualResult: row.actual_result,
    exitCode: row.exit_code,
    status: row.status,
    evidenceVersionId: row.evidence_version_id,
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
