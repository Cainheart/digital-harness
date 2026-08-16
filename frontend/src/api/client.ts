import type { ReadinessView } from "../features/readiness/readiness.types";

/** API 错误的稳定展示字段；页面不得直接展示后端原始响应或日志。 */
export class ApiError extends Error {
  readonly code: string;
  readonly impact: string;
  readonly paused: boolean;
  readonly dataPreserved: boolean;
  readonly nextAction: string;
  readonly traceId: string;

  /** 保存后端错误合同，供非技术化错误卡片统一渲染。 */
  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = "ApiError";
    this.code = payload.code;
    this.impact = payload.impact;
    this.paused = payload.paused;
    this.dataPreserved = payload.dataPreserved;
    this.nextAction = payload.nextAction;
    this.traceId = payload.traceId;
  }
}

/** 前端消费的统一错误结果；未知字段不会穿透到 UI。 */
export type ApiErrorPayload = {
  code: string;
  message: string;
  impact: string;
  paused: boolean;
  dataPreserved: boolean;
  nextAction: string;
  traceId: string;
};

/** 统一查询键，SSE 只让这些键失效并重新读取后端事实。 */
export const queryKeys = {
  readiness: ["readiness"] as const,
  dashboard: (projectId: string) => ["dashboard", projectId] as const,
  tasks: (projectId: string) => ["tasks", projectId] as const,
  artifacts: (projectId: string) => ["artifacts", projectId] as const,
  events: (projectId: string) => ["events", projectId] as const,
  notifications: (projectId?: string) =>
    ["notifications", projectId ?? "all"] as const,
  models: ["models"] as const,
  archive: (filters: string) => ["archive", filters] as const,
  archiveDetail: (projectId: string) => ["archive-detail", projectId] as const,
  office: (projectId: string) => ["office", projectId] as const,
  scorecard: (projectId: string) => ["scorecard", projectId] as const,
  executions: (projectId?: string) => ["executions", projectId ?? "all"] as const,
};

/** 项目命令的统一 Boss 信封；重复点击由幂等键隔离。 */
export function bossCommand(
  expectedVersion: number,
  payload: Record<string, unknown> = {},
  idempotencyKey = `ui-${crypto.randomUUID()}`,
): Record<string, unknown> {
  return {
    commandId: `command-${crypto.randomUUID()}`,
    idempotencyKey,
    expectedVersion,
    actor: { type: "boss", id: "boss-local" },
    payload,
  };
}

/** 使用 REST Query/Command 边界读取 JSON；所有失败都转成统一 ApiError。 */
export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload: unknown = await readJson(response);
  if (!response.ok) {
    throw new ApiError(toApiError(payload, response.status));
  }
  return payload as T;
}

/** 读取运行准备事实，保留原有的严格响应校验。 */
export function getReadiness(): Promise<ReadinessView> {
  return apiRequest<ReadinessView>("/api/v1/readiness");
}

/** 查询项目看板持久化投影。 */
export function getDashboard(projectId: string): Promise<DashboardView> {
  return apiRequest<DashboardView>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/dashboard`,
  );
}

/** 查询后端生成的像素办公室投影；页面不维护第二套员工或任务状态。 */
export function getOffice(projectId: string): Promise<OfficeView> {
  return apiRequest<OfficeView>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/office`,
  );
}

/** 查询后端评分卡和硬性门槛；前端只负责展示，不计算总分。 */
export function getScorecard(projectId: string): Promise<ScorecardView> {
  return apiRequest<ScorecardView>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/scorecard`,
  );
}

/** 请求后端追加一个评分卡历史快照。 */
export function recalculateScorecard(projectId: string): Promise<ScorecardView> {
  return apiRequest<ScorecardView>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/scorecard/recalculate`,
    {
      method: "POST",
      body: JSON.stringify({ actor: { type: "boss", id: "boss-local" } }),
    },
  );
}

/** 查询分页执行尝试；模型调用账本仍通过旧的兼容接口提供明细。 */
export function getExecutionRuns(
  projectId: string,
  page = 1,
  pageSize = 20,
): Promise<ExecutionPage> {
  const search = new URLSearchParams({
    projectId,
    page: String(page),
    pageSize: String(pageSize),
  });
  return apiRequest<ExecutionPage>(`/api/v1/executions/runs?${search.toString()}`);
}

/** 查询一条真实执行的时间线、工具、测试、错误和产物索引。 */
export function getExecution(executionId: string, projectId: string): Promise<ExecutionDetail> {
  return apiRequest<ExecutionDetail>(
    `/api/v1/executions/${encodeURIComponent(executionId)}?projectId=${encodeURIComponent(projectId)}`,
  );
}

