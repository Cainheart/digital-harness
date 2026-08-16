import { describe, expect, it } from "vitest";
import { ProjectStatus, newObjectId, utcNow } from "../../src/domain/common.js";
import { QualityFlowService } from "../../src/application/quality-flow.js";
import type {
  CodingExecutionGrant,
  CodingSession,
  HandoffPackage,
} from "../../src/domain/coding/index.js";
import { OrganizationService } from "../../src/application/organization-service.js";
import { CodingRepository } from "../../src/infra/repositories/coding.js";
import { EvidenceRepository } from "../../src/infra/repositories/evidence.js";
import { QualityRepository } from "../../src/infra/repositories/quality.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import { createTestApp, makeProject, useTestRoot } from "../helpers.js";

/** 生成稳定的 ISO 时间，保证质量报告可以选择每个用例的最新 TestRun。 */
function time(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** 为 Review 门禁创建最小的 Task 7 会话和 Handoff 事实。 */
function createCodingHandoff(
  app: Awaited<ReturnType<typeof createTestApp>>,
  projectId: string,
  task: { id: string; title: string; version: number },
  complete: boolean,
): { sessionId: string; handoffId: string } {
  const organization = new OrganizationService(app.runtime.database);
  const attemptId = newObjectId("attempt");
  const expiresAt = time(60_000);
  const grant = organization.createExecutionGrant({
    projectId,
    taskId: task.id,
    attemptId,
    roleId: "backend_developer",
    taskVersion: task.version,
    modelConfigVersion: "0",
    workspaceRoot: "workspace://project",
    deadline: expiresAt,
    leaseExpiresAt: expiresAt,
    traceId: newObjectId("trace"),
  });
  const codingGrant: CodingExecutionGrant = {
    grantId: newObjectId("grant"),
    projectId,
    taskId: task.id,
    attemptId,
    role: "backend_developer",
    roleVersion: grant.roleVersion,
    taskVersion: task.version,
    modelConfigVersion: 0,
    modelProvider: "unconfigured",
    modelName: "unconfigured",
    workspaceGrant: {
      root: "workspace://project",
      read: ["backend/**"],
      write: ["backend/**"],
      deny: [".env*", "secrets/**"],
    },
    toolPolicy: [
      "repo_scan",
      "read_file",
      "search_code",
      "apply_patch",
      "run_verification",
      "save_evidence",
    ],
    commandPolicy: { allow: ["npm"], network: "deny" },
    expiresAt,
    policyVersion: 1,
    traceId: grant.traceId,
  };
  const sessionId = newObjectId("coding_session");
  const session: CodingSession = {
    id: sessionId,
    projectId,
    taskId: task.id,
    attemptId,
    role: "backend_developer",
    status: "REVIEW_REQUESTED",
    spec: {
      taskId: task.id,
      projectId,
      title: task.title,
      goal: "deliver and verify the task",
      acceptanceCriteria: ["T8-AC-03"],
      workspaceRoot: "workspace://project",
      baselineCommit: "baseline",
      allowedPaths: ["backend/**"],
      forbiddenPaths: [".env*", "secrets/**"],
      stackProfile: "node-ts",
      verificationProfile: "backend-default",
      riskPolicy: "standard",
      taskVersion: task.version,
    },
    grant: codingGrant,
    plan: null,
    workspacePath: app.runtime.settings.workspacePath,
    baselineManifest: {},
    currentDiffSummary: "diff summary",
    nextAction: "await developer representative review",
    failureDiagnoses: [],
    verificationIds: complete ? ["verification-1"] : [],
    patchSeq: complete ? [1] : [],
    readFiles: ["backend/src/example.ts"],
    changedFiles: complete ? ["backend/src/example.ts"] : [],
    version: 1,
    traceId: newObjectId("trace"),
    createdAt: utcNow(),
    updatedAt: utcNow(),
  };
  const handoffId = newObjectId("handoff");
  const handoff: HandoffPackage = {
    handoffId,
    sessionId,
    status: "review_requested",
    summary: complete ? "implemented and verified" : "incomplete handoff",
    changedFiles: complete ? ["backend/src/example.ts"] : [],
    diffRef: complete ? "artifact://diff" : "",
    verificationRuns: complete ? ["verification-1"] : [],
    commands: complete ? ["npm test"] : [],
    remainingRisks: [],
    knownFailures: [],
    rollback: { workspaceSnapshot: "snapshot", patchSeq: complete ? [1] : [] },
    traceId: session.traceId,
  };
  const repository = new CodingRepository();
  app.runtime.database.transaction((connection) => {
    repository.createSession(connection, session);
    repository.createHandoff(connection, projectId, handoff, utcNow());
  });
  return { sessionId, handoffId };
}

/** 创建一个已经存在并完成 PRD 审批事实的项目。 */
async function qualityFixture() {
  const app = await createTestApp(useTestRoot());
  const project = makeProject({ status: ProjectStatus.RUNNING });
  const evidence = new EvidenceRepository();
  const projects = new ProjectTaskRepository();
  app.runtime.database.transaction((connection) => {
    projects.createProject(connection, project);
    evidence.createApproval(connection, {
      id: newObjectId("approval"),
      projectId: project.id,
      taskId: null,
      approvalType: "prd_approval",
      subjectType: "prd",
      subjectId: "prd-v1",
      artifactVersionId: null,
      evidenceVersionId: null,
      decision: "approve",
      direction: "forward",
      bossId: "boss-local",
      status: "approved",
      responseTaskId: null,
      createdAt: utcNow(),
      decidedAt: utcNow(),
      version: 1,
    });
  });
  return { app, project, qualityFlow: app.runtime.qualityFlow };
}

/** Task 8 主链路：拆解、策略、真实执行、失败缺陷、NPI 和测试回归。 */
describe("Task 8 quality flow", () => {
  it("closes a defect only after a tester regression and preserves release evidence", async () => {
    const { app, project, qualityFlow } = await qualityFixture();
    const decomposition = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/coding-tasks`,
      payload: {
        approvedRequirementRefs: ["SR-EXE-006"],
        acceptanceCriteria: ["T8-AC-07", "T8-AC-08"],
        idempotencyKey: "t8-decompose-1",
        traceId: "tr_t8_decompose",
        actor: {
          type: "role",
          id: "developer_representative",
        },
      },
    });
    expect(decomposition.statusCode).toBe(201);
    const decompositionBody = decomposition.json() as {
      tasks: { id: string; version: number }[];
      qualitySpecs: { taskId: string }[];
    };
    expect(decompositionBody.tasks).toHaveLength(3);
    expect(new Set(decompositionBody.qualitySpecs.map((item) => item.taskId)).size).toBe(3);

    const qualityRepository = new QualityRepository();
    const approvedReviewIds: string[] = [];
    let rejectedReviewId = "";
    app.runtime.database.transaction((connection) => {
      for (const task of decompositionBody.tasks) {
        const reviewId = newObjectId("quality_review");
        approvedReviewIds.push(reviewId);
        qualityRepository.createQualityReview(connection, {
          id: reviewId,
          projectId: project.id,
          taskId: task.id,
          sessionId: null,
          handoffId: null,
          artifactVersionId: null,
          decision: "approved",
          comments: "approved Task 8 test baseline",
          reviewerRole: "developer_representative",
          reviewerId: "developer-representative-1",
          evidenceVersion: 1,
          taskVersion: task.version,
          reworkTaskId: null,
          createdAt: utcNow(),
          decidedAt: utcNow(),
          traceId: "tr_t8_review",
          idempotencyKey: `t8-review-${task.id}`,
        });
      }
      rejectedReviewId = newObjectId("quality_review");
      qualityRepository.createQualityReview(connection, {
        id: rejectedReviewId,
        projectId: project.id,
        taskId: decompositionBody.tasks[0].id,
        sessionId: null,
        handoffId: null,
        artifactVersionId: null,
        decision: "changes_requested",
        comments: "unapproved baseline for guard test",
        reviewerRole: "developer_representative",
        reviewerId: "developer-representative-1",
        evidenceVersion: 1,
        taskVersion: 1,
        reworkTaskId: decompositionBody.tasks[0].id,
        createdAt: utcNow(),
        decidedAt: utcNow(),
        traceId: "tr_t8_rejected",
        idempotencyKey: "t8-rejected-review",
      });
    });

    const strategy = qualityFlow.createTestStrategy(
      project.id,
      {
        title: "Task 8 acceptance strategy",
        scope: "all approved Task 8 acceptance criteria",
        acceptanceCriteriaRefs: ["T8-AC-07", "T8-AC-08"],
        testTypes: ["functional", "boundary", "integration", "regression"],
        environment: { node: "22", database: "sqlite" },
        ownerRole: "test_lead",
        idempotencyKey: "t8-strategy-1",
        traceId: "tr_t8_strategy",
      },
      "test_lead",
    );
    const testCase = qualityFlow.createTestCase(
      strategy.id,
      {
        acceptanceCriteriaRefs: ["T8-AC-07", "T8-AC-08"],
        preconditions: ["approved review baseline exists"],
        steps: ["run the real test command"],
        expectedResult: "the command result is persisted with evidence",
        testType: "functional",
        ownerRole: "functional_tester",
        idempotencyKey: "t8-case-1",
        traceId: "tr_t8_case",
      },
      "test_lead",
    );

    expect(() =>
      qualityFlow.runTest(
        testCase.id,
        {
          baselineReviewId: rejectedReviewId,
          commandOrSteps: "npm test",
          environment: { node: "22" },
          startedAt: time(-5000),
          endedAt: time(-4000),
          actualResult: "blocked by rejected baseline",
          exitCode: 1,
          status: "failed",
          evidenceRefs: ["artifact://blocked-baseline"],
          idempotencyKey: "t8-run-rejected-baseline",
          traceId: "tr_t8_rejected_baseline",
        },
        "functional_tester",
      ),
    ).toThrow();

    const firstPass = qualityFlow.runTest(
      testCase.id,
      {
        baselineReviewId: approvedReviewIds[0],
        commandOrSteps: "npm test -- --run acceptance",
        environment: { node: "22" },
        startedAt: time(-3000),
        endedAt: time(-2900),
        actualResult: "all acceptance checks passed",
        exitCode: 0,
        status: "passed",
        evidenceRefs: ["artifact://t8-first-pass"],
        idempotencyKey: "t8-run-first-pass",
        traceId: "tr_t8_first_pass",
      },
      "functional_tester",
    );
    expect(firstPass.testRun.baselineReviewId).toBe(approvedReviewIds[0]);

    const failed = qualityFlow.runTest(
      testCase.id,
      {
        baselineReviewId: approvedReviewIds[0],
        commandOrSteps: "npm test -- --run defect",
        environment: { node: "22" },
        startedAt: time(-2000),
        endedAt: time(-1900),
        actualResult: "expected task result was not produced",
        expectedResult: "all acceptance checks pass",
        exitCode: 1,
        status: "failed",
        severity: "P1",
        evidenceRefs: ["artifact://t8-failure-log"],
        idempotencyKey: "t8-run-failure",
        traceId: "tr_t8_failure",
      },
      "functional_tester",
    );
    expect(failed.defect?.sourceTestRunId).toBe(failed.testRun.id);
    expect(failed.defect?.status).toBe("open");
    expect(qualityFlow.getTestReport(project.id).releaseAllowed).toBe(false);

    const defectId = failed.defect?.id ?? "";
    expect(() =>
      qualityFlow.recordRegressionResult(
        defectId,
        {
          regressionRequestId: "not-created",
          testRunId: failed.testRun.id,
          status: "failed",
          evidenceRefs: ["artifact://npi-cannot-close"],
          actualResult: "NPI cannot submit a tester result",
          idempotencyKey: "t8-npi-cannot-close",
          traceId: "tr_t8_npi_cannot_close",
        },
        "npi_lead",
      ),
    ).toThrow();

    const analysis = qualityFlow.createNpiAnalysis(
      defectId,
      {
        reproduction: "run the defect test command",
        rootCause: "the implementation omitted the edge condition",
        impact: "the acceptance criterion remains unverified",
        recommendedFix: "add the missing branch and test",
        idempotencyKey: "t8-analysis-1",
        traceId: "tr_t8_analysis",
      },
      "npi_lead",
    );
    expect(analysis.defect.status).toBe("in_analysis");
    const fix = qualityFlow.submitFixRequest(
      defectId,
      {
        fixDescription: "add the missing branch and preserve the evidence command",
        fixArtifactRef: "artifact://t8-fix-1",
        idempotencyKey: "t8-fix-1",
        traceId: "tr_t8_fix",
      },
      "backend_fixer",
    );
    expect(fix.defect.status).toBe("awaiting_regression");
    const failedRegressionRequest = qualityFlow.requestRegression(
      defectId,
      {
        fixRequestId: fix.id,
        scope: "repeat the failed acceptance command",
        testCaseId: testCase.id,
        idempotencyKey: "t8-regression-request-1",
        traceId: "tr_t8_regression_request_1",
      },
      "regression_coordinator",
    );
    const failedRegression = qualityFlow.recordRegressionResult(
      defectId,
      {
        regressionRequestId: failedRegressionRequest.id,
        testRunId: failed.testRun.id,
        status: "failed",
        evidenceRefs: ["artifact://t8-regression-failure"],
        actualResult: "the defect is still reproducible",
        idempotencyKey: "t8-regression-result-1",
        traceId: "tr_t8_regression_failure",
      },
      "regression_tester",
    );
    expect(failedRegression.defect.status).toBe("open");

    qualityFlow.createNpiAnalysis(
      defectId,
      {
        reproduction: "repeat the same command after the first fix",
        rootCause: "the first fix did not cover the boundary input",
        impact: "release remains blocked",
        recommendedFix: "complete the boundary handling",
        idempotencyKey: "t8-analysis-2",
        traceId: "tr_t8_analysis_2",
      },
      "defect_analyst",
    );
    const secondFix = qualityFlow.submitFixRequest(
      defectId,
      {
        fixDescription: "complete the boundary handling",
        fixArtifactRef: "artifact://t8-fix-2",
        idempotencyKey: "t8-fix-2",
        traceId: "tr_t8_fix_2",
      },
      "backend_fixer",
    );
    const passedRegressionRequest = qualityFlow.requestRegression(
      defectId,
      {
        fixRequestId: secondFix.id,
        scope: "run the acceptance and boundary regression commands",
        testCaseId: testCase.id,
        idempotencyKey: "t8-regression-request-2",
        traceId: "tr_t8_regression_request_2",
      },
      "regression_coordinator",
    );
    const finalPass = qualityFlow.runTest(
      testCase.id,
      {
        baselineReviewId: approvedReviewIds[0],
        commandOrSteps: "npm test -- --run regression",
        environment: { node: "22" },
        startedAt: time(1000),
        endedAt: time(1100),
        actualResult: "acceptance and regression checks passed",
        exitCode: 0,
        status: "passed",
        evidenceRefs: ["artifact://t8-regression-pass"],
        idempotencyKey: "t8-run-final-pass",
        traceId: "tr_t8_final_pass",
      },
      "regression_tester",
    );
    const closed = qualityFlow.recordRegressionResult(
      defectId,
      {
        regressionRequestId: passedRegressionRequest.id,
        testRunId: finalPass.testRun.id,
        status: "passed",
        evidenceRefs: ["artifact://t8-regression-pass"],
        actualResult: "the repaired path passes the real regression command",
        idempotencyKey: "t8-regression-result-2",
        traceId: "tr_t8_regression_pass",
      },
      "regression_tester",
    );
    expect(closed.defect.status).toBe("closed");
    const report = qualityFlow.getTestReport(project.id, "tr_t8_report");
    expect(report.acceptanceCriteria.missing).toEqual([]);
    expect(report.defects.blocking).toBe(0);
    expect(report.defects.regressionFailed).toBe(1);
    expect(report.releaseAllowed).toBe(true);
    const traceTargets = app.runtime.database.connection
      .prepare(
        "SELECT DISTINCT target_type FROM trace_links WHERE project_id=?",
      )
      .all(project.id) as { target_type: string }[];
    expect(traceTargets.map((item) => item.target_type)).toEqual(
      expect.arrayContaining([
        "task",
        "test_case",
        "test_run",
        "defect",
        "npi_analysis",
        "fix_request",
        "regression_request",
        "regression_result",
      ]),
    );

    await app.close();
  });

  it("requires complete Handoff evidence and applies Review only to the reviewed task", async () => {
    const { app, project, qualityFlow } = await qualityFixture();
    const decomposition = qualityFlow.decomposeTasks(
      project.id,
      {
        approvedRequirementRefs: ["SR-EXE-003"],
        acceptanceCriteria: ["T8-AC-02", "T8-AC-03", "T8-AC-04"],
        idempotencyKey: "t8-review-decompose",
        traceId: "tr_t8_review_decompose",
      },
      "developer_representative",
    );
    const incomplete = createCodingHandoff(
      app,
      project.id,
      decomposition.tasks[0],
      false,
    );
    expect(() =>
      qualityFlow.assertHandoffReadyForReview(
        incomplete.sessionId,
        "developer_representative",
        "approved",
        "",
      ),
    ).toThrow();

    const approvedHandoff = createCodingHandoff(
      app,
      project.id,
      decomposition.tasks[0],
      true,
    );
    const approved = qualityFlow.recordHandoffReview(
      approvedHandoff.sessionId,
      "developer_representative",
      "approved",
      "Review 通过",
      {
        reviewerId: "developer-representative-1",
        evidenceVersion: 1,
        idempotencyKey: "t8-handoff-approved",
        traceId: "tr_t8_handoff_approved",
      },
    );
    expect(approved.decision).toBe("approved");
    expect(approved.task.status).toBe("已完成");

    const changesHandoff = createCodingHandoff(
      app,
      project.id,
      decomposition.tasks[1],
      true,
    );
    const changes = qualityFlow.recordHandoffReview(
      changesHandoff.sessionId,
      "developer_representative",
      "changes_requested",
      "补充边界测试",
      {
        reviewerId: "developer-representative-1",
        evidenceVersion: 1,
        idempotencyKey: "t8-handoff-changes",
        traceId: "tr_t8_handoff_changes",
      },
    );
    expect(changes.task.status).toBe("返工");
    const untouched = app.runtime.database.transaction((connection) =>
      new ProjectTaskRepository().getTask(connection, decomposition.tasks[2].id),
    );
    expect(untouched.status).toBe("待处理");

    await app.close();
  });
});
