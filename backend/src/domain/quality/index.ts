import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { assertSafeData } from "../common.js";
import { InvalidArgumentError } from "../errors.js";

/** Task 8 允许的测试类型，保持测试策略、用例和报告使用同一组值。 */
export const QUALITY_TEST_TYPES = [
  "functional",
  "boundary",
  "integration",
  "regression",
] as const;

/** Task 8 允许的质量对象状态，状态变化由 QualityFlowService 统一控制。 */
export const QUALITY_STATUSES = [
  "draft",
  "ready",
  "passed",
  "failed",
  "blocked",
  "open",
  "in_analysis",
  "awaiting_fix",
  "awaiting_regression",
  "closed",
  "resolved",
] as const;

/** 开发代表创建任务拆解时的单个专业任务输入合同。 */
export const DecomposedTaskInputSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 240 }),
  goal: Type.String({ minLength: 1, maxLength: 4000 }),
  professionalTag: Type.String({ minLength: 1, maxLength: 128 }),
  assigneeRole: Type.String({ minLength: 1, maxLength: 128 }),
  priority: Type.Union([
    Type.Literal("P0"),
    Type.Literal("P1"),
    Type.Literal("P2"),
    Type.Literal("P3"),
  ]),
  dependencies: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: 50,
  }),
  expectedArtifactTypes: Type.Array(
    Type.String({ minLength: 1, maxLength: 128 }),
    { minItems: 1, maxItems: 20 },
  ),
  acceptanceCriteriaRefs: Type.Array(
    Type.String({ minLength: 1, maxLength: 128 }),
    { minItems: 1, maxItems: 50 },
  ),
  workspacePolicy: Type.String({ minLength: 1, maxLength: 128 }),
  verificationProfile: Type.String({ minLength: 1, maxLength: 128 }),
  stackProfile: Type.String({ minLength: 1, maxLength: 128 }),
  baselineCommit: Type.String({ minLength: 1, maxLength: 256 }),
});

/** 已批准需求到开发任务的拆解请求合同。 */
export const TaskDecompositionSchema = Type.Object({
  approvedRequirementRefs: Type.Array(
    Type.String({ minLength: 1, maxLength: 128 }),
    { minItems: 1, maxItems: 100 },
  ),
  acceptanceCriteria: Type.Array(
    Type.String({ minLength: 1, maxLength: 128 }),
    { minItems: 1, maxItems: 100 },
  ),
  tasks: Type.Optional(
    Type.Array(DecomposedTaskInputSchema, { minItems: 3, maxItems: 50 }),
  ),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** 测试策略请求合同；策略必须先于测试用例存在。 */
export const TestStrategySchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 240 }),
  scope: Type.String({ minLength: 1, maxLength: 4000 }),
  acceptanceCriteriaRefs: Type.Array(
    Type.String({ minLength: 1, maxLength: 128 }),
    { minItems: 1, maxItems: 100 },
  ),
  testTypes: Type.Array(
    Type.Union(QUALITY_TEST_TYPES.map((value) => Type.Literal(value))),
    { minItems: 1, maxItems: QUALITY_TEST_TYPES.length },
  ),
  environment: Type.Record(Type.String({ maxLength: 128 }), Type.Unknown()),
  ownerRole: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** 测试用例请求合同；每个用例至少覆盖一条已批准验收标准。 */
export const TestCaseInputSchema = Type.Object({
  acceptanceCriteriaRefs: Type.Array(
    Type.String({ minLength: 1, maxLength: 128 }),
    { minItems: 1, maxItems: 50 },
  ),
  preconditions: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
    minItems: 1,
    maxItems: 50,
  }),
  steps: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
    minItems: 1,
    maxItems: 100,
  }),
  expectedResult: Type.String({ minLength: 1, maxLength: 4000 }),
  testType: Type.Union(QUALITY_TEST_TYPES.map((value) => Type.Literal(value))),
  ownerRole: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** 真实测试执行结果合同；证据引用由执行者提交，服务不接受模型自述替代证据。 */
export const TestRunInputSchema = Type.Object({
  baselineReviewId: Type.String({ minLength: 1, maxLength: 128 }),
  commandOrSteps: Type.String({ minLength: 1, maxLength: 4000 }),
  environment: Type.Record(Type.String({ maxLength: 128 }), Type.Unknown()),
  startedAt: Type.String({ minLength: 1, maxLength: 64 }),
  endedAt: Type.String({ minLength: 1, maxLength: 64 }),
  actualResult: Type.String({ minLength: 1, maxLength: 10000 }),
  expectedResult: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  status: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("blocked"),
  ]),
  severity: Type.Optional(
    Type.Union([
      Type.Literal("P0"),
      Type.Literal("P1"),
      Type.Literal("P2"),
      Type.Literal("P3"),
    ]),
  ),
  evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 50,
  }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** 手工创建缺陷的合同；正常失败 TestRun 会自动走同一持久化路径。 */