/** 创建准备中的项目；此命令不会启动模型、工作区或真实执行。 */
export function createProject(
  input: ProjectInput,
): Promise<ProjectCreateResult> {
  const envelope = bossCommand(0, {}, input.idempotencyKey);
  delete envelope.payload;
  return apiRequest<ProjectCreateResult>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      ...envelope,
      name: input.name,
      businessGoal: input.businessGoal,
      targetUsers: input.targetUsers,
      priority: input.priority,
      deadline: input.deadline,
      constraints: { known: input.constraints },
    }),
  });
}

/** 只有用户明确确认后才发送真实启动命令。 */
export function startProject(
  projectId: string,
  expectedVersion: number,
): Promise<CommandResult> {
  return apiRequest<CommandResult>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/start`,
    {
      method: "POST",
      body: JSON.stringify(
        bossCommand(
          expectedVersion,
          {},
          `start-${projectId}-${expectedVersion}`,
        ),
      ),
    },
  );
}

/** 项目控制命令统一走 expectedVersion 和 idempotencyKey。 */
export function projectCommand(
  projectId: string,
  action: "pause" | "resume",
  expectedVersion: number,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  return apiRequest<CommandResult>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/${action}`,
    {
      method: "POST",
      body: JSON.stringify(bossCommand(expectedVersion, payload)),
    },
  );
}

/** 读取终止影响预览，真正终止前不改变项目状态。 */
export function previewTermination(
  projectId: string,
  expectedVersion: number,
  reason: string,
): Promise<TerminationPreview> {
  return apiRequest<TerminationPreview>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/terminate/preview`,
    {
      method: "POST",
      body: JSON.stringify(bossCommand(expectedVersion, { reason })),
    },
  );
}

/** 使用一次性确认 token 完成项目终止。 */
export function confirmTermination(
  projectId: string,
  expectedVersion: number,
  reason: string,
  confirmationToken: string,
): Promise<CommandResult> {
  return apiRequest<CommandResult>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/terminate/confirm`,
    {
      method: "POST",
      body: JSON.stringify(
        bossCommand(expectedVersion, { reason, confirmationToken }),
      ),
    },
  );
}

/** 查询历史存档，筛选条件序列化后成为稳定 TanStack Query key。 */
export function getArchive(filters: ArchiveFilters = {}): Promise<ArchivePage> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) search.set(key, value);
  }
  const suffix = search.toString();
  return apiRequest<ArchivePage>(
    `/api/v1/archive${suffix ? `?${suffix}` : ""}`,
  );
}

/** 查询历史项目只读详情。 */
export function getArchiveDetail(projectId: string): Promise<ArchiveDetail> {
  return apiRequest<ArchiveDetail>(
    `/api/v1/archive/${encodeURIComponent(projectId)}`,
  );
}

/** 创建历史删除预览；只接受最终状态项目和 Boss actor。 */
export function previewArchiveDeletion(
  projectId: string,
  expectedVersion: number,
): Promise<ArchiveDeletionPreview> {
  return apiRequest<ArchiveDeletionPreview>(
    `/api/v1/archive/${encodeURIComponent(projectId)}/delete/preview`,
    {
      method: "POST",
      body: JSON.stringify({
        ...bossCommand(expectedVersion, {}),
        expectedVersion,
      }),
    },
  );
}

/** 完成历史删除二次确认。 */
export function confirmArchiveDeletion(
  projectId: string,
  expectedVersion: number,
  confirmationToken: string,
): Promise<ArchiveDeletionResult> {
  return apiRequest<ArchiveDeletionResult>(
    `/api/v1/archive/${encodeURIComponent(projectId)}/delete/confirm`,
    {
      method: "POST",
      body: JSON.stringify({
        ...bossCommand(expectedVersion, { confirmationToken }),
        expectedVersion,
        confirmationToken,
      }),
    },
  );
}

/** 查询五个领域的脱敏模型配置。 */
export function getModelSettings(): Promise<ModelSettingsView> {
  return apiRequest<ModelSettingsView>("/api/v1/settings/models");
}

