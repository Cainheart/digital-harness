import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { InvalidArgumentError, WorkflowGuardBlockedError } from "../errors.js";

/** NativeCodingHarness 可以产生的受控工具集合；不存在任意 shell 工具。 */
export const CODING_TOOLS = [
  "repo_scan",
  "read_file",
  "search_code",
  "apply_patch",
  "run_verification",
  "save_evidence",
] as const;

/** 结构化任务规格的 TypeBox 合同，外部输入必须先通过该合同。 */
export const CodingTaskSpecSchema = Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 128 }),
  projectId: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 240 }),
  goal: Type.String({ minLength: 1, maxLength: 4000 }),
  acceptanceCriteria: Type.Array(
    Type.String({ minLength: 1, maxLength: 1000 }),
    {
      minItems: 1,
      maxItems: 50,
    },
  ),
  workspaceRoot: Type.String({ minLength: 1, maxLength: 512 }),
  baselineCommit: Type.String({ minLength: 1, maxLength: 256 }),
  allowedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 200,
  }),
  forbiddenPaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    maxItems: 200,
  }),
  stackProfile: Type.String({ minLength: 1, maxLength: 128 }),
  verificationProfile: Type.String({ minLength: 1, maxLength: 128 }),
  riskPolicy: Type.Union([
    Type.Literal("standard"),
    Type.Literal("elevated"),
    Type.Literal("restricted"),
  ]),
  taskVersion: Type.Integer({ minimum: 1 }),
});

/** Worker 每次动作使用的授权合同；路径和命令授权均为最小集合。 */
export const CodingExecutionGrantSchema = Type.Object({
  grantId: Type.String({ minLength: 1, maxLength: 128 }),
  projectId: Type.String({ minLength: 1, maxLength: 128 }),
  taskId: Type.String({ minLength: 1, maxLength: 128 }),
  attemptId: Type.String({ minLength: 1, maxLength: 128 }),
  role: Type.String({ minLength: 1, maxLength: 128 }),
  roleVersion: Type.Integer({ minimum: 1 }),
  taskVersion: Type.Integer({ minimum: 1 }),
  modelConfigVersion: Type.Integer({ minimum: 0 }),
  modelProvider: Type.String({ minLength: 1, maxLength: 64 }),
  modelName: Type.String({ minLength: 1, maxLength: 128 }),
  workspaceGrant: Type.Object({
    root: Type.String({ minLength: 1, maxLength: 512 }),
    read: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: 200,
    }),
    write: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      maxItems: 200,
    }),
    deny: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      maxItems: 200,
    }),
  }),
  toolPolicy: Type.Array(
    Type.Union(CODING_TOOLS.map((tool) => Type.Literal(tool))),
    {
      minItems: 1,
      maxItems: CODING_TOOLS.length,
    },
  ),
  commandPolicy: Type.Object({
    allow: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      maxItems: 50,
    }),
    network: Type.Literal("deny"),
  }),
  expiresAt: Type.String({ minLength: 1, maxLength: 64 }),
  policyVersion: Type.Integer({ minimum: 1 }),
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** 模型或测试替身可以提出的结构化动作；动作本身不代表已执行。 */
export const CodingActionSchema = Type.Object({
  actionId: Type.String({ minLength: 1, maxLength: 128 }),
  sessionId: Type.String({ minLength: 1, maxLength: 128 }),
  seq: Type.Integer({ minimum: 1 }),
  type: Type.Union(CODING_TOOLS.map((tool) => Type.Literal(tool))),
  input: Type.Record(Type.String(), Type.Unknown()),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  requiresApproval: Type.Boolean(),
});

