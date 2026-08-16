import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import {
  assertSafeData,
  newObjectId,
  normalizeUtc,
  TaskStatus,
  utcNow,
} from "../domain/common.js";
import { Defect, Task, TestCase, TestRun } from "../domain/entities.js";
import {
  EvidenceIncompleteError,
  IdempotencyKeyReusedError,
  InvalidArgumentError,
  NotFoundError,
  PolicyDeniedError,
  VersionConflictError,
  WorkflowGuardBlockedError,
} from "../domain/errors.js";
import {
  DecomposedTaskInput,
  DecomposedTaskInputSchema,
  FixRequestInput,
  FixRequestSchema,
  NpiAnalysisInput,
  NpiAnalysisSchema,
  QUALITY_ROLES,
  RegressionRequestInput,
  RegressionRequestSchema,
  RegressionResultInput,
  RegressionResultSchema,
  TaskDecompositionInput,
  TaskDecompositionSchema,
  TestCaseInput,
  TestCaseInputSchema,
  DefectInput,
  DefectInputSchema,
  TestRunInput,
  TestRunInputSchema,
  TestStrategyInput,
  TestStrategySchema,
  assertQualityInput,
  isNpiRole,
  isTesterRole,
} from "../domain/quality/index.js";
import { Database } from "../infra/database.js";
import { EvidenceRepository } from "../infra/repositories/evidence.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import {
  FixRequestRecord,
  QualityRepository,
  RegressionRequestRecord,
  RegressionResultRecord,
  TaskQualitySpecRecord,
  TestStrategyRecord,
} from "../infra/repositories/quality.js";
import { TraceRepository } from "../infra/repositories/trace.js";
import { assertTaskTransition } from "../workflow/state-machine.js";

/** Task 8 需求拆解的持久化返回对象。 */
export type TaskDecompositionResult = {
  projectId: string;
  tasks: Task[];
  qualitySpecs: TaskQualitySpecRecord[];
  traceId: string;
};

/** 测试执行返回测试事实及失败时自动创建的缺陷。 */
export type TestExecutionResult = {
  testRun: TestRun;
  defect: Defect | null;
  traceId: string;
};

/** Review 交接返回质量 Review 和被局部更新的任务。 */
export type QualityReviewResult = {
  reviewId: string;
  decision: "approved" | "changes_requested" | "blocked";
  baselineVersionId: string | null;
  reworkTaskId: string | null;
  task: Task;
  traceId: string;
};

/** 质量门禁报告，供测试放行审批和看板使用。 */
export type TestReport = {
  projectId: string;
  strategyIds: string[];
  acceptanceCriteria: {
    total: number;
    covered: number;
    missing: string[];
  };
  testRuns: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    evidenceComplete: boolean;
  };
  defects: {
    total: number;
    open: number;
    blocking: number;
    regressionPassed: number;
    regressionFailed: number;
  };
  approvedReviewCount: number;
  releaseAllowed: boolean;
  releaseRecommendation: string;
  traceId: string;
};

/**
 * Task 8 质量应用服务：协调任务拆解、Review 基线、真实测试、缺陷和 NPI 回归。
 * 该服务只写事务内事实，不执行任意命令；真实命令由 Task 7 Harness/Runner 负责。
 */
export class QualityFlowService {
  private readonly projects = new ProjectTaskRepository();
  private readonly evidence = new EvidenceRepository();
  private readonly quality = new QualityRepository();
  private readonly events = new SqliteEventStore();
  private readonly traces = new TraceRepository();

  /** 注入同一 SQLite 控制面，保证质量对象和领域事件原子提交。 */
  constructor(private readonly database: Database) {}

  /**
   * 将已批准需求确定性拆成至少三个专业任务，并冻结每个任务的执行规格。
   * 输入中的自定义任务必须覆盖至少三个不同专业标签，默认任务由固定专业模板生成。
   */
  decomposeTasks(
    projectId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): TaskDecompositionResult {
    this.assertRole(actorRole, QUALITY_ROLES.developerRepresentative);
    const input = assertQualityInput<TaskDecompositionInput>(
      TaskDecompositionSchema,
      rawInput,
      "任务拆解请求",
    );
    this.assertProjectHasApprovedPrd(projectId);
    const requestHash = hashInput({ projectId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<TaskDecompositionResult>(
        connection,
        input.idempotencyKey,
        requestHash,
        "task_decomposition",
      );
      if (replay) return replay;
      const taskInputs = input.tasks ?? defaultDecomposedTasks(input);
      this.validateTaskInputs(taskInputs, input.acceptanceCriteria);
      const project = this.projects.getProject(connection, projectId);
      const tasks: Task[] = [];
      const specs: TaskQualitySpecRecord[] = [];
      for (const taskInput of taskInputs) {
        const task = this.buildTask(projectId, taskInput, actorRole);
        this.projects.createTask(connection, task);
        const spec = this.buildQualitySpec(
          projectId,
          task,
          taskInput,
          actorRole,
        );
        this.quality.createTaskQualitySpec(connection, spec);
        for (const criterion of taskInput.acceptanceCriteriaRefs) {
          this.traces.create(connection, {
            id: newObjectId("trace_link"),
            projectId,
            sourceType: "acceptance_criterion",
            sourceId: criterion,
            targetType: "task",
            targetId: task.id,
            relation: "implemented_by",
            traceId: input.traceId,
            createdAt: utcNow(),
            version: 1,
          });
        }
        this.appendQualityEvent(
          connection,
          "task",
          task.id,
          projectId,
          "DevelopmentTaskDecomposed",
          {
            projectId,
            taskId: task.id,
            taskVersion: task.version,
            acceptanceCriteriaRefs: taskInput.acceptanceCriteriaRefs,
            professionalTag: taskInput.professionalTag,
          },
          actorRole,
          actorId,
          input.traceId,
        );
        tasks.push(task);
        specs.push(spec);
      }
      const result: TaskDecompositionResult = {
        projectId,
        tasks,
        qualitySpecs: specs,
        traceId: input.traceId,
      };
      this.saveIdempotency(
        connection,
        projectId,
        input.idempotencyKey,
        requestHash,
        "task_decomposition",
        result,
      );
      void project;
      return result;
    });
  }

  /** 检查质量角色，拒绝用普通字符串伪造开发代表、测试或 NPI 身份。 */
  private assertRole(role: string, expected: string): void {
    if (role !== expected)
      throw new PolicyDeniedError(`当前动作仅允许角色 ${expected}`);
  }

  /** 检查 PRD 审批事实；客户端声明 approvedRequirementRefs 不能替代 Boss 决定。 */
  private assertProjectHasApprovedPrd(projectId: string): void {
    const project = this.database.connection
      .prepare("SELECT id,read_only,status FROM projects WHERE id=?")
      .get(projectId) as
      | { id: string; read_only: number; status: string }
      | undefined;
    if (!project) throw new NotFoundError("项目不存在");
    if (
      project.read_only ||
      project.status === "已结项" ||
      project.status === "已终止"
    )
      throw new WorkflowGuardBlockedError("历史项目处于只读状态，不能拆解开发任务");
    const approval = this.database.connection
      .prepare(
        "SELECT id FROM approvals WHERE project_id=? AND approval_type='prd_approval' AND status='approved' ORDER BY decided_at DESC,id DESC LIMIT 1",
      )
      .get(projectId);
    if (!approval)
      throw new WorkflowGuardBlockedError(
        "未找到已批准的 PRD，不能创建开发任务拆解",
      );
  }