/** 保存领域模型配置；凭据只作为密码输入发送，不进入响应类型。 */
export function updateModelSetting(
  domain: string,
  input: {
    provider: string;
    modelName: string;
    credential: string;
    expectedConfigVersion: number;
  },
): Promise<ModelSetting> {
  return apiRequest<ModelSetting>(
    `/api/v1/settings/models/${encodeURIComponent(domain)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...input,
        idempotencyKey: `model-${domain}-${input.expectedConfigVersion + 1}-${crypto.randomUUID()}`,
      }),
    },
  );
}

/** 删除领域凭据，不把 secretRef 或凭据内容暴露给页面。 */
export function deleteModelCredential(
  domain: string,
  expectedConfigVersion: number,
): Promise<ModelSetting> {
  return apiRequest<ModelSetting>(
    `/api/v1/settings/models/${encodeURIComponent(domain)}/credential`,
    {
      method: "DELETE",
      body: JSON.stringify({
        expectedConfigVersion,
        idempotencyKey: `delete-${domain}-${expectedConfigVersion}`,
      }),
    },
  );
}

/** 读取通知；打开详情不自动调用 acknowledge。 */
export function getNotifications(
  projectId?: string,
): Promise<NotificationPage> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<NotificationPage>(`/api/v1/notifications${suffix}`);
}

/** 显式标记无需业务动作的通知已阅。 */
export function acknowledgeNotification(
  notificationId: string,
  expectedVersion: number,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    `/api/v1/notifications/${encodeURIComponent(notificationId)}/acknowledge`,
    {
      method: "POST",
      body: JSON.stringify(
        bossCommand(
          expectedVersion,
          {},
          `notification-${notificationId}-${expectedVersion}`,
        ),
      ),
    },
  );
}

/** 提交 Boss 审批决定；驳回意见由后端强制非空。 */
export function decideApproval(
  approvalId: string,
  expectedVersion: number,
  decision: "approved" | "rejected",
  opinion: string,
): Promise<CommandResult> {
  return apiRequest<CommandResult>(
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify(bossCommand(expectedVersion, { decision, opinion })),
    },
  );
}

/** 读取任务详情，不允许前端自行拼接任务进度。 */
export function getTask(projectId: string, taskId: string): Promise<TaskView> {
  return apiRequest<TaskView>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
  );
}

/** 读取交付物详情及不可变版本。 */
export function getArtifact(
  projectId: string,
  artifactId: string,
): Promise<ArtifactView> {
  return apiRequest<ArtifactView>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
}

/** 读取审批详情。 */
export function getApproval(approvalId: string): Promise<ApprovalView> {
  return apiRequest<ApprovalView>(
    `/api/v1/approvals/${encodeURIComponent(approvalId)}`,
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function toApiError(payload: unknown, status: number): ApiErrorPayload {
  if (isRecord(payload)) {
    return {
      code: text(payload.code, `HTTP_${status}`),
      message: text(payload.message, "请求未完成"),
      impact: text(payload.impact, "当前操作未完成"),
      paused: payload.paused === true,
      dataPreserved: payload.dataPreserved !== false,
      nextAction: text(payload.nextAction, "请检查当前状态后重试"),
      traceId: text(payload.traceId, "未提供"),
    };
  }
  return {
    code: `HTTP_${status}`,
    message: "请求未完成",
    impact: "当前操作未完成",
    paused: true,
    dataPreserved: true,
    nextAction: "请检查当前状态后重试",
    traceId: "未提供",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** 立项命令的业务字段；不包含技术方案、成员拆解或强制成功指标。 */
export type ProjectInput = {
  name: string;
  businessGoal: string;
  targetUsers: string;
  priority: "P0" | "P1" | "P2" | "P3";
  deadline: string | null;
  constraints: string;
  idempotencyKey?: string;
};
/** 立项命令返回的准备态项目和下一步动作。 */
export type ProjectCreateResult = {
  project: ProjectView;
  allowedActions: string[];
  traceId: string;
};
/** 页面展示的项目持久化投影。 */
export type ProjectView = {
  id: string;
  name: string;
  businessGoal: string;
  targetUsers: string;
  priority: string;
  deadline: string | null;
  constraints: Record<string, unknown>;
  stage: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  version: number;
  readOnly: boolean;
};
/** 页面展示的任务事实；未知扩展字段保持只读透传。 */
export type TaskView = Record<string, unknown> & {
  id: string;
  title: string;
  status: string;
  ownerRole: string;
  version: number;
};
/** Boss 看板的完整查询投影，不由前端计算业务状态。 */
export type DashboardView = {
  project: ProjectView;
  tasks: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  notifications: Array<NotificationItem>;
  progress: Record<string, number>;
  phases: Array<{ stage: string; status: string; isCurrent: boolean }>;
  employees: Array<Record<string, unknown>>;
  risks: Array<Record<string, unknown>>;
  pause: Record<string, unknown> | null;
  latestArtifacts: Array<Record<string, unknown>>;
  latestEvents: Array<Record<string, unknown>>;
  modelSummary: Record<string, number>;
  allowedActions: string[];
  nextAction: string;
};

/** 像素办公室后端投影类型；状态字段同时带文字、图标和颜色语义。 */
export type OfficeView = {
  projectId: string;
  snapshotVersion: number;
  generatedAt: string;
  projectStatus: string;
  projectStage: string;
  projectStatusLabel: string;
  rooms: Array<{
    roomId: string;
    label: string;
    status: string;
    occupants: Array<{
      workerId: string;
      role: string;
      displayName: string;
      specialistTag: string;
      officeZone: string;
      deskGroup: string;
      status: string;
      statusLabel: string;
      statusIcon: string;
      statusColor: string;
      accessibilityLabel: string;
      taskId: string | null;
      currentActivity: string;
      waitingFor: string | null;
      lastEventId: string | null;
      updatedAt: string;
    }>;
  }>;
  activeTasks: number;
  blockedTasks: number;
  pendingApprovals: number;
  lastEventId: string | null;
};

/** 评分卡快照类型；硬性门槛独立于 overallScore。 */
export type ScorecardView = {
  snapshotId: string | null;
  projectId: string;
  scorecardVersion: number;
  ruleVersion: string;
  calculatedAt: string;
  overallScore: number | null;
  releaseStatus: string;
  dimensions: Array<{
    dimensionId: string;
    label: string;
    score: number | null;
    status: string;
    evidenceIds: string[];
    issues: string[];
    missingData: string[];
  }>;
  hardGates: Array<{
    gateId: string;
    label: string;
    status: string;
    evidenceIds: string[];
    reason: string | null;
    remediation: string | null;
  }>;
  recommendations: string[];
  sourceDataVersion: string;
};

/** 执行尝试摘要分页类型。 */
export type ExecutionPage = {
  items: Array<Record<string, unknown> & { executionId: string }>;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

/** 执行详情只保留后端脱敏摘要和证据引用，不包含凭据或宿主机绝对路径。 */
export type ExecutionDetail = Record<string, unknown> & {
  executionId: string;
  projectId: string;
  taskId: string;
  status: string;
  timeline: Array<Record<string, unknown>>;
};
/** 后端已提交命令的稳定结果，用于刷新相关 Query。 */
export type CommandResult = {
  aggregateId: string;
  version: number;
  eventId: string;
  allowedActions: string[];
  traceId: string;
};
/** 项目终止的影响预览；未确认前不改变项目事实。 */
export type TerminationPreview = {
  projectId: string;
  currentStage: string;
  currentStatus: string;
  unfinishedTasks: string[];
  impact: string;
  requiresReason: true;
  requiresSecondConfirmation: true;
  confirmationToken: string;
  expiresAt: string;
};
/** 历史存档支持的白名单筛选字段。 */
export type ArchiveFilters = {
  search?: string;
  status?: string;
  priority?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
};
/** 历史项目列表摘要和稳定分页游标。 */
export type ArchivePage = {
  items: Array<
    Record<string, unknown> & { id: string; name: string; version: number }
  >;
  nextCursor: string | null;
  hasMore: boolean;
};
/** 历史项目只读详情投影。 */
export type ArchiveDetail = Record<string, unknown> & {
  id: string;
  name: string;
  readOnly: true;
};
/** 历史删除的二次确认预览。 */
export type ArchiveDeletionPreview = {
  projectId: string;
  projectName: string;
  status: string;
  endedAt: string | null;
  deletionScope: string[];
  irreversibleWarning: string;
  requiresSecondConfirmation: true;
  confirmationToken: string;
  expiresAt: string;
};
/** 历史删除完成后的最小审计回执。 */
export type ArchiveDeletionResult = {
  projectId: string;
  deletedAt: string;
  actorId: string;
  artifactDeletion: { deletedPaths: string[]; failedPaths: string[] };
  retainedAudit: string;
};
/** 通知列表中的可展示字段和并发版本。 */
export type NotificationItem = {
  id: string;
  projectId: string;
  eventId: string;
  notificationType: string;
  severity: string;
  subjectType: string;
  subjectId: string;
  unread: boolean;
  pending: boolean;
  action: string | null;
  reasonSummary: string | null;
  traceId: string;
  createdAt: string;
  readAt: string | null;
  handledBy: string | null;
  handledAt: string | null;
  version: number;
};
/** 通知查询的分页结果。 */
export type NotificationPage = {
  items: NotificationItem[];
  nextCursor: string | null;
  hasMore: boolean;
};
/** Boss 审批详情的脱敏事实投影。 */
export type ApprovalView = Record<string, unknown> & {
  id: string;
  projectId: string;
  status: string;
  version: number;
  approvalType: string;
};
/** 五个模型领域的脱敏配置状态，绝不包含凭据正文。 */
export type ModelSetting = {
  domain: string;
  provider: string;
  modelName: string;
  configVersion: number;
  credentialStatus: "configured" | "missing";
  connectionStatus: string;
  lastErrorCode: string | null;
  updatedAt: string;
};
/** 模型设置页面的列表投影。 */
export type ModelSettingsView = { items: ModelSetting[] };
/** 交付物详情及不可变版本历史。 */
export type ArtifactView = {
  artifact: Record<string, unknown>;
  versions: Array<Record<string, unknown>>;
};
