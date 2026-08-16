import {
  assertSafeData,
  normalizeUtc,
  ProjectStatus,
  TaskStatus,
  validateJsonObject,
  validateSafeValue,
} from "./common.js";

/** 领域实体的严格基类；运行时校验拒绝额外字段和未定义时间格式。 */
export abstract class DomainModel {
  /** 校验对象拥有所有必需字段，并拒绝额外字段。 */
  static assertExact(
    input: Record<string, unknown>,
    required: string[],
    allowed: string[] = required,
  ): void {
    for (const field of required)
      if (!(field in input)) throw new Error(`${field} is required`);
    for (const field of Object.keys(input))
      if (!allowed.includes(field)) throw new Error(`extra field: ${field}`);
  }
}

/**
 * 修改日期：2026-08-16
 * 修改原因：项目名称、业务目标和摘要允许空格及中文；路径安全约束应只作用于 ID 和 relativePath，不能误伤正常领域文本。
 */
function text(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  const result = value;
  if (!result.trim()) throw new Error(`${name} must be non-empty`);
  return result;
}
/** 统一正整数/非负整数校验。 */
function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}`);
  return Number(value);
}
/** 统一时间字段校验。 */
function date(value: unknown, name: string): string {
  try {
    return normalizeUtc(String(value));
  } catch (_error) {
    throw new Error(`${name} must be timezone-aware`);
  }
}
/** 校验普通领域 JSON 摘要。 */
function json(value: unknown): Record<string, unknown> {
  return validateJsonObject(value);
}
/** 校验内容寻址摘要。 */
function sha(value: unknown): string {
  const result = text(value, "sha256");
  if (!/^[0-9a-f]{64}$/.test(result))
    throw new Error("sha256 must be 64 lowercase hexadecimal characters");
  return result;
}
/** 校验项目 Artifact Store 内的 POSIX 相对路径。 */
function relativePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("relativePath must be a string");
  }

  const result = value;
  if (
    !result ||
    result.includes("\\") ||
    result.includes("\0") ||
    result.startsWith("/") ||
    result.startsWith("~") ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("relativePath must be a safe relative POSIX path");
  return result;
}
/** 统一 ID 元组校验。 */
function tuple(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${name} must be a non-empty array`);
  return value.map((item) => text(item, name));
}
/** 校验字符串数组；依赖列表允许为空，交付物列表必须由调用方决定是否为空。 */
function stringArray(
  value: unknown,
  name: string,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be an array of strings`);
  }

  return value.map((item) => text(item, name));
}
/** 允许固定的 P0-P3 优先级。 */
function priority(value: unknown): Priority {
  if (value !== "P0" && value !== "P1" && value !== "P2" && value !== "P3")
    throw new Error("invalid priority");
  return value;
}

export type Priority = "P0" | "P1" | "P2" | "P3";

/** 保存项目目标、约束、阶段、主状态、生命周期时间和版本。 */
export type Project = {
  id: string;
  name: string;
  businessGoal: string;
  targetUsers: string;
  priority: Priority;
  deadline: string | null;
  constraints: Record<string, unknown>;
  stage: string;
  status: ProjectStatus;
  createdAt: string;
  endedAt: string | null;
  version: number;
  readOnly: boolean;
};
/** 保存项目范围内任务的负责人、依赖、交付物预期、状态和版本。 */
export type Task = {
  id: string;
  projectId: string;
  title: string;
  ownerRole: string;
  specialistTag: string;
  assignmentReason: string;
  priority: Priority;
  dependencies: string[];
  expectedDeliverables: string[];
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  version: number;
};
/** 指向 Artifact Store 内容的完整性引用，不承载文件正文。 */
export type ArtifactRef = {
  artifactId: string;
  sha256: string;
  mediaType: string;
  size: number;
  createdAt: string;
  relativePath: string;
  storeRef?: string | null;
};
/** 保存交付物逻辑对象及其项目、任务、责任人和状态。 */
export type Artifact = {
  id: string;
  projectId: string;
  taskId: string | null;
  name: string;
  artifactType: string;
  ownerRole: string;
  status: string;
  createdAt: string;
  createdBy: string;
  contentRef: ArtifactRef | null;
  upstreamLinks: string[];
  downstreamLinks: string[];
  version: number;
};
/** 保存不可覆盖的交付物版本、父版本和内容寻址元数据。 */
export type ArtifactIntegrityStatus = "unknown" | "verified" | "invalid";
/** 保存交付物版本完整性状态，只有验证流程可以更新该字段。 */
export type ArtifactVersion = {
  id: string;
  artifactId: string;
  projectId: string;
  taskId: string | null;
  version: number;
  parentVersionId: string | null;
  changeReason: string;
  contentRef: ArtifactRef;
  storeRef: string;
  createdAt: string;
  createdBy: string;
  integrityStatus: ArtifactIntegrityStatus;
};
/** 保存 Boss 审批对象、证据、决定和响应任务。 */
export type Approval = {
  id: string;
  projectId: string;
  taskId: string | null;
  approvalType: string;
  subjectType: string;
  subjectId: string;
  artifactVersionId: string | null;
  evidenceVersionId: string | null;
  decision: string | null;
  direction: string | null;
  bossId: string;
  status: string;
  responseTaskId: string | null;
  createdAt: string;
  decidedAt: string | null;
  version: number;
};
/** 保存交付物版本的 Review 决定、意见和返工关联。 */
export type Review = {
  id: string;
  projectId: string;
  taskId: string | null;
  artifactVersionId: string;
  reviewerRole: string;
  reviewerId: string;
  decision: string;
  comments: string;
  evidenceVersionId: string | null;
  reworkTaskId: string | null;
  createdAt: string;
  decidedAt: string | null;
  version: number;
};
/** 保存验收标准、步骤、预期和测试责任人。 */
export type TestCase = {
  id: string;
  projectId: string;
  taskId: string | null;
  acceptanceCriteria: string[];
  preconditions: string | string[];
  steps: string | string[];
  expectedResult: string;
  testType: string;
  ownerRole: string;
  createdAt: string;
  version: number;
};
/** 保存测试执行的基线、环境、结果、退出码和证据。 */
export type TestRun = {
  id: string;
  projectId: string;
  taskId: string | null;
  testCaseId: string;
  baselineVersionId: string | null;
  commandOrSteps: string;
  environment: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  actualResult: string;
  exitCode: number | null;
  status: string;
  evidenceVersionId: string | null;
  traceId: string;
};
/** 保存缺陷、NPI 负责人、修复版本和回归结果。 */
export type Defect = {
  id: string;
  projectId: string;
  taskId: string | null;
  sourceTestRunId: string;
  reproduction: string;
  severity: string;
  actualResult: string;
  expectedResult: string;
  evidenceVersionId: string | null;
  npiOwnerRole: string;
  status: string;
  fixedVersionId: string | null;
  regressionTestRunId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  version: number;
};
/** 保存一次任务执行尝试的租约、模型配置、重试关系和链路。 */
export type ExecutionAttempt = {
  id: string;
  projectId: string;
  taskId: string;
  role: string;
  modelConfigVersion: string;
  workspaceRef: string | null;
  workerLeaseId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  retryOfAttemptId: string | null;
  retryCount: number;
  traceId: string;
  version: number;
  /** Task 5 在 Attempt 创建时复制的模型领域和供应商快照。 */
  modelDomain?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  modelSecretRef?: string | null;
  modelTimeoutMs?: number | null;
  modelRetryMaxAttempts?: number | null;
};
/** 保存模型调用脱敏摘要、Token、成本、错误和 trace。 */
export type ModelCall = {
  id: string;
  projectId: string;
  taskId: string | null;
  executionAttemptId: string;
  role: string;
  provider: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  summary: string;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  traceId: string;
  version: number;
  /** Task 5 调用观测的领域、配置版本和嵌套 span。 */
  domain?: string;
  configVersion?: number;
  spanId?: string;
  inputSummary?: string;
  outputSummary?: string;
  timeoutMs?: number | null;
  timedOut?: boolean;
  retryCount?: number;
  artifactRef?: string | null;
  redactionStatus?: string;
  finalStatus?: string;
  totalTokens?: number | null;
};
/** 保存工具调用脱敏摘要、耗时、错误和 trace。 */
export type ToolCall = {
  id: string;
  projectId: string;
  taskId: string | null;
  executionAttemptId: string;
  role: string;
  toolName: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  summary: string;
  errorCode: string | null;
  traceId: string;
  version: number;
};
/** 保存事件通知的对象、等级、未读/待处理状态和处理时间线。 */
export type Notification = {
  id: string;
  projectId: string;
  eventId: string;
  notificationType: string;
  severity: string;
  subjectType: string;
  subjectId: string;
  unread: boolean;
  pending: boolean;
  handledBy: string | null;
  action: string | null;
  createdAt: string;
  readAt: string | null;
  handledAt: string | null;
  version: number;
};

/** TraceLink 可引用的对象类型；数据库 trigger 和领域解析共用同一集合。 */
const TRACE_NODE_TYPES = new Set([
  "requirement",
  "acceptance_criterion",
  "evidence",
  "project",
  "task",
  "artifact",
  "artifact_version",
  "approval",
  "review",
  "test_case",
  "test_run",
  "defect",
  "execution_attempt",
  "model_call",
  "tool_call",
  "notification",
  "domain_event",
  "research_grant",
  "research_run",
  "research_source",
  "research_report",
  "research_conclusion",
  "research_source_validation",
  "research_conflict",
  "product_success_metric",
  "prd_version",
  "pm_peer_review",
  "research_security_event",
]);
/** 保存跨对象双向追踪关系及其项目和 trace 范围。 */
export type TraceLink = {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation: string;
  traceId: string;
  createdAt: string;
  version: number;
};

/** 对 Project 做边界校验并返回规范化对象。 */
export function parseProject(input: Record<string, unknown>): Project {
  DomainModel.assertExact(input, [
    "id",
    "name",
    "businessGoal",
    "targetUsers",
    "priority",
    "deadline",
    "constraints",
    "stage",
    "status",
    "createdAt",
    "endedAt",
    "version",
    "readOnly",
  ]);
  return {
    id: text(input.id, "id"),
    name: text(input.name, "name"),
    businessGoal: text(input.businessGoal, "businessGoal"),
    targetUsers: text(input.targetUsers, "targetUsers"),
    priority: priority(input.priority),
    deadline: input.deadline == null ? null : date(input.deadline, "deadline"),
    constraints: json(input.constraints),
    stage: text(input.stage, "stage"),
    status: assertStatus(input.status, ProjectStatus, "project status"),
    createdAt: date(input.createdAt, "createdAt"),
    endedAt: input.endedAt == null ? null : date(input.endedAt, "endedAt"),
    version: integer(input.version, "version", 1),
    readOnly: booleanValue(input.readOnly, "readOnly"),
  };
}

/** 对 Task 做边界校验并返回规范化对象。 */
export function parseTask(input: Record<string, unknown>): Task {
  DomainModel.assertExact(input, [
    "id",
    "projectId",
    "title",
    "ownerRole",
    "specialistTag",
    "assignmentReason",
    "priority",
    "dependencies",
    "expectedDeliverables",
    "status",
    "createdAt",
    "startedAt",
    "endedAt",
    "version",
  ]);
  return {
    id: text(input.id, "id"),
    projectId: text(input.projectId, "projectId"),
    title: text(input.title, "title"),
    ownerRole: text(input.ownerRole, "ownerRole"),
    specialistTag: text(input.specialistTag, "specialistTag"),
    assignmentReason: text(input.assignmentReason, "assignmentReason"),
    priority: priority(input.priority),
    dependencies: stringArray(input.dependencies, "dependencies", true),
    expectedDeliverables: tuple(
      input.expectedDeliverables,
      "expectedDeliverables",
    ),
    status: assertStatus(input.status, TaskStatus, "task status"),
    createdAt: date(input.createdAt, "createdAt"),
    startedAt:
      input.startedAt == null ? null : date(input.startedAt, "startedAt"),
    endedAt: input.endedAt == null ? null : date(input.endedAt, "endedAt"),
    version: integer(input.version, "version", 1),
  };
}

/**
 * 修改日期：2026-08-16
 * 修改原因：mediaType 使用 MIME 类型，storeRef 使用 artifact:// 等协议引用；领域校验不能把这两个合法协议字段当作文件路径注入处理。
 */
export function parseArtifactRef(input: Record<string, unknown>): ArtifactRef {
  const mediaType = String(input.mediaType ?? input.media_type ?? "");
  if (!mediaType.trim()) throw new Error("mediaType must be non-empty");
  const storeRef = input.storeRef == null ? null : String(input.storeRef);
  if (storeRef !== null && !storeRef.trim())
    throw new Error("storeRef must be non-empty");
  return {
    artifactId: text(input.artifactId ?? input.artifact_id, "artifactId"),
    sha256: sha(input.sha256),
    mediaType,
    size: integer(input.size ?? input.sizeBytes ?? input.size_bytes, "size", 0),
    createdAt: date(input.createdAt ?? input.created_at, "createdAt"),
    relativePath: relativePath(input.relativePath ?? input.relative_path),
    storeRef,
  };
}

/** 校验 TraceLink 的多态端点类型。 */
export function parseTraceLink(input: Record<string, unknown>): TraceLink {
  const sourceType = text(input.sourceType, "sourceType");
  const targetType = text(input.targetType, "targetType");
  if (!TRACE_NODE_TYPES.has(sourceType) || !TRACE_NODE_TYPES.has(targetType))
    throw new Error("TraceLink endpoint type is unsupported");
  return {
    id: text(input.id, "id"),
    projectId: text(input.projectId, "projectId"),
    sourceType,
    sourceId: text(input.sourceId, "sourceId"),
    targetType,
    targetId: text(input.targetId, "targetId"),
    relation: text(input.relation, "relation"),
    traceId: text(input.traceId, "traceId"),
    createdAt: date(input.createdAt, "createdAt"),
    version: integer(input.version ?? 1, "version", 1),
  };
}

/** 统一检查状态枚举，不允许 API 侧产生未冻结状态。 */
function assertStatus<T extends Record<string, string>>(
  value: unknown,
  statuses: T,
  name: string,
): T[keyof T] {
  const accepted = Object.values(statuses) as string[];
  if (typeof value !== "string" || !accepted.includes(value))
    throw new Error(`invalid ${name}`);
  return value as T[keyof T];
}

/** 允许仓储使用的安全摘要校验。 */
export function assertSafeSummary(value: string): string {
  if (typeof value !== "string") {
    throw new Error("summary must be a string");
  }

  assertSafeData(value);
  return value;
}

/** 只接受真正的布尔值，避免字符串 "false" 被 Boolean() 误判为 true。 */
function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }

  return value;
}

export { TRACE_NODE_TYPES };
