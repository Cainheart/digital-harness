import { assertSafeData, normalizeUtc, validateSafeValue } from "../common.js";

/** Task 6 允许调研的 PM 角色；兼容 PRD 早期示例中的旧角色别名。 */
export const RESEARCH_ROLE_IDS = [
  "product_market_pm",
  "product_solution_pm",
  "user_market_pm",
] as const;
export type ResearchRoleId = (typeof RESEARCH_ROLE_IDS)[number];

/** 将旧设计中的 user_market_pm 映射到当前组织中的正式岗位 ID。 */
export function canonicalResearchRole(role: string): ResearchRoleId {
  if (!RESEARCH_ROLE_IDS.includes(role as ResearchRoleId)) {
    throw new Error("research grant role is not a PM role");
  }
  return role as ResearchRoleId;
}

/** ResearchGrant 的网络和证据策略是固定策略，不能由网页内容扩展。 */
export type ResearchGrant = {
  grantId: string;
  projectId: string;
  taskId: string;
  role: ResearchRoleId;
  allowedDomains: string[];
  allowedUrls: string[];
  maxPages: number;
  timeoutSeconds: number;
  evidencePolicy: "source_metadata_and_quote";
  network: "public_web_only";
  expiresAt: string;
  traceId: string;
  pagesUsed: number;
  status: "active" | "exhausted" | "expired";
  createdAt: string;
};

/** 一次 PM 调研执行的状态和外部依赖错误摘要。 */
export type ResearchRun = {
  runId: string;
  projectId: string;
  taskId: string;
  grantId: string;
  query: string;
  role: ResearchRoleId;
  status: "running" | "completed" | "blocked" | "failed";
  traceId: string;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

/** 受控浏览器返回的搜索条目，不包含任何工具或角色指令。 */
export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  publisher: string | null;
};

/** 页面访问的脱敏证据；rawText 只在内存中存在，不写入数据库或日志。 */
export type PageEvidence = {
  grantId: string;
  url: string;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  visitedAt: string;
  httpStatus: number | null;
  accessible: boolean;
  rawText: string;
  contentType: string | null;
};

/** 受控提取请求只能描述资料字段，不能携带可执行脚本。 */
export type ExtractionRequest = {
  quote?: string;
  selectors?: string[];
};

/** 清洗和注入检测后的研究材料，正文仍被标记为不可信输入。 */
export type ExtractedResearch = {
  grantId: string;
  sourceUrl: string;
  cleanedText: string;
  quote: string;
  summary: string;
  contentHash: string;
  injectionDetected: boolean;
  injectionCategories: string[];
  riskSummary: string | null;
  snapshotArtifactRef: string | null;
};

/** 来源分类遵循 PRD §7.7 与 SR-RSH-001～006 的最小集合。 */
export type SourceType =
  | "official_first_party"
  | "independent_research"
  | "independent_media"
  | "user_or_market_data"
  | "repost_or_duplicate"
  | "inaccessible"
  | "hypothesis_only";

/** 来源访问状态用于区分网页失败和证据规则失败。 */
export type SourceStatus = "accessed" | "failed" | "blocked" | "pending";

/** 来源目录中的不可变事实和可追加核验字段。 */
export type ResearchSource = {
  sourceId: string;
  projectId: string;
  taskId: string;
  runId: string | null;
  title: string;
  url: string;
  publisher: string | null;
  publishedAt: string | null;
  visitedAt: string;
  sourceType: SourceType;
  status: SourceStatus;
  httpStatus: number | null;
  accessible: boolean;
  supportsConclusions: string[];
  quote: string;
  summary: string;
  contentHash: string | null;
  snapshotArtifactRef: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationResult: "unverified" | "supported" | "unsupported" | "conflicted";
  independent: boolean | null;
  conflictEvidence: string[];
  traceId: string;
  createdAt: string;
};

/** 结论类型决定最低来源数量和独立性规则。 */
export type ConclusionType =
  | "official_feature"
  | "market_or_competitive"
  | "user_or_trend"
  | "effectiveness"
  | "other";

/** 只有 accepted_for_prd 才能作为确定方向进入 Boss PRD 审批。 */
export type ConclusionStatus =
  | "pending"
  | "accepted_for_prd"
  | "hypothesis_only"
  | "rejected";