/** 验证步骤的真实命令结果；stdout/stderr 只通过 Artifact 引用保存。 */
export const VerificationStepSchema = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 256 }),
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("blocked"),
  ]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  startedAt: Type.String({ minLength: 1, maxLength: 64 }),
  endedAt: Type.String({ minLength: 1, maxLength: 64 }),
  durationMs: Type.Integer({ minimum: 0 }),
  stdoutRef: Type.Union([
    Type.String({ minLength: 1, maxLength: 512 }),
    Type.Null(),
  ]),
  stderrRef: Type.Union([
    Type.String({ minLength: 1, maxLength: 512 }),
    Type.Null(),
  ]),
  errorCode: Type.Union([
    Type.String({ minLength: 1, maxLength: 128 }),
    Type.Null(),
  ]),
});

/** 模型 Planner 的结构化输出合同；模型不能返回任意工具调用或自然语言命令。 */
export const CodingPlanSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 4000 }),
  affectedFiles: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    maxItems: 200,
  }),
  approach: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
    minItems: 1,
    maxItems: 20,
  }),
  verificationCommands: Type.Array(
    Type.String({ minLength: 1, maxLength: 256 }),
    { minItems: 1, maxItems: 20 },
  ),
  risks: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
    maxItems: 20,
  }),
  uncertainties: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
    maxItems: 20,
  }),
  proposedActions: Type.Array(CodingActionSchema, { maxItems: 50 }),
});

/** NativeCodingHarness 的状态集合；暂停、阻塞和取消状态禁止工具动作。 */
export const CODING_SESSION_STATUSES = [
  "CREATED",
  "CONTEXT_BUILDING",
  "PLAN_READY",
  "POLICY_PENDING",
  "IMPLEMENTING",
  "VERIFYING",
  "DIAGNOSING",
  "REVIEW_REQUESTED",
  "PAUSED",
  "BLOCKED",
  "CANCELLED",
  "COMPLETED",
] as const;
export type CodingSessionStatus = (typeof CODING_SESSION_STATUSES)[number];
export type CodingTool = (typeof CODING_TOOLS)[number];
export type CodingTaskSpec = Static<typeof CodingTaskSpecSchema>;
export type CodingExecutionGrant = Static<typeof CodingExecutionGrantSchema>;
export type CodingAction = Static<typeof CodingActionSchema>;
export type VerificationStep = Static<typeof VerificationStepSchema>;
export type CodingPlanOutput = Static<typeof CodingPlanSchema>;

/** 结构化变更计划；计划通过策略前不能进入 IMPLEMENTING。 */
export type CodingPlan = {
  goal: string;
  affectedFiles: string[];
  approach: string[];
  verificationCommands: string[];
  risks: string[];
  uncertainties: string[];
  proposedActions: CodingAction[];
};

/** 工具执行事实；拒绝结果也必须形成 Observation。 */
export type CodingObservation = {
  observationId: string;
  actionId: string;
  status: "succeeded" | "failed" | "rejected";
  exitCode: number | null;
  changedFiles: Array<{ path: string; before: string; after: string }>;
  stdoutRef: string | null;
  stderrRef: string | null;
  diffRef: string | null;
  durationMs: number;
  rejectionReason: CodingRejectionReason | null;
  redactions: string[];
  traceId: string;
};

/** 工具拒绝原因固定化，策略拒绝不能被诊断器误判为代码缺陷。 */
export type CodingRejectionReason =
  | "PATH_DENIED"
  | "COMMAND_DENIED"
  | "GRANT_EXPIRED"
  | "RESOURCE_LIMIT"
  | "NETWORK_DENIED"
  | "SECRET_ACCESS_DENIED"
  | "BASE_VERSION_MISMATCH"
  | "APPROVAL_REQUIRED"
  | "SESSION_NOT_EXECUTABLE"
  | "WORKSPACE_CONFLICT";

/** 验证编排的持久化结果；每个命令都必须有真实时间、退出码和证据引用。 */
export type VerificationRun = {
  verificationId: string;
  sessionId: string;
  profile: string;
  status: "succeeded" | "failed" | "blocked";
  steps: VerificationStep[];
  failureClass: FailureClass | null;
  retryCount: number;
  traceId: string;
  createdAt: string;
  completedAt: string;
};