  /** 检查至少三个专业任务、唯一标签和验收标准关联。 */
  private validateTaskInputs(
    taskInputs: DecomposedTaskInput[],
    acceptanceCriteria: string[],
  ): void {
    if (taskInputs.length < 3)
      throw new InvalidArgumentError("开发任务拆解至少需要三个任务");
    const tags = unique(taskInputs.map((task) => task.professionalTag));
    if (tags.length < 3)
      throw new InvalidArgumentError("开发任务必须包含至少三个不同专业标签");
    const criteria = new Set(acceptanceCriteria);
    for (const task of taskInputs) {
      if (task.acceptanceCriteriaRefs.some((ref) => !criteria.has(ref)))
        throw new InvalidArgumentError(
          `任务 ${task.title} 关联了未在已批准验收标准中的引用`,
        );
      if (!task.workspacePolicy.trim() || !task.verificationProfile.trim())
        throw new InvalidArgumentError("任务必须有工作区策略和 VerificationProfile");
    }
  }

  /** 将拆解输入转换为现有 Task 领域对象，保留责任组长的转换理由。 */
  private buildTask(
    projectId: string,
    input: DecomposedTaskInput,
    actorRole: string,
  ): Task {
    return {
      id: newObjectId("task"),
      projectId,
      title: input.title,
      ownerRole: input.assigneeRole,
      specialistTag: input.professionalTag,
      assignmentReason: `${actorRole} 将已批准需求转换为 ${input.professionalTag} 专业交付任务：${input.goal}`,
      priority: input.priority,
      dependencies: [...input.dependencies],
      expectedDeliverables: [...input.expectedArtifactTypes],
      status: TaskStatus.PENDING,
      createdAt: utcNow(),
      startedAt: null,
      endedAt: null,
      version: 1,
    };
  }

  /** 生成编码 Agent 可消费的最小工作区边界，默认拒绝凭据和 secrets 路径。 */
  private buildQualitySpec(
    projectId: string,
    task: Task,
    input: DecomposedTaskInput,
    actorRole: string,
  ): TaskQualitySpecRecord {
    const frontend = input.professionalTag.toLowerCase().includes("front");
    const allowedPaths = frontend ? ["frontend/**"] : ["backend/**"];
    return {
      id: newObjectId("task_quality_spec"),
      projectId,
      taskId: task.id,
      taskVersion: task.version,
      goal: input.goal,
      acceptanceCriteriaRefs: [...input.acceptanceCriteriaRefs],
      expectedArtifactTypes: [...input.expectedArtifactTypes],
      workspacePolicy: input.workspacePolicy,
      verificationProfile: input.verificationProfile,
      stackProfile: input.stackProfile,
      baselineCommit: input.baselineCommit,
      allowedPaths,
      forbiddenPaths: [".env*", "secrets/**", "**/.env*"],
      conversionNote: `${actorRole} 根据批准需求、专业标签和验收关联生成；未直接复制 Boss 方向意见。`,
      createdBy: actorRole,
      createdAt: utcNow(),
    };
  }

  /** 只更新被 Review 影响的任务，已通过的其他任务不参与本次状态变化。 */
  private applyReviewTaskTransition(
    connection: BetterSqlite3.Database,
    task: Task,
    decision: "approved" | "changes_requested" | "blocked",
  ): Task {
    let current = task;
    if (current.status === TaskStatus.PENDING || current.status === TaskStatus.REWORK) {
      assertTaskTransition(current.status, TaskStatus.RUNNING, {
        dependenciesSatisfied: true,
      });
      current = this.projects.updateTask(
        connection,
        {
          ...current,
          status: TaskStatus.RUNNING,
          startedAt: current.startedAt ?? utcNow(),
          endedAt: null,
          version: current.version + 1,
        },
        current.version,
      );
    }
    const nextStatus =
      decision === "approved"
        ? TaskStatus.COMPLETED
        : decision === "changes_requested"
          ? TaskStatus.REWORK
          : TaskStatus.BLOCKED;
    if (
      current.status !== TaskStatus.RUNNING &&
      current.status !== TaskStatus.WAITING_REVIEW
    )
      throw new WorkflowGuardBlockedError(
        "只有执行中或等待 Review 的任务才能记录 Handoff Review",
      );
    if (decision === "changes_requested" && current.status === TaskStatus.RUNNING) {
      assertTaskTransition(current.status, TaskStatus.WAITING_REVIEW, {
        evidenceComplete: true,
      });
      current = this.projects.updateTask(
        connection,
        {
          ...current,
          status: TaskStatus.WAITING_REVIEW,
          version: current.version + 1,
        },
        current.version,
      );
    }
    assertTaskTransition(current.status, nextStatus, { evidenceComplete: true });
    const next: Task = {
      ...current,
      status: nextStatus,
      endedAt: nextStatus === TaskStatus.COMPLETED ? utcNow() : current.endedAt,
      version: current.version + 1,
    };
    return this.projects.updateTask(connection, next, current.version);
  }

  /** 读取项目任务规格；所有测试覆盖计算均基于持久化版本而非请求临时数组。 */
  private listSpecs(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): TaskQualitySpecRecord[] {
    return this.quality.listTaskQualitySpecs(connection, projectId);
  }

  /** 读取项目测试策略。 */
  private listStrategies(
    connection: BetterSqlite3.Database,
    projectId: string,
  ): TestStrategyRecord[] {
    return this.quality.listTestStrategies(connection, projectId);
  }

  /** 找到与验收标准关联的任务；找不到时保持 test_case 为项目级对象。 */
  private findTaskForCriteria(
    connection: BetterSqlite3.Database,
    projectId: string,
    criteria: string[],
  ): string | null {
    const task = this.listSpecs(connection, projectId).find((spec) =>
      criteria.every((criterion) => spec.acceptanceCriteriaRefs.includes(criterion)),
    );
    return task?.taskId ?? null;
  }

