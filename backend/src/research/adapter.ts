import type {
  ExtractedResearch,
  ExtractionRequest,
  PageEvidence,
  ResearchGrant,
  SearchResult,
} from "../domain/research/index.js";
import {
  assertResearchGrantActive,
  isAllowedResearchUrl,
} from "../domain/research/index.js";
import { PolicyDeniedError } from "../domain/errors.js";
import type { Database } from "../infra/database.js";
import { ResearchRepository } from "../infra/repositories/research.js";
import { ResearchContentCleaner } from "./content-cleaner.js";
import type { ResearchBrowser } from "./browser.js";

/** 受控 Research Adapter：Grant 校验、页数预算、浏览器和内容清洗的唯一组合入口。 */
export class ResearchAdapter {
  private readonly repository: ResearchRepository;

  /** 注入可替换浏览器和持久化边界，便于真实 Chromium 与失败样本共用同一合同。 */
  constructor(
    private readonly database: Database,
    private readonly browser: ResearchBrowser,
    private readonly cleaner = new ResearchContentCleaner(),
    repository = new ResearchRepository(),
  ) {
    this.repository = repository;
  }

  /** 执行受控搜索；查询本身不能扩大 Grant 域名、工具或角色权限。 */
  async search(grant: ResearchGrant, query: string): Promise<SearchResult[]> {
    assertGrantExecutionAllowed(grant);
    if (!query.trim() || query.length > 2_000)
      throw new PolicyDeniedError("调研查询为空或超过长度限制", {
        traceId: grant.traceId,
      });
    const current = this.loadGrant(grant);
    return this.browser.search(current, query);
  }

  /** 以事务方式消耗一页访问预算后打开白名单网页。 */
  async open(grant: ResearchGrant, url: string): Promise<PageEvidence> {
    assertGrantExecutionAllowed(grant);
    if (!isAllowedResearchUrl(grant, url))
      throw new PolicyDeniedError("来源 URL 不在 ResearchGrant 白名单中", {
        traceId: grant.traceId,
      });
    const current = this.database.transaction((connection) => {
      const stored = this.repository.getGrant(connection, grant.grantId);
      assertGrantMatches(grant, stored);
      return this.repository.reservePage(connection, grant.grantId);
    });
    try {
      return await this.browser.open(current, url);
    } catch (error) {
      this.database.transaction((connection) =>
        this.repository.releasePage(connection, grant.grantId),
      );
      throw error;
    }
  }

  /** 将浏览器返回的文本通过清洗和注入检测，输出可进入 Artifact 的非可信材料。 */
  async extract(
    grant: ResearchGrant,
    page: PageEvidence,
    selectors: ExtractionRequest,
  ): Promise<ExtractedResearch> {
    assertGrantExecutionAllowed(grant, true);
    if (page.grantId !== grant.grantId)
      throw new PolicyDeniedError("页面证据不属于当前 ResearchGrant", {
        traceId: grant.traceId,
      });
    const browserResult = await this.browser.extract(grant, page, selectors);
    const extracted = this.cleaner.clean(
      { ...page, rawText: browserResult.text },
      { quote: browserResult.quote },
    );
    return extracted;
  }

  private loadGrant(grant: ResearchGrant): ResearchGrant {
    const stored = this.database.connection
      ? this.repository.getGrant(this.database.connection, grant.grantId)
      : grant;
    assertGrantMatches(grant, stored);
    return stored;
  }
}

/** 将领域 Grant 状态错误映射为可解释的策略拒绝，避免过期请求变成 500。 */
function assertGrantExecutionAllowed(
  grant: ResearchGrant,
  allowExhausted = false,
): void {
  try {
    assertResearchGrantActive(grant, new Date(), allowExhausted);
  } catch (error) {
    throw new PolicyDeniedError(
      error instanceof Error ? error.message : "ResearchGrant 当前不可执行",
      { traceId: grant.traceId },
    );
  }
}

/** Grant 只能使用创建时的项目、任务、角色和 trace，拒绝 HTTP 输入扩权。 */
function assertGrantMatches(input: ResearchGrant, stored: ResearchGrant): void {
  if (
    input.projectId !== stored.projectId ||
    input.taskId !== stored.taskId ||
    input.role !== stored.role ||
    input.traceId !== stored.traceId
  )
    throw new PolicyDeniedError(
      "ResearchGrant 的项目、任务、角色或 trace 不匹配",
      { traceId: input.traceId },
    );
}