/** 失败分类决定是否可进入有限诊断/修复，而不是无限重试。 */
export type FailureClass =
  | "CODE_DEFECT"
  | "TEST_FLAKE"
  | "ENVIRONMENT"
  | "POLICY"
  | "CREDENTIAL"
  | "UNKNOWN";

/** 验证失败后的脱敏诊断和下一步结构化建议。 */
export type FailureDiagnosis = {
  diagnosisId: string;
  failureClass: FailureClass;
  summary: string;
  rootCauseHypothesis: string;
  nextAction: string;
  retryNumber: number;
  maxRetries: number;
  evidenceRefs: string[];
  traceId: string;
};

/** 交接给开发代表的完整包；不包含审批结果或模型隐藏推理。 */
export type HandoffPackage = {
  handoffId: string;
  sessionId: string;
  status: "review_requested" | "approved" | "changes_requested" | "blocked";
  summary: string;
  changedFiles: string[];
  diffRef: string;
  verificationRuns: string[];
  commands: string[];
  remainingRisks: string[];
  knownFailures: string[];
  rollback: { workspaceSnapshot: string; patchSeq: number[] };
  traceId: string;
};

/** 可恢复检查点中必须保留的结构化执行上下文。 */
export type CodingCheckpointState = {
  taskGoal: string;
  constraints: {
    allowedPaths: string[];
    forbiddenPaths: string[];
    riskPolicy: string;
  };
  readFiles: string[];
  changedFiles: string[];
  currentDiffSummary: string;
  commands: string[];
  failures: FailureDiagnosis[];
  verificationResults: string[];
  unresolved: string[];
  remainingRisks: string[];
  nextAction: string;
  artifactRefs: string[];
  traceId: string;
};

/** 保存会话当前投影；原始 Action/Observation/Checkpoint 另表追加保存。 */
export type CodingSession = {
  id: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  role: string;
  status: CodingSessionStatus;
  spec: CodingTaskSpec;
  grant: CodingExecutionGrant;
  plan: CodingPlan | null;
  workspacePath: string;
  baselineManifest: Record<string, string>;
  currentDiffSummary: string;
  nextAction: string;
  failureDiagnoses: FailureDiagnosis[];
  verificationIds: string[];
  patchSeq: number[];
  readFiles: string[];
  changedFiles: string[];
  version: number;
  traceId: string;
  createdAt: string;
  updatedAt: string;
};

/** 解析并拒绝缺目标、验收标准、授权或版本的任务规格。 */
export function parseCodingTaskSpec(input: unknown): CodingTaskSpec {
  if (!Value.Check(CodingTaskSpecSchema, input)) {
    throw new InvalidArgumentError("CodingTaskSpec 结构不完整或字段类型无效");
  }
  const spec = input as CodingTaskSpec;
  assertIdentifier(spec.taskId, "taskId");
  assertIdentifier(spec.projectId, "projectId");
  assertVirtualWorkspaceRoot(spec.workspaceRoot);
  assertPathPatterns(spec.allowedPaths, "allowedPaths", true);
  assertPathPatterns(spec.forbiddenPaths, "forbiddenPaths", false);
  if (spec.forbiddenPaths.some((path) => spec.allowedPaths.includes(path))) {
    throw new InvalidArgumentError("allowedPaths 与 forbiddenPaths 不能重叠");
  }
  return spec;
}

/** 解析执行授权并拒绝绝对路径、越权工具和非法时间字段。 */
export function parseCodingExecutionGrant(
  input: unknown,
): CodingExecutionGrant {
  if (!Value.Check(CodingExecutionGrantSchema, input)) {
    throw new InvalidArgumentError(
      "CodingExecutionGrant 结构不完整或字段类型无效",
    );
  }
  const grant = input as CodingExecutionGrant;
  for (const [name, value] of [
    ["grantId", grant.grantId],
    ["projectId", grant.projectId],
    ["taskId", grant.taskId],
    ["attemptId", grant.attemptId],
    ["role", grant.role],
    ["traceId", grant.traceId],
  ] as const) {
    assertIdentifier(value, name);
  }
  assertVirtualWorkspaceRoot(grant.workspaceGrant.root);
  assertPathPatterns(grant.workspaceGrant.read, "grant.read", true);
  assertPathPatterns(grant.workspaceGrant.write, "grant.write", false);
  assertPathPatterns(grant.workspaceGrant.deny, "grant.deny", false);
  if (!Number.isFinite(Date.parse(grant.expiresAt))) {
    throw new InvalidArgumentError("ExecutionGrant expiresAt 无效");
  }
  return grant;
}