  /** 在编码 Handoff 进入 Harness Review 前验证 diff、自测和交接字段完整性。 */
  assertHandoffReadyForReview(
    sessionId: string,
    reviewerRole: string,
    decision: "approved" | "changes_requested" | "blocked",
    comments: string,
  ): void {
    this.assertRole(reviewerRole, QUALITY_ROLES.developerRepresentative);
    if (decision !== "approved" && !comments.trim())
      throw new WorkflowGuardBlockedError("Review 驳回或阻塞必须填写非空意见");
    const row = this.database.connection
      .prepare(
        "SELECT s.project_id,s.task_id,s.spec_json,h.package_json FROM coding_sessions s JOIN coding_handoffs h ON h.project_id=s.project_id AND h.session_id=s.id WHERE s.id=?",
      )
      .get(sessionId) as HandoffRow | undefined;
    if (!row) throw new NotFoundError("编码 Handoff 不存在");
    const handoff = parseHandoff(row.package_json);
    const codingSpec = parseCodingSpec(row.spec_json);
    const missing: string[] = [];
    if (!handoff.summary) missing.push("summary");
    if (!handoff.diffRef) missing.push("diffRef");
    if (handoff.changedFiles.length === 0) missing.push("changedFiles");
    if (handoff.verificationRuns.length === 0) missing.push("verificationRuns");
    if (handoff.commands.length === 0) missing.push("commands");
    if (!handoff.traceId) missing.push("traceId");
    if (handoff.remainingRisks === null) missing.push("remainingRisks");
    if (handoff.knownFailures === null) missing.push("knownFailures");
    if (!handoff.rollbackValid) missing.push("rollback");
    if (codingSpec.acceptanceCriteria.length === 0)
      missing.push("acceptanceCriteria");
    if (missing.length > 0) {
      throw new EvidenceIncompleteError("Handoff 缺少代码变更或自测证据", {
        data: { sessionId, missing },
      });
    }
  }