/** 经过来源规则计算的调研结论。 */
export type ResearchConclusion = {
  conclusionId: string;
  projectId: string;
  taskId: string;
  runId: string | null;
  conclusionType: ConclusionType;
  statement: string;
  sourceIds: string[];
  independenceDeclaration: boolean;
  status: ConclusionStatus;
  requiredSources: number;
  validIndependentSources: number;
  conflicts: string[];
  assumptionLabel: "待验证假设" | null;
  reviewer: string | null;
  evidenceRefs: string[];
  createdAt: string;
  validatedAt: string | null;
};

/** 第二位 PM 对单条来源的核验结果，原始来源记录不可被覆盖。 */
export type SourceValidation = {
  validationId: string;
  projectId: string;
  conclusionId: string;
  sourceId: string;
  reviewerRole: ResearchRoleId;
  reviewerId: string;
  accessible: boolean;
  supportsStatement: boolean;
  independent: boolean;
  result: "supported" | "unsupported" | "conflicted";
  rationale: string;
  conflictIds: string[];
  traceId: string;
  createdAt: string;
};

/** 冲突证据保留双方材料和判断理由，禁止用最后一次写入覆盖。 */
export type ResearchConflict = {
  conflictId: string;
  projectId: string;
  conclusionId: string;
  sourceAId: string;
  sourceBId: string;
  statement: string;
  evidenceA: string;
  evidenceB: string;
  judgmentReason: string | null;
  status: "unresolved" | "resolved";
  createdAt: string;
};

/** PM 定义的项目成功指标；Boss 只审批，不代替 PM 创建。 */
export type ProductSuccessMetric = {
  metricId: string;
  projectId: string;
  taskId: string;
  name: string;
  targetValue: string;
  measurementDefinition: string;
  verificationMethod: string;
  owner: "product_solution_pm";
  reviewer: "product_market_pm" | "user_market_pm";
  status: "draft" | "pending_review" | "reviewed" | "rejected";
  evidenceRefs: string[];
  reviewId: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

/** 调研报告是来源目录和结论的可审阅汇总，不承载网页原文。 */
export type ResearchReport = {
  reportId: string;
  projectId: string;
  taskId: string;
  runId: string;
  artifactRef: string;
  summary: string;
  sourceIds: string[];
  conclusionIds: string[];
  createdBy: ResearchRoleId;
  createdAt: string;
};

/** PRD 版本将来源、结论、指标、评审和争议绑定在同一可追踪对象上。 */
export type PrdVersion = {
  prdVersionId: string;
  projectId: string;
  taskId: string;
  versionNumber: number;
  contentArtifactRef: string;
  sourceIds: string[];
  conclusionIds: string[];
  metricIds: string[];
  peerReviewIds: string[];
  disputeRefs: string[];
  status: "draft" | "ready_for_approval" | "approved" | "rejected";
  createdBy: ResearchRoleId;
  createdAt: string;
};

/** PM 交叉评审记录；评审结果是追加事实，不修改来源和结论原文。 */
export type PeerReview = {
  peerReviewId: string;
  projectId: string;
  taskId: string;
  prdVersionId: string;
  reviewerRole: "product_solution_pm" | "product_market_pm" | "user_market_pm";
  reviewerId: string;
  decision: "approved" | "rejected";
  sourceValidationSummary: string;
  conflictIds: string[];
  comments: string;
  traceId: string;
  createdAt: string;
};

/** 提示注入只记录类别和脱敏风险摘要，绝不把网页指令当成业务命令。 */
export type ResearchSecurityEvent = {
  securityEventId: string;
  projectId: string;
  taskId: string;
  runId: string | null;
  sourceId: string | null;
  categories: string[];
  result: "continued_with_untrusted_text" | "skipped" | "blocked";
  redactionReason: string;
  traceId: string;
  createdAt: string;
};

/** 校验调研 Grant 的输入边界、资源上限、时间边界和固定网络策略。 */
export function parseResearchGrant(
  input: Record<string, unknown>,
): ResearchGrant {
  const grantId = safeId(input.grantId, "grantId");
  const projectId = safeId(input.projectId, "projectId");
  const taskId = safeId(input.taskId, "taskId");
  const role = canonicalResearchRole(String(input.role ?? ""));
  const allowedDomains = stringArray(
    input.allowedDomains,
    "allowedDomains",
  ).map((domain) => domain.toLowerCase());
  const allowedUrls = stringArray(input.allowedUrls ?? [], "allowedUrls", true);
  const maxPages = boundedInteger(input.maxPages, "maxPages", 1, 100);
  const timeoutSeconds = boundedInteger(
    input.timeoutSeconds,
    "timeoutSeconds",
    1,
    300,
  );
  const evidencePolicy = input.evidencePolicy ?? "source_metadata_and_quote";
  const network = input.network ?? "public_web_only";
  if (evidencePolicy !== "source_metadata_and_quote")
    throw new Error("unsupported research evidence policy");
  if (network !== "public_web_only")
    throw new Error("research grant network must be public_web_only");
  const expiresAt = date(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.now())
    throw new Error("research grant must expire in the future");
  const traceId = safeId(input.traceId, "traceId");
  for (const domain of allowedDomains) validateDomain(domain);
  for (const url of allowedUrls) validatePublicUrl(url);
  assertSafeData({
    grantId,
    projectId,
    taskId,
    role,
    allowedDomains,
    allowedUrls,
    maxPages,
    timeoutSeconds,
    evidencePolicy,
    network,
    expiresAt,
    traceId,
  });
  return {
    grantId,
    projectId,
    taskId,
    role,
    allowedDomains,
    allowedUrls,
    maxPages,
    timeoutSeconds,
    evidencePolicy,
    network,
    expiresAt,
    traceId,
    pagesUsed: 0,
    status: "active",
    createdAt: new Date().toISOString(),
  };
}

/** 校验 URL 处于公开 HTTP(S) 范围，拒绝本地、私网和脚本协议。 */
export function validatePublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("research URL must use http or https");
  if (url.username || url.password)
    throw new Error("research URL must not contain credentials");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isPrivateIp(hostname)
  )
    throw new Error("research URL must target the public internet");
  return url;
}