/** 统一检查授权是否仍有效；过期时只能阻塞并保留工作区证据。 */
export function assertCodingGrantActive(
  grant: CodingExecutionGrant,
  now = Date.now(),
): void {
  if (Date.parse(grant.expiresAt) <= now) {
    throw new WorkflowGuardBlockedError(
      "CodingExecutionGrant 已过期，禁止继续执行",
      {
        data: { code: "GRANT_EXPIRED", attemptId: grant.attemptId },
      },
    );
  }
}

/** 约束会话状态只能按 BIMA 生命周期前进，暂停/阻塞态不能隐式执行。 */
export function assertCodingTransition(
  from: CodingSessionStatus,
  to: CodingSessionStatus,
): void {
  const allowed: Record<CodingSessionStatus, CodingSessionStatus[]> = {
    CREATED: ["CONTEXT_BUILDING", "BLOCKED", "CANCELLED"],
    CONTEXT_BUILDING: ["PLAN_READY", "BLOCKED", "PAUSED", "CANCELLED"],
    PLAN_READY: ["POLICY_PENDING", "BLOCKED", "PAUSED", "CANCELLED"],
    POLICY_PENDING: [
      "IMPLEMENTING",
      "PLAN_READY",
      "REVIEW_REQUESTED",
      "BLOCKED",
      "PAUSED",
      "CANCELLED",
    ],
    IMPLEMENTING: ["VERIFYING", "PAUSED", "CANCELLED", "BLOCKED"],
    VERIFYING: [
      "DIAGNOSING",
      "REVIEW_REQUESTED",
      "BLOCKED",
      "PAUSED",
      "CANCELLED",
    ],
    DIAGNOSING: ["IMPLEMENTING", "BLOCKED", "PAUSED", "CANCELLED"],
    REVIEW_REQUESTED: ["COMPLETED", "IMPLEMENTING", "BLOCKED", "CANCELLED"],
    PAUSED: ["IMPLEMENTING", "CANCELLED", "BLOCKED"],
    BLOCKED: ["IMPLEMENTING", "CANCELLED"],
    CANCELLED: [],
    COMPLETED: [],
  };
  if (!allowed[from].includes(to)) {
    throw new WorkflowGuardBlockedError(`编码会话不允许从 ${from} 转为 ${to}`, {
      data: { from, to },
    });
  }
}

/** 只允许任务授权路径中的相对路径，且 deny 规则优先于 allow 规则。 */
export function isCodingPathAllowed(
  path: string,
  mode: "read" | "write",
  spec: CodingTaskSpec,
  grant: CodingExecutionGrant,
): boolean {
  if (!isSafeRelativePath(path)) return false;
  const paths =
    mode === "read" ? grant.workspaceGrant.read : grant.workspaceGrant.write;
  const allowed =
    matchesAny(path, paths) &&
    matchesAny(path, mode === "read" ? spec.allowedPaths : spec.allowedPaths);
  const denied = matchesAny(path, [
    ...grant.workspaceGrant.deny,
    ...spec.forbiddenPaths,
  ]);
  return allowed && !denied;
}