  /** 记录 Harness Review 结果，approved 才产生可供测试选择的质量基线。 */
  recordHandoffReview(
    sessionId: string,
    reviewerRole: string,
    decision: "approved" | "changes_requested" | "blocked",
    comments: string,
    options: {
      evidenceVersion?: number | null;
      idempotencyKey: string;
      traceId: string;
      reviewerId?: string;
    },
  ): QualityReviewResult {
    this.assertHandoffReadyForReview(
      sessionId,
      reviewerRole,
      decision,
      comments,
    );
    const sessionRow = this.database.connection
      .prepare(
        "SELECT s.project_id,s.task_id,h.id AS handoff_id FROM coding_sessions s JOIN coding_handoffs h ON h.project_id=s.project_id AND h.session_id=s.id WHERE s.id=?",
      )
      .get(sessionId) as SessionHandoffRow | undefined;
    if (!sessionRow) throw new NotFoundError("编码会话或 Handoff 不存在");
    const requestHash = hashInput({
      sessionId,
      reviewerRole,
      decision,
      comments,
      evidenceVersion: options.evidenceVersion ?? null,
    });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<QualityReviewResult>(
        connection,
        options.idempotencyKey,
        requestHash,
        "handoff_review",
      );
      if (replay) return replay;
      const task = this.quality.getTask(
        connection,
        sessionRow.project_id,
        sessionRow.task_id,
      );
      const nextTask = this.applyReviewTaskTransition(
        connection,
        task,
        decision,
      );
      const reviewId = newObjectId("quality_review");
      const review = {
        id: reviewId,
        projectId: sessionRow.project_id,
        taskId: task.id,
        sessionId,
        handoffId: sessionRow.handoff_id,
        artifactVersionId: null,
        decision,
        comments: comments.trim() || "Review 通过",
        reviewerRole,
        reviewerId: options.reviewerId ?? reviewerRole,
        evidenceVersion: options.evidenceVersion ?? null,
        taskVersion: task.version,
        reworkTaskId: decision === "changes_requested" ? task.id : null,
        createdAt: utcNow(),
        decidedAt: utcNow(),
        traceId: options.traceId,
        idempotencyKey: options.idempotencyKey,
      };
      this.quality.createQualityReview(connection, review);
      this.traces.create(connection, {
        id: newObjectId("trace_link"),
        projectId: sessionRow.project_id,
        sourceType: "task",
        sourceId: task.id,
        targetType: "quality_review",
        targetId: reviewId,
        relation: "reviewed_as",
        traceId: options.traceId,
        createdAt: utcNow(),
        version: 1,
      });
      this.appendQualityEvent(
        connection,
        "review",
        reviewId,
        sessionRow.project_id,
        "QualityReviewRecorded",
        {
          projectId: sessionRow.project_id,
          taskId: task.id,
          sessionId,
          handoffId: sessionRow.handoff_id,
          decision,
          reworkTaskId: review.reworkTaskId,
        },
        reviewerRole,
        options.reviewerId ?? reviewerRole,
        options.traceId,
      );
      const result: QualityReviewResult = {
        reviewId,
        decision,
        baselineVersionId: decision === "approved" ? reviewId : null,
        reworkTaskId: review.reworkTaskId,
        task: nextTask,
        traceId: options.traceId,
      };
      this.saveIdempotency(
        connection,
        sessionRow.project_id,
        options.idempotencyKey,
        requestHash,
        "handoff_review",
        result,
      );
      return result;
    });
  }

  /** API 重试时读取已提交的 Handoff Review，避免 Harness 已完成后重复执行 Review。 */
  getHandoffReviewReplay(idempotencyKey: string): QualityReviewResult | null {
    const row = this.database.connection
      .prepare(
        "SELECT operation,response_json FROM quality_idempotency WHERE idempotency_key=?",
      )
      .get(idempotencyKey) as
      | { operation: string; response_json: string }
      | undefined;
    if (!row || row.operation !== "handoff_review") return null;
    return JSON.parse(row.response_json) as QualityReviewResult;
  }

  /** 创建测试策略；没有策略或未 Review 基线时不能创建可执行测试。 */
  createTestStrategy(
    projectId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): TestStrategyRecord {
    this.assertRole(actorRole, QUALITY_ROLES.testLead);
    const input = assertQualityInput<TestStrategyInput>(
      TestStrategySchema,
      rawInput,
      "测试策略请求",
    );
    if (input.ownerRole !== actorRole)
      throw new PolicyDeniedError("测试策略 ownerRole 必须与提交的测试组长一致");
    assertSafeData(input.environment);
    const requestHash = hashInput({ projectId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<TestStrategyRecord>(
        connection,
        input.idempotencyKey,
        requestHash,
        "test_strategy",
      );
      if (replay) return replay;
      const specs = this.listSpecs(connection, projectId);
      const reviewedTaskCount = (
        connection
          .prepare(
            "SELECT COUNT(DISTINCT task_id) AS count FROM quality_reviews WHERE project_id=? AND decision='approved' AND task_id IN (SELECT DISTINCT task_id FROM task_quality_specs WHERE project_id=?)",
          )
          .get(projectId, projectId) as { count: number }
      ).count;
      if (specs.length === 0 || reviewedTaskCount < new Set(specs.map((spec) => spec.taskId)).size)
        throw new WorkflowGuardBlockedError(
          "所有拆解任务必须先通过开发代表 Review，才能创建测试策略",
        );
      const required = unique(specs.flatMap((spec) => spec.acceptanceCriteriaRefs));
      ensureSubset(input.acceptanceCriteriaRefs, required, "测试策略验收标准");
      const strategy: TestStrategyRecord = {
        id: newObjectId("test_strategy"),
        projectId,
        title: input.title,
        scope: input.scope,
        acceptanceCriteriaRefs: unique(input.acceptanceCriteriaRefs),
        testTypes: unique(input.testTypes),
        environment: input.environment,
        ownerRole: actorRole,
        status: "draft",
        createdAt: utcNow(),
        version: 1,
      };
      this.quality.createTestStrategy(connection, strategy);
      this.appendQualityEvent(
        connection,
        "test_strategy",
        strategy.id,
        projectId,
        "TestStrategyCreated",
        {
          projectId,
          strategyId: strategy.id,
          acceptanceCriteriaRefs: strategy.acceptanceCriteriaRefs,
          testTypes: strategy.testTypes,
        },
        actorRole,
        actorId,
        input.traceId,
      );
      this.saveIdempotency(
        connection,
        projectId,
        input.idempotencyKey,
        requestHash,
        "test_strategy",
        strategy,
      );
      return strategy;
    });
  }

  /** 创建测试用例并更新策略覆盖状态；未覆盖标准的策略不能进入执行。 */
  createTestCase(
    strategyId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): TestCase {
    this.assertRole(actorRole, QUALITY_ROLES.testLead);
    const input = assertQualityInput<TestCaseInput>(
      TestCaseInputSchema,
      rawInput,
      "测试用例请求",
    );
    if (!isTesterRole(input.ownerRole))
      throw new PolicyDeniedError("测试用例负责人必须是测试角色");
    const strategy = this.database.connection
      .prepare("SELECT project_id FROM test_strategies WHERE id=?")
      .get(strategyId) as { project_id: string } | undefined;
    if (!strategy) throw new NotFoundError("测试策略不存在");
    ensureSubset(
      input.acceptanceCriteriaRefs,
      this.quality.getTestStrategy(
        this.database.connection,
        strategy.project_id,
        strategyId,
      ).acceptanceCriteriaRefs,
      "测试用例验收标准",
    );
    const requestHash = hashInput({ strategyId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<TestCase>(
        connection,
        input.idempotencyKey,
        requestHash,
        "test_case",
      );
      if (replay) return replay;
      const currentStrategy = this.quality.getTestStrategy(
        connection,
        strategy.project_id,
        strategyId,
      );
      const taskId = this.findTaskForCriteria(
        connection,
        strategy.project_id,
        input.acceptanceCriteriaRefs,
      );
      const testCase: TestCase = {
        id: newObjectId("test_case"),
        projectId: strategy.project_id,
        taskId,
        acceptanceCriteria: [...input.acceptanceCriteriaRefs],
        preconditions: [...input.preconditions],
        steps: [...input.steps],
        expectedResult: input.expectedResult,
        testType: input.testType,
        ownerRole: input.ownerRole,
        strategyId,
        createdAt: utcNow(),
        version: 1,
      };
      this.evidence.createTestCase(connection, testCase);
      for (const criterion of input.acceptanceCriteriaRefs) {
        this.traces.create(connection, {
          id: newObjectId("trace_link"),
          projectId: strategy.project_id,
          sourceType: "acceptance_criterion",
          sourceId: criterion,
          targetType: "test_case",
          targetId: testCase.id,
          relation: "verified_by",
          traceId: input.traceId,
          createdAt: utcNow(),
          version: 1,
        });
      }
      const allCases = this.quality.listTestCasesForStrategy(
        connection,
        strategy.project_id,
        strategyId,
      );
      const covered = new Set(
        allCases.flatMap((item) => item.acceptanceCriteria),
      );
      const strategyStatus = currentStrategy.acceptanceCriteriaRefs.every(
        (criterion) => covered.has(criterion),
      )
        ? "ready"
        : "draft";
      const strategyUpdate = connection
        .prepare("UPDATE test_strategies SET status=?,version=version+1 WHERE project_id=? AND id=? AND version=?")
        .run(strategyStatus, strategy.project_id, strategyId, currentStrategy.version);
      if (strategyUpdate.changes !== 1)
        throw new VersionConflictError("测试策略版本已变化，未覆盖并发用例结果");
      this.appendQualityEvent(
        connection,
        "test_case",
        testCase.id,
        strategy.project_id,
        "TestCaseCreated",
        {
          projectId: strategy.project_id,
          strategyId,
          testCaseId: testCase.id,
          acceptanceCriteriaRefs: input.acceptanceCriteriaRefs,
          strategyStatus,
        },
        actorRole,
        actorId,
        input.traceId,
      );
      this.saveIdempotency(
        connection,
        strategy.project_id,
        input.idempotencyKey,
        requestHash,
        "test_case",
        testCase,
      );
      return testCase;
    });
  }

  /** 执行一条真实测试结果；未通过 Review 的基线、缺少证据或异常时间均被拒绝。 */
  runTest(
    testCaseId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): TestExecutionResult {
    if (!isTesterRole(actorRole))
      throw new PolicyDeniedError("只有测试角色可以提交 TestRun");
    const input = assertQualityInput<TestRunInput>(
      TestRunInputSchema,
      rawInput,
      "测试执行请求",
    );
    assertSafeData(input.environment);
    const testCase = this.evidence.getTestCase(
      this.database.connection,
      testCaseId,
    );
    const strategyId = testCase.strategyId;
    if (!strategyId)
      throw new WorkflowGuardBlockedError("测试用例没有关联测试策略");
    const strategy = this.quality.getTestStrategy(
      this.database.connection,
      testCase.projectId,
      strategyId,
    );
    if (strategy.status !== "ready")
      throw new WorkflowGuardBlockedError(
        "测试策略尚未覆盖全部已批准验收标准，不能执行测试",
      );
    const requestHash = hashInput({ testCaseId, actorRole, actorId, input });
    const startedAt = normalizeUtc(input.startedAt);
    const endedAt = normalizeUtc(input.endedAt);
    if (new Date(endedAt) < new Date(startedAt))
      throw new InvalidArgumentError("endedAt 不能早于 startedAt");
    if (input.status === "passed" && input.exitCode !== 0)
      throw new InvalidArgumentError("passed TestRun 的 exitCode 必须为 0");
    if (input.status === "failed" && input.exitCode === 0)
      throw new InvalidArgumentError("failed TestRun 的 exitCode 不能为 0");
      const baseline = this.quality.getQualityReview(
      this.database.connection,
      testCase.projectId,
      input.baselineReviewId,
      );
    if (baseline.decision !== "approved")
      throw new WorkflowGuardBlockedError(
        "测试只能选择开发代表 Review 通过的基线",
        { data: { baselineReviewId: input.baselineReviewId } },
      );
    if (baseline.taskId !== testCase.taskId)
      throw new WorkflowGuardBlockedError(
        "测试基线 Review 与 TestCase 任务不匹配",
        { data: { baselineReviewId: input.baselineReviewId, testCaseId } },
      );
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<TestExecutionResult>(
        connection,
        input.idempotencyKey,
        requestHash,
        "test_run",
      );
      if (replay) return replay;
      const testRun: TestRun = {
        id: newObjectId("test_run"),
        projectId: testCase.projectId,
        taskId: testCase.taskId,
        testCaseId,
        baselineVersionId: null,
        baselineReviewId: baseline.id,
        commandOrSteps: input.commandOrSteps,
        environment: input.environment,
        startedAt,
        endedAt,
        actualResult: input.actualResult,
        exitCode: input.exitCode,
        status: input.status,
        evidenceVersionId: null,
        evidenceRefs: [...input.evidenceRefs],
        executedByRole: actorRole,
        traceId: input.traceId,
      };
      this.evidence.createTestRun(connection, testRun);
      this.traces.create(connection, {
        id: newObjectId("trace_link"),
        projectId: testCase.projectId,
        sourceType: "test_case",
        sourceId: testCaseId,
        targetType: "test_run",
        targetId: testRun.id,
        relation: "executed_as",
        traceId: input.traceId,
        createdAt: utcNow(),
        version: 1,
      });
      let defect: Defect | null = null;
      if (input.status === "failed") {
        defect = this.createFailedDefect(
          connection,
          testRun,
          {
            reproduction: input.commandOrSteps,
            severity: input.severity ?? "P2",
            actualResult: input.actualResult,
            expectedResult: input.expectedResult ?? testCase.expectedResult,
            evidenceRefs: input.evidenceRefs,
          },
          actorRole,
          actorId,
          input.traceId,
        );
      }
      this.appendQualityEvent(
        connection,
        "test_run",
        testRun.id,
        testCase.projectId,
        input.status === "failed" ? "TestRunFailed" : "TestRunRecorded",
        {
          projectId: testCase.projectId,
          testRunId: testRun.id,
          testCaseId,
          baselineReviewId: baseline.id,
          status: input.status,
          defectId: defect?.id ?? null,
        },
        actorRole,
        actorId,
        input.traceId,
      );
      const result: TestExecutionResult = {
        testRun,
        defect,
        traceId: input.traceId,
      };
      this.saveIdempotency(
        connection,
        testCase.projectId,
        input.idempotencyKey,
        requestHash,
        "test_run",
        result,
      );
      return result;
    });
  }

  /** 从失败 TestRun 创建缺陷；重复来源只返回既有缺陷，不重复路由 NPI。 */
  createDefectFromTestRun(
    testRunId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): Defect {
    if (!isTesterRole(actorRole) && actorRole !== QUALITY_ROLES.testLead)
      throw new PolicyDeniedError("只有测试角色可以创建缺陷");
    const input = assertQualityInput<DefectInput>(
      DefectInputSchema,
      rawInput,
      "缺陷请求",
    );
    const testRun = this.evidence.getTestRun(
      this.database.connection,
      testRunId,
    );
    if (testRun.status !== "failed")
      throw new WorkflowGuardBlockedError("只有失败 TestRun 可以创建缺陷");
    const requestHash = hashInput({ testRunId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<Defect>(
        connection,
        input.idempotencyKey,
        requestHash,
        "defect",
      );
      if (replay) return replay;
      const existing = connection
        .prepare(
          "SELECT * FROM defects WHERE project_id=? AND source_test_run_id=? ORDER BY created_at,id LIMIT 1",
        )
        .get(testRun.projectId, testRunId) as { id: string } | undefined;
      if (existing) {
        const defect = this.evidence.getDefect(connection, existing.id);
        this.saveIdempotency(
          connection,
          testRun.projectId,
          input.idempotencyKey,
          requestHash,
          "defect",
          defect,
        );
        return defect;
      }
      const defect = this.createFailedDefect(
        connection,
        testRun,
        input,
        actorRole,
        actorId,
        input.traceId,
      );
      this.saveIdempotency(
        connection,
        testRun.projectId,
        input.idempotencyKey,
        requestHash,
        "defect",
        defect,
      );
      return defect;
    });
  }

  /** 记录 NPI 复现、定位和影响分析；分析结束后缺陷保持可追踪的处理中状态。 */
  createNpiAnalysis(
    defectId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): NpiAnalysisRecordView {
    if (!isNpiRole(actorRole))
      throw new PolicyDeniedError("只有 NPI 角色可以提交缺陷分析");
    const input = assertQualityInput<NpiAnalysisInput>(
      NpiAnalysisSchema,
      rawInput,
      "NPI 分析请求",
    );
    const defect = this.findDefect(defectId);
    const requestHash = hashInput({ defectId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<NpiAnalysisRecordView>(
        connection,
        input.idempotencyKey,
        requestHash,
        "npi_analysis",
      );
      if (replay) return replay;
      const current = this.evidence.getDefect(connection, defectId);
      if (!["open", "in_analysis"].includes(current.status))
        throw new WorkflowGuardBlockedError("当前缺陷状态不允许重复提交 NPI 分析");
      const analysis = {
        id: newObjectId("npi_analysis"),
        projectId: defect.projectId,
        defectId,
        reproduction: input.reproduction,
        rootCause: input.rootCause,
        impact: input.impact,
        recommendedFix: input.recommendedFix,
        ownerRole: actorRole,
        createdAt: utcNow(),
        traceId: input.traceId,
        idempotencyKey: input.idempotencyKey,
      };
      this.quality.createNpiAnalysis(connection, analysis);
      this.traces.create(connection, {
        id: newObjectId("trace_link"),
        projectId: defect.projectId,
        sourceType: "defect",
        sourceId: defectId,
        targetType: "npi_analysis",
        targetId: analysis.id,
        relation: "analyzed_as",
        traceId: input.traceId,
        createdAt: utcNow(),
        version: 1,
      });
      const nextDefect = this.quality.updateDefect(connection, {
        projectId: defect.projectId,
        defectId,
        expectedVersion: current.version,
        status: "in_analysis",
      });
      this.appendQualityEvent(
        connection,
        "defect",
        defectId,
        defect.projectId,
        "NpiAnalysisRecorded",
        {
          projectId: defect.projectId,
          defectId,
          analysisId: analysis.id,
          status: nextDefect.status,
        },
        actorRole,
        actorId,
        input.traceId,
      );
      const result: NpiAnalysisRecordView = { ...analysis, defect: nextDefect };
      this.saveIdempotency(
        connection,
        defect.projectId,
        input.idempotencyKey,
        requestHash,
        "npi_analysis",
        result,
      );
      return result;
    });
  }

  /** 提交 NPI 修复交接；没有修复 Artifact/引用时拒绝进入待回归。 */
  submitFixRequest(
    defectId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): FixRequestView {
    if (!isNpiRole(actorRole))
      throw new PolicyDeniedError("只有 NPI 角色可以提交修复请求");
    const input = assertQualityInput<FixRequestInput>(
      FixRequestSchema,
      rawInput,
      "修复请求",
    );
    if (!input.fixedVersionId && !input.fixArtifactRef)
      throw new EvidenceIncompleteError("修复请求必须包含修复 ArtifactVersion 或证据引用");
    const defect = this.findDefect(defectId);
    const requestHash = hashInput({ defectId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<FixRequestView>(
        connection,
        input.idempotencyKey,
        requestHash,
        "fix_request",
      );
      if (replay) return replay;
      const current = this.evidence.getDefect(connection, defectId);
      if (!["open", "in_analysis", "awaiting_fix"].includes(current.status))
        throw new WorkflowGuardBlockedError("当前缺陷状态不允许提交修复");
      const request: FixRequestRecord = {
        id: newObjectId("fix_request"),
        projectId: defect.projectId,
        defectId,
        fixDescription: input.fixDescription,
        fixedVersionId: input.fixedVersionId ?? null,
        fixArtifactRef: input.fixArtifactRef ?? null,
        submittedBy: actorRole,
        status: "awaiting_regression",
        createdAt: utcNow(),
        traceId: input.traceId,
        idempotencyKey: input.idempotencyKey,
      };
      this.quality.createFixRequest(connection, request);
      this.traces.create(connection, {
        id: newObjectId("trace_link"),
        projectId: defect.projectId,
        sourceType: "defect",
        sourceId: defectId,
        targetType: "fix_request",
        targetId: request.id,
        relation: "fixed_by",
        traceId: input.traceId,
        createdAt: utcNow(),
        version: 1,
      });
      const nextDefect = this.quality.updateDefect(connection, {
        projectId: defect.projectId,
        defectId,
        expectedVersion: current.version,
        status: "awaiting_regression",
        fixedVersionId: request.fixedVersionId,
      });
      this.appendQualityEvent(
        connection,
        "defect",
        defectId,
        defect.projectId,
        "NpiFixSubmitted",
        {
          projectId: defect.projectId,
          defectId,
          fixRequestId: request.id,
          status: nextDefect.status,
        },
        actorRole,
        actorId,
        input.traceId,
      );
      const result: FixRequestView = { ...request, defect: nextDefect };
      this.saveIdempotency(
        connection,
        defect.projectId,
        input.idempotencyKey,
        requestHash,
        "fix_request",
        result,
      );
      return result;
    });
  }

  /** 发起测试回归；NPI 只能请求，不能提交通过结论。 */
  requestRegression(
    defectId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): RegressionRequestRecord {
    if (!isNpiRole(actorRole))
      throw new PolicyDeniedError("只有 NPI 角色可以发起回归请求");
    const input = assertQualityInput<RegressionRequestInput>(
      RegressionRequestSchema,
      rawInput,
      "回归请求",
    );
    const defect = this.findDefect(defectId);
    const requestHash = hashInput({ defectId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<RegressionRequestRecord>(
        connection,
        input.idempotencyKey,
        requestHash,
        "regression_request",
      );
      if (replay) return replay;
      const fixRequest = this.quality.getFixRequest(
        connection,
        defect.projectId,
        input.fixRequestId,
      );
      if (fixRequest.defectId !== defectId)
        throw new NotFoundError("修复请求不属于当前缺陷");
      const current = this.evidence.getDefect(connection, defectId);
      if (current.status !== "awaiting_regression")
        throw new WorkflowGuardBlockedError("缺陷尚未进入待回归状态");
      const request: RegressionRequestRecord = {
        id: newObjectId("regression_request"),
        projectId: defect.projectId,
        defectId,
        fixRequestId: fixRequest.id,
        testCaseId: input.testCaseId ?? null,
        scope: input.scope,
        requestedBy: actorRole,
        status: "pending",
        createdAt: utcNow(),
        traceId: input.traceId,
        idempotencyKey: input.idempotencyKey,
      };
      this.quality.createRegressionRequest(connection, request);
      this.traces.create(connection, {
        id: newObjectId("trace_link"),
        projectId: defect.projectId,
        sourceType: "fix_request",
        sourceId: fixRequest.id,
        targetType: "regression_request",
        targetId: request.id,
        relation: "verified_by",
        traceId: input.traceId,
        createdAt: utcNow(),
        version: 1,
      });
      this.appendQualityEvent(
        connection,
        "defect",
        defectId,
        defect.projectId,
        "RegressionRequested",
        {
          projectId: defect.projectId,
          defectId,
          regressionRequestId: request.id,
          fixRequestId: fixRequest.id,
        },
        actorRole,
        actorId,
        input.traceId,
      );
      this.saveIdempotency(
        connection,
        defect.projectId,
        input.idempotencyKey,
        requestHash,
        "regression_request",
        request,
      );
      return request;
    });
  }

  /** 记录真实回归结果；只有测试角色的 passed 结果可以关闭缺陷。 */
  recordRegressionResult(
    defectId: string,
    rawInput: unknown,
    actorRole: string,
    actorId = actorRole,
  ): RegressionResultView {
    if (!isTesterRole(actorRole))
      throw new PolicyDeniedError("只有测试角色可以提交回归结果");
    const input = assertQualityInput<RegressionResultInput>(
      RegressionResultSchema,
      rawInput,
      "回归结果",
    );
    const defect = this.findDefect(defectId);
    const requestHash = hashInput({ defectId, actorRole, actorId, input });
    return this.database.transaction((connection) => {
      const replay = this.replayIdempotent<RegressionResultView>(
        connection,
        input.idempotencyKey,
        requestHash,
        "regression_result",
      );
      if (replay) return replay;
      const request = this.quality.getRegressionRequest(
        connection,
        defect.projectId,
        input.regressionRequestId,
      );
      if (request.defectId !== defectId)
        throw new NotFoundError("回归请求不属于当前缺陷");
      const testRun = this.evidence.getTestRun(connection, input.testRunId);
      if (testRun.projectId !== defect.projectId)
        throw new NotFoundError("回归 TestRun 不属于当前项目");
      if (input.status !== testRun.status)
        throw new InvalidArgumentError("回归结果状态必须与 TestRun 状态一致");
      if (input.status === "passed" && !testRun.evidenceRefs?.length)
        throw new EvidenceIncompleteError("回归通过缺少真实测试证据");
      const current = this.evidence.getDefect(connection, defectId);
      if (current.status !== "awaiting_regression")
        throw new WorkflowGuardBlockedError("当前缺陷不在待回归状态");
      const result: RegressionResultRecord = {
        id: newObjectId("regression_result"),
        projectId: defect.projectId,
        defectId,
        regressionRequestId: request.id,
        testRunId: input.testRunId,
        status: input.status,
        evidenceRefs: [...input.evidenceRefs],
        actualResult: input.actualResult,
        executedByRole: actorRole,
        createdAt: utcNow(),
        traceId: input.traceId,
        idempotencyKey: input.idempotencyKey,
      };
      this.quality.createRegressionResult(connection, result);
      this.traces.create(connection, {
        id: newObjectId("trace_link"),
        projectId: defect.projectId,
        sourceType: "regression_request",
        sourceId: request.id,
        targetType: "regression_result",
        targetId: result.id,
        relation: "produced",
        traceId: input.traceId,
        createdAt: utcNow(),
        version: 1,
      });
      this.traces.create(connection, {
        id: newObjectId("trace_link"),
        projectId: defect.projectId,
        sourceType: "test_run",
        sourceId: input.testRunId,
        targetType: "regression_result",
        targetId: result.id,
        relation: "executed_as",
        traceId: input.traceId,
        createdAt: utcNow(),
        version: 1,
      });
      connection
        .prepare("UPDATE regression_requests SET status=? WHERE project_id=? AND id=?")
        .run(input.status, defect.projectId, request.id);
      const nextDefect = this.quality.updateDefect(connection, {
        projectId: defect.projectId,
        defectId,
        expectedVersion: current.version,
        status: input.status === "passed" ? "closed" : "open",
        regressionTestRunId: input.testRunId,
        resolvedAt: input.status === "passed" ? utcNow() : null,
      });
      this.appendQualityEvent(
        connection,
        "defect",
        defectId,
        defect.projectId,
        input.status === "passed" ? "DefectClosedByRegression" : "RegressionFailed",
        {
          projectId: defect.projectId,
          defectId,
          regressionRequestId: request.id,
          regressionResultId: result.id,
          status: nextDefect.status,
        },
        actorRole,
        actorId,
        input.traceId,
      );
      const response: RegressionResultView = { ...result, defect: nextDefect };
      this.saveIdempotency(
        connection,
        defect.projectId,
        input.idempotencyKey,
        requestHash,
        "regression_result",
        response,
      );
      return response;
    });
  }

  /** 返回测试范围、覆盖、真实证据、缺陷和回归状态，供测试放行门禁消费。 */
  getTestReport(projectId: string, traceId = `tr_quality_report_${Date.now()}`): TestReport {
    return this.database.transaction((connection) => {
      const specs = this.listSpecs(connection, projectId);
      const required = unique(specs.flatMap((spec) => spec.acceptanceCriteriaRefs));
      const strategies = this.listStrategies(connection, projectId);
      const cases = strategies.flatMap((strategy) =>
        this.quality.listTestCasesForStrategy(connection, projectId, strategy.id),
      );
      const covered = new Set(cases.flatMap((item) => item.acceptanceCriteria));
      const runs = this.quality.listTestRuns(connection, projectId);
      const defects = this.quality.listDefects(connection, projectId);
      const regressionRows = connection
        .prepare("SELECT status FROM regression_results WHERE project_id=?")
        .all(projectId) as { status: string }[];
      const approvedReviewCount = (
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM quality_reviews WHERE project_id=? AND decision='approved'",
          )
          .get(projectId) as { count: number }
      ).count;
      const missing = required.filter((criterion) => !covered.has(criterion));
      const evidenceComplete = runs.every(
        (run) => Boolean(run.commandOrSteps && run.startedAt && run.endedAt && run.evidenceRefs?.length),
      );
      const latestRuns = [...new Map(runs.map((run) => [run.testCaseId, run])).values()];
      const latestRunsPassed =
        latestRuns.length === cases.length &&
        latestRuns.every((run) => run.status === "passed") &&
        latestRuns.every(
          (run) => Boolean(run.commandOrSteps && run.startedAt && run.endedAt && run.evidenceRefs?.length),
        );
      const blocking = defects.filter(
        (defect) =>
          ["P0", "P1"].includes(defect.severity) &&
          !["closed", "resolved"].includes(defect.status),
      ).length;
      const open = defects.filter(
        (defect) => !["closed", "resolved"].includes(defect.status),
      ).length;
      const releaseAllowed =
        required.length > 0 &&
        missing.length === 0 &&
        runs.length > 0 &&
        latestRunsPassed &&
        evidenceComplete &&
        blocking === 0 &&
        open === 0;
      return {
        projectId,
        strategyIds: strategies.map((strategy) => strategy.id),
        acceptanceCriteria: {
          total: required.length,
          covered: required.length - missing.length,
          missing,
        },
        testRuns: {
          total: runs.length,
          passed: runs.filter((run) => run.status === "passed").length,
          failed: runs.filter((run) => run.status === "failed").length,
          blocked: runs.filter((run) => run.status === "blocked").length,
          evidenceComplete,
        },
        defects: {
          total: defects.length,
          open,
          blocking,
          regressionPassed: regressionRows.filter((row) => row.status === "passed").length,
          regressionFailed: regressionRows.filter((row) => row.status !== "passed").length,
        },
        approvedReviewCount,
        releaseAllowed,
        releaseRecommendation: releaseAllowed
          ? "测试范围、真实证据和缺陷回归均满足放行条件"
          : "补齐 Review 基线、验收覆盖、真实测试证据并关闭阻断性缺陷",
        traceId,
      };
    });
  }

  /** 将失败测试转换为完整 Defect，并在同一事务建立 TestRun → Defect 追踪。 */
  private createFailedDefect(
    connection: BetterSqlite3.Database,
    testRun: TestRun,
    input: {
      reproduction: string;
      severity: "P0" | "P1" | "P2" | "P3";
      actualResult: string;
      expectedResult: string;
      evidenceRefs: string[];
    },
    actorRole: string,
    actorId: string,
    traceId: string,
  ): Defect {
    const defect: Defect = {
      id: newObjectId("defect"),
      projectId: testRun.projectId,
      taskId: testRun.taskId,
      sourceTestRunId: testRun.id,
      reproduction: input.reproduction,
      severity: input.severity,
      actualResult: input.actualResult,
      expectedResult: input.expectedResult,
      evidenceVersionId: null,
      npiOwnerRole: "npi_lead",
      status: "open",
      fixedVersionId: null,
      regressionTestRunId: null,
      createdAt: utcNow(),
      resolvedAt: null,
      version: 1,
    };
    this.evidence.createDefect(connection, defect);
    this.traces.create(connection, {
      id: newObjectId("trace_link"),
      projectId: testRun.projectId,
      sourceType: "test_run",
      sourceId: testRun.id,
      targetType: "defect",
      targetId: defect.id,
      relation: "found",
      traceId,
      createdAt: utcNow(),
      version: 1,
    });
    this.appendQualityEvent(
      connection,
      "defect",
      defect.id,
      testRun.projectId,
      "DefectCreatedFromTestFailure",
      {
        projectId: testRun.projectId,
        defectId: defect.id,
        sourceTestRunId: testRun.id,
        severity: defect.severity,
        evidenceRefs: input.evidenceRefs,
      },
      actorRole,
      actorId,
      traceId,
    );
    return defect;
  }

  /** 读取缺陷并固定项目范围。 */
  private findDefect(defectId: string): Defect {
    return this.evidence.getDefect(this.database.connection, defectId);
  }

  /** 返回同一幂等请求的历史结果，冲突请求不会重复写入业务事实。 */
  private replayIdempotent<T>(
    connection: BetterSqlite3.Database,
    key: string,
    requestHash: string,
    operation: string,
  ): T | null {
    const existing = this.quality.getIdempotency(connection, key);
    if (!existing) return null;
    if (existing.operation !== operation || existing.requestHash !== requestHash)
      throw new IdempotencyKeyReusedError("质量动作幂等键已被其他请求使用", {
        data: { operation, idempotencyKey: key },
      });
    return existing.response as T;
  }

  /** 保存应用服务返回值；响应和业务事实必须在同一事务内提交。 */
  private saveIdempotency(
    connection: BetterSqlite3.Database,
    projectId: string,
    key: string,
    requestHash: string,
    operation: string,
    response: unknown,
  ): void {
    this.quality.saveIdempotency(connection, {
      id: newObjectId("quality_idempotency"),
      projectId,
      operation,
      idempotencyKey: key,
      requestHash,
      response: response as Record<string, unknown>,
      createdAt: utcNow(),
    });
  }

  /** 追加质量领域事件和 Outbox；失败事实不覆盖历史事件。 */
  private appendQualityEvent(
    connection: BetterSqlite3.Database,
    aggregateType: string,
    aggregateId: string,
    projectId: string,
    eventType: string,
    payload: Record<string, unknown>,
    actorRole: string,
    actorId: string,
    traceId: string,
  ): void {
    const expectedVersion = this.events.countForAggregate(
      connection,
      aggregateType,
      aggregateId,
    );
    this.events.append(
      connection,
      aggregateType,
      aggregateId,
      expectedVersion,
      [
        {
          eventType,
          aggregateType,
          aggregateId,
          payload: { projectId, ...payload },
          inputSummary: { projectId, aggregateType, aggregateId, actorRole },
          outputSummary: {
            eventType,
            result: eventType.includes("Failed") ? "failed" : "success",
          },
          result: eventType.includes("Failed") ? "failed" : "success",
          failure: eventType.includes("Failed") ? "quality_failure" : null,
          retryCount: 0,
          durationMs: 0,
          actor: { type: "role", id: actorId },
          traceId,
          occurredAt: utcNow(),
          attemptId: null,
          rejectionReason: null,
          redactionReason: "质量事件只保存结构化摘要",
          eventCategory: "ordinary",
        },
      ],
    );
  }
}