export const DefectInputSchema = Type.Object({
  reproduction: Type.String({ minLength: 1, maxLength: 8000 }),
  severity: Type.Union([
    Type.Literal("P0"),
    Type.Literal("P1"),
    Type.Literal("P2"),
    Type.Literal("P3"),
  ]),
  actualResult: Type.String({ minLength: 1, maxLength: 10000 }),
  expectedResult: Type.String({ minLength: 1, maxLength: 4000 }),
  evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 50,
  }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** NPI 缺陷分析合同；分析不能直接关闭缺陷。 */
export const NpiAnalysisSchema = Type.Object({
  reproduction: Type.String({ minLength: 1, maxLength: 8000 }),
  rootCause: Type.String({ minLength: 1, maxLength: 8000 }),
  impact: Type.String({ minLength: 1, maxLength: 4000 }),
  recommendedFix: Type.String({ minLength: 1, maxLength: 8000 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** NPI 修复交接合同；修复后只允许进入待回归。 */
export const FixRequestSchema = Type.Object({
  fixDescription: Type.String({ minLength: 1, maxLength: 8000 }),
  fixedVersionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  fixArtifactRef: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** 回归请求合同；只有 NPI 责任角色可以发起，不能伪造测试结果。 */
export const RegressionRequestSchema = Type.Object({
  fixRequestId: Type.String({ minLength: 1, maxLength: 128 }),
  scope: Type.String({ minLength: 1, maxLength: 4000 }),
  testCaseId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** 测试角色提交的真实回归合同；只有 passed 且有证据才能关闭缺陷。 */
export const RegressionResultSchema = Type.Object({
  regressionRequestId: Type.String({ minLength: 1, maxLength: 128 }),
  testRunId: Type.String({ minLength: 1, maxLength: 128 }),
  status: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("blocked"),
  ]),
  evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 50,
  }),
  actualResult: Type.String({ minLength: 1, maxLength: 10000 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

export type DecomposedTaskInput = Static<typeof DecomposedTaskInputSchema>;
export type TaskDecompositionInput = Static<typeof TaskDecompositionSchema>;
export type TestStrategyInput = Static<typeof TestStrategySchema>;
export type TestCaseInput = Static<typeof TestCaseInputSchema>;
export type TestRunInput = Static<typeof TestRunInputSchema>;
export type DefectInput = Static<typeof DefectInputSchema>;
export type NpiAnalysisInput = Static<typeof NpiAnalysisSchema>;
export type FixRequestInput = Static<typeof FixRequestSchema>;
export type RegressionRequestInput = Static<typeof RegressionRequestSchema>;
export type RegressionResultInput = Static<typeof RegressionResultSchema>;

/** 运行 TypeBox 合同并把所有外部畸形输入转换为稳定的领域错误。 */
export function assertQualityInput<T>(
  schema: unknown,
  input: unknown,
  name: string,
): T {
  if (!Value.Check(schema as never, input)) {
    throw new InvalidArgumentError(`${name} 结构不完整或字段类型无效`);
  }
  try {
    assertSafeData(input);
  } catch (_error) {
    throw new InvalidArgumentError(`${name} 包含敏感信息或不安全摘要`);
  }
  return input as T;
}

/** 固定质量角色，防止客户端通过自由字符串扩大 Review、测试或回归权限。 */
export const QUALITY_ROLES = {
  developerRepresentative: "developer_representative",
  testLead: "test_lead",
  testers: [
    "functional_tester",
    "edge_tester",
    "integration_tester",
    "regression_tester",
  ],
  npi: [
    "npi_lead",
    "defect_analyst",
    "frontend_fixer",
    "backend_fixer",
    "regression_coordinator",
  ],
} as const;

/** 判断调用角色是否属于测试执行角色。 */
export function isTesterRole(role: string): boolean {
  return (QUALITY_ROLES.testers as readonly string[]).includes(role);
}

/** 判断调用角色是否属于 NPI 分析、修复或回归协调角色。 */
export function isNpiRole(role: string): boolean {
  return (QUALITY_ROLES.npi as readonly string[]).includes(role);
}