/** 检查命令是否为固定验证 Profile 和 Grant 共同允许的单一命令。 */
export function isCodingCommandAllowed(
  command: string,
  allowedCommands: string[],
): boolean {
  if (!command.trim() || /[\u0000-\u001f\u007f|;&><`$]/.test(command))
    return false;
  const first = command.trim().split(/\s+/)[0] ?? "";
  return (
    allowedCommands.includes(command.trim()) || allowedCommands.includes(first)
  );
}

/** 将验证输出映射到有限失败分类，策略/授权错误永远不当作代码缺陷。 */
export function classifyFailure(input: {
  errorCode: string | null;
  exitCode: number | null;
  stderr: string;
}): FailureClass {
  if (
    input.errorCode === "COMMAND_DENIED" ||
    input.errorCode === "NETWORK_DENIED"
  )
    return "POLICY";
  if (
    input.errorCode === "CREDENTIAL_UNAVAILABLE" ||
    /credential|api key|token/i.test(input.stderr)
  )
    return "CREDENTIAL";
  if (
    input.errorCode === "RESOURCE_LIMIT" ||
    input.errorCode === "TIMEOUT" ||
    /out of memory|timed out|port .* in use/i.test(input.stderr)
  )
    return "ENVIRONMENT";
  if (/timeout|flaky|intermittent|random/i.test(input.stderr))
    return "TEST_FLAKE";
  if (input.exitCode !== 0) return "CODE_DEFECT";
  return "UNKNOWN";
}

/** 返回默认版本化验证命令；模型不能通过计划临时添加任意命令。 */
export function verificationCommands(profile: string): string[] {
  const profiles: Record<string, string[]> = {
    "frontend-default": [
      "npm run lint",
      "npm run typecheck",
      "npm test -- --run",
      "npm run build",
    ],
    "backend-default": [
      "ruff check .",
      "npm test -- --run",
      "npm run typecheck",
      "npm run db:check",
    ],
  };
  const commands = profiles[profile];
  if (!commands)
    throw new InvalidArgumentError(`未知 VerificationProfile: ${profile}`);
  return [...commands];
}

/** 将简单 glob 规则限制为工作区相对路径匹配，避免扩展到主机目录。 */
function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    if (pattern.endsWith("/**"))
      return path === normalized || path.startsWith(`${normalized}/`);
    if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  });
}

/** 校验工作区内相对路径，不允许空段、点段、反斜杠、绝对路径和控制字符。 */
function isSafeRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    !/[\\\0\u0000-\u001f\u007f]/.test(path) &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

/** 校验授权/任务路径模式只使用工作区相对路径和末尾 /**。 */
function assertPathPatterns(
  value: string[],
  name: string,
  required: boolean,
): void {
  if (required && value.length === 0)
    throw new InvalidArgumentError(`${name} 不能为空`);
  for (const pattern of value) {
    const base = pattern.endsWith("/**")
      ? pattern.slice(0, -3)
      : pattern.endsWith("*")
        ? pattern.slice(0, -1)
        : pattern;
    const wildcardIsSupported =
      pattern.endsWith("/**") || pattern.endsWith("*");
    const prefixWithoutWildcard = pattern.endsWith("/**")
      ? pattern.slice(0, -2)
      : pattern.endsWith("*")
        ? pattern.slice(0, -1)
        : pattern;
    if (
      !isSafeRelativePath(base) ||
      (pattern.includes("*") && !wildcardIsSupported) ||
      prefixWithoutWildcard.includes("*")
    ) {
      throw new InvalidArgumentError(`${name} 包含不安全路径模式`);
    }
  }
}

/** 工作区授权使用 URI，不把调用方提供的主机绝对路径当作隔离边界。 */
function assertVirtualWorkspaceRoot(value: string): void {
  if (
    !value.startsWith("workspace://") ||
    /[\\\0\u0000-\u001f\u007f]/.test(value) ||
    value.includes("..")
  ) {
    throw new InvalidArgumentError(
      "workspaceRoot 必须是安全的 workspace:// URI",
    );
  }
}

/** 标识符用于 SQL、事件和跨对象关联，拒绝控制字符和路径分隔符。 */
function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(value))
    throw new InvalidArgumentError(`${name} 不是安全标识符`);
}