/** Handoff JSON 的最小安全投影；完整模型推理和凭据不会被质量服务读取或保存。 */
type HandoffProjection = {
  summary: string;
  diffRef: string;
  changedFiles: string[];
  verificationRuns: string[];
  commands: string[];
  traceId: string;
  remainingRisks: string[] | null;
  knownFailures: string[] | null;
  rollbackValid: boolean;
};
type HandoffRow = {
  project_id: string;
  task_id: string;
  spec_json: string;
  package_json: string;
};
type SessionHandoffRow = {
  project_id: string;
  task_id: string;
  handoff_id: string;
};
export type NpiAnalysisRecordView = Record<string, unknown> & { defect: Defect };
export type FixRequestView = FixRequestRecord & { defect: Defect };
export type RegressionResultView = RegressionResultRecord & { defect: Defect };

/** 校验并投影编码 Handoff，未知字段被忽略而关键字段缺失会阻断 Review。 */
function parseHandoff(value: string): HandoffProjection {
  const raw = JSON.parse(value) as Record<string, unknown>;
  return {
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    diffRef: typeof raw.diffRef === "string" ? raw.diffRef.trim() : "",
    changedFiles: stringArray(raw.changedFiles),
    verificationRuns: stringArray(raw.verificationRuns),
    commands: stringArray(raw.commands),
    traceId: typeof raw.traceId === "string" ? raw.traceId.trim() : "",
    remainingRisks: stringArrayOrNull(raw.remainingRisks),
    knownFailures: stringArrayOrNull(raw.knownFailures),
    rollbackValid: isValidRollback(raw.rollback),
  };
}

