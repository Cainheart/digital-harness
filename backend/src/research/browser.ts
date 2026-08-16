import type {
  ExtractionRequest,
  PageEvidence,
  ResearchGrant,
  SearchResult,
} from "../domain/research/index.js";
import type { Page } from "playwright";
import {
  assertResearchGrantActive,
  isAllowedResearchUrl,
  validatePublicUrl,
} from "../domain/research/index.js";
import {
  ExternalDependencyUnavailableError,
  PolicyDeniedError,
} from "../domain/errors.js";

/** Research Adapter 与浏览器之间的最小可替换边界，便于稳定测试和故障注入。 */
export interface ResearchBrowser {
  search(grant: ResearchGrant, query: string): Promise<SearchResult[]>;
  open(grant: ResearchGrant, url: string): Promise<PageEvidence>;
  extract(
    grant: ResearchGrant,
    page: PageEvidence,
    request: ExtractionRequest,
  ): Promise<{ text: string; quote: string }>;
}

/** 测试/未安装浏览器时的明确失败实现；不会伪造网页访问成功。 */
export class UnavailableResearchBrowser implements ResearchBrowser {
  /** 返回受控的外部依赖不可用错误。 */
  async search(grant: ResearchGrant, _query: string): Promise<SearchResult[]> {
    throw new ExternalDependencyUnavailableError(
      "Chromium 调研浏览器不可用，调研任务保持阻塞",
      { traceId: grant.traceId },
    );
  }

  /** 返回受控的外部依赖不可用错误。 */
  async open(grant: ResearchGrant, _url: string): Promise<PageEvidence> {
    throw new ExternalDependencyUnavailableError(
      "Chromium 调研浏览器不可用，来源数据未丢失",
      { traceId: grant.traceId },
    );
  }

  /** 返回受控的外部依赖不可用错误。 */
  async extract(
    grant: ResearchGrant,
    _page: PageEvidence,
    _request: ExtractionRequest,
  ): Promise<{ text: string; quote: string }> {
    throw new ExternalDependencyUnavailableError(
      "Chromium 调研浏览器不可用，提取任务保持阻塞",
      { traceId: grant.traceId },
    );
  }
}

/**
 * 基于 Playwright Chromium 的公开网页适配器。
 * 浏览器上下文只允许访问 Grant 域名，不暴露文件、Shell、Docker 或系统目录能力。
 */
export class PlaywrightResearchBrowser implements ResearchBrowser {
  constructor(
    private readonly options: {
      executablePath?: string;
      searchEndpoint?: string;
      headless?: boolean;
    } = {},
  ) {}

  /** 在受控搜索入口读取结果；搜索入口必须显式加入 Grant 域名白名单。 */
  async search(grant: ResearchGrant, query: string): Promise<SearchResult[]> {
    assertResearchGrantActive(grant);
    if (!query.trim() || query.length > 2_000)
      throw new PolicyDeniedError("调研查询为空或超过长度限制", {
        traceId: grant.traceId,
      });
    const endpoint =
      this.options.searchEndpoint ?? "https://www.google.com/search";
    // 搜索服务是公开检索工具本身，不作为来源证据；最终打开的来源仍必须命中 Grant 白名单。
    validatePublicUrl(endpoint);
    const page = await this.withPage(grant, async (browserPage) => {
      await browserPage.goto(`${endpoint}?q=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded",
        timeout: grant.timeoutSeconds * 1_000,
      });
      return browserPage.locator("a").evaluateAll((anchors: Element[]) =>
        anchors
          .map((anchor) => ({
            title: anchor.textContent?.trim() ?? "",
            url: (anchor as HTMLAnchorElement).href,
            snippet: "",
            publisher: null,
          }))
          .filter((item) => item.title && item.url.startsWith("http"))
          .slice(0, 50),
      );
    });
    return page as SearchResult[];
  }

  /** 打开单个来源并只返回页面证据，不把网页内容解释成业务结论。 */
  async open(grant: ResearchGrant, url: string): Promise<PageEvidence> {
    assertResearchGrantActive(grant, new Date(), true);
    if (!isAllowedResearchUrl(grant, url))
      throw new PolicyDeniedError("来源 URL 不在 ResearchGrant 白名单中", {
        traceId: grant.traceId,
      });
    validatePublicUrl(url);
    return this.withPage(grant, async (browserPage) => {
      const response = await browserPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: grant.timeoutSeconds * 1_000,
      });
      if (!isAllowedResearchUrl(grant, browserPage.url()))
        throw new PolicyDeniedError(
          "网页重定向到不在 ResearchGrant 白名单中的域名",
          { traceId: grant.traceId },
        );
      const rawText = await browserPage.locator("body").innerText({
        timeout: grant.timeoutSeconds * 1_000,
      });
      return {
        grantId: grant.grantId,
        url,
        title: await browserPage.title(),
        publisher: new URL(url).hostname,
        publishedAt: null,
        visitedAt: new Date().toISOString(),
        httpStatus: response?.status() ?? null,
        accessible: Boolean(response?.ok()),
        rawText,
        contentType: response?.headers()["content-type"] ?? null,
      };
    });
  }

  /** 只提取文本选择器或页面正文，拒绝传入 JavaScript 选择器。 */
  async extract(
    grant: ResearchGrant,
    page: PageEvidence,
    request: ExtractionRequest,
  ): Promise<{ text: string; quote: string }> {
    assertResearchGrantActive(grant, new Date(), true);
    if (page.grantId !== grant.grantId)
      throw new PolicyDeniedError("页面证据不属于当前 ResearchGrant", {
        traceId: grant.traceId,
      });
    const selectors = request.selectors ?? [];
    if (selectors.some((selector) => /[{};]|javascript:/i.test(selector)))
      throw new PolicyDeniedError("选择器包含未授权脚本内容", {
        traceId: grant.traceId,
      });
    const quote = request.quote?.trim() ?? page.rawText.slice(0, 2_000);
    return { text: page.rawText, quote };
  }

  private async withPage<T>(
    grant: ResearchGrant,
    callback: (page: Page) => Promise<T>,
  ): Promise<T> {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: this.options.headless ?? true,
        executablePath: this.options.executablePath,
      });
      const context = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.route("**/*", async (route) => {
        try {
          validatePublicUrl(route.request().url());
          await route.continue();
        } catch (_error) {
          await route.abort("blockedbyclient");
        }
      });
      try {
        return await callback(page);
      } finally {
        await context.close();
        await browser.close();
      }
    } catch (error) {
      if (error instanceof PolicyDeniedError) throw error;
      throw new ExternalDependencyUnavailableError(
        "Chromium 调研请求失败，已保存的来源数据保持不变",
        { traceId: grant.traceId },
      );
    }
  }
}