/** 判断 URL 是否命中 Grant 的精确域名或其安全子域名。 */
export function isAllowedResearchUrl(
  grant: ResearchGrant,
  value: string,
): boolean {
  const url = validatePublicUrl(value);
  const hostname = url.hostname.toLowerCase();
  const domainAllowed = grant.allowedDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
  if (!domainAllowed) return false;
  if (grant.allowedUrls.length === 0) return true;
  return grant.allowedUrls.some(
    (allowed) => canonicalUrl(allowed) === canonicalUrl(value),
  );
}

/** 判断 Grant 是否仍可执行，并给出稳定的阻断原因。 */
export function assertResearchGrantActive(
  grant: ResearchGrant,
  now = new Date(),
  allowExhausted = false,
): void {
  if (grant.network !== "public_web_only")
    throw new Error("research grant network policy is invalid");
  if (Date.parse(grant.expiresAt) <= now.getTime())
    throw new Error("research grant is expired");
  if (
    grant.status !== "active" &&
    !(allowExhausted && grant.status === "exhausted")
  )
    throw new Error("research grant is not active");
  if (grant.pagesUsed >= grant.maxPages)
    throw new Error("research grant page budget is exhausted");
}

/** 规范来源 URL，减少同一稿件因跟踪参数产生的重复计数。 */
export function canonicalUrl(value: string): string {
  const url = validatePublicUrl(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  return url.toString().replace(/\/$/, "");
}

function safeId(value: unknown, name: string): string {
  return validateSafeValue(String(value ?? ""), name);
}

function stringArray(
  value: unknown,
  name: string,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    throw new Error(`${name} must be a non-empty string array`);
  return value.map((item) => safeId(item, name));
}

function boundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(value);
}

function date(value: unknown, name: string): string {
  try {
    return normalizeUtc(String(value ?? ""));
  } catch (_error) {
    throw new Error(`${name} must be a timezone-aware datetime`);
  }
}

function validateDomain(value: string): void {
  if (
    value.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      value,
    )
  )
    throw new Error("allowedDomains contains an invalid public domain");
}

function isPrivateIp(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (
    /^127\.|^10\.|^169\.254\.|^192\.168\.|^192\.0\.0\.|^192\.0\.2\.|^198\.(?:18|19)\.|^198\.51\.100\.|^203\.0\.113\./.test(
      normalized,
    )
  )
    return true;
  const private172 = normalized.match(/^172\.(\d+)\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31)
    return true;
  if (/^100\.(?:6[4-9]|[7-9]\d|1\d\d)\./.test(normalized)) return true;
  if (normalized.startsWith("::ffff:"))
    return isPrivateIp(normalized.slice("::ffff:".length));
  return (
    normalized === "0.0.0.0" ||
    normalized === "255.255.255.255" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}