/** 读取编码规格中的验收标准；JSON 合法但字段缺失时仍按证据缺失处理。 */
function parseCodingSpec(value: string): { acceptanceCriteria: string[] } {
  const raw = JSON.parse(value) as Record<string, unknown>;
  return { acceptanceCriteria: stringArray(raw.acceptanceCriteria) };
}

/** 将非字符串数组归一为空数组，交由完整性检查给出稳定缺失字段。 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

/** 区分 Handoff 中明确提供的空列表和完全缺失的风险/失败字段。 */
function stringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) ? stringArray(value) : null;
}

/** 校验回滚快照字段存在，避免 Review 通过后无法恢复工作区。 */
function isValidRollback(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rollback = value as Record<string, unknown>;
  return (
    typeof rollback.workspaceSnapshot === "string" &&
    rollback.workspaceSnapshot.trim().length > 0 &&
    Array.isArray(rollback.patchSeq) &&
    rollback.patchSeq.every((item) => Number.isInteger(item) && item >= 0)
  );
}

/** 生成默认三专业拆解，固定模板只用于没有自定义拆解的开发代表请求。 */
function defaultDecomposedTasks(
  input: TaskDecompositionInput,
): DecomposedTaskInput[] {
  return [
    {
      title: "前端交付任务",
      goal: "实现用户可见界面和交互验收",
      professionalTag: "frontend",
      assigneeRole: "frontend_developer",
      priority: "P1",
      dependencies: [],
      expectedArtifactTypes: ["code_change", "self_test"],
      acceptanceCriteriaRefs: [...input.acceptanceCriteria],
      workspacePolicy: "frontend-default",
      verificationProfile: "frontend-default",
      stackProfile: "react-ts-vite",
      baselineCommit: "approved-prd-baseline",
    },
    {
      title: "后端交付任务",
      goal: "实现控制面接口和持久化业务规则",
      professionalTag: "backend",
      assigneeRole: "backend_developer",
      priority: "P1",
      dependencies: [],
      expectedArtifactTypes: ["code_change", "self_test"],
      acceptanceCriteriaRefs: [...input.acceptanceCriteria],
      workspacePolicy: "backend-default",
      verificationProfile: "backend-default",
      stackProfile: "node-fastify-ts",
      baselineCommit: "approved-prd-baseline",
    },
    {
      title: "集成验证任务",
      goal: "完成跨模块集成和接口协作验证",
      professionalTag: "integration",
      assigneeRole: "integration_developer",
      priority: "P2",
      dependencies: [],
      expectedArtifactTypes: ["integration_change", "self_test"],
      acceptanceCriteriaRefs: [...input.acceptanceCriteria],
      workspacePolicy: "integration-default",
      verificationProfile: "backend-default",
      stackProfile: "node-fastify-ts",
      baselineCommit: "approved-prd-baseline",
    },
  ];
}

/** 固定排序键生成质量命令指纹，确保同一幂等键不能被不同 payload 重放。 */
function hashInput(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortValue(value)))
    .digest("hex");
}

/** 将对象键排序，避免同义 JSON 字段顺序造成错误的幂等冲突。 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  return value;
}

/** 去重并保持首次出现顺序，保证报告和事件的可读性。 */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** 确认子集关系，防止任务或用例引用未批准验收标准。 */
function ensureSubset(values: string[], allowed: string[], name: string): void {
  const allowedSet = new Set(allowed);
  const invalid = values.filter((value) => !allowedSet.has(value));
  if (invalid.length > 0)
    throw new InvalidArgumentError(`${name} 含有未批准引用`, {
      data: { invalid },
    });
}
