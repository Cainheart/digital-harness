import { createHash } from "node:crypto";
import { redact } from "../security/redaction.js";
import type {
  PageEvidence,
  ExtractedResearch,
} from "../domain/research/index.js";
import { InjectionGuard, defaultInjectionGuard } from "./injection-guard.js";

/** 页面清洗的最大正文长度，防止外部页面耗尽内存或污染后续上下文。 */
export const MAX_RESEARCH_TEXT_CHARS = 200_000;

/** 清洗 HTML/文本、脱敏常见敏感值并生成不可逆内容哈希。 */
export class ResearchContentCleaner {
  constructor(
    private readonly injectionGuard: InjectionGuard = defaultInjectionGuard,
  ) {}

  /** 将页面变为带风险摘要的非可信研究材料，不生成任何可执行动作。 */
  clean(
    page: PageEvidence,
    request: { quote?: string } = {},
  ): ExtractedResearch {
    const withoutExecutableMarkup = page.rawText
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ");
    const normalized = normalizeWhitespace(withoutExecutableMarkup);
    const bounded = normalized.slice(0, MAX_RESEARCH_TEXT_CHARS);
    const redacted = redactResearchText(bounded);
    const detection = this.injectionGuard.detect(redacted);
    const quote = normalizeWhitespace(request.quote ?? redacted.slice(0, 600));
    const summary = summarize(redacted);
    return {
      grantId: page.grantId,
      sourceUrl: page.url,
      cleanedText: redacted,
      quote: quote.slice(0, 2_000),
      summary,
      contentHash: createHash("sha256").update(redacted).digest("hex"),
      injectionDetected: detection.detected,
      injectionCategories: detection.categories,
      riskSummary: detection.riskSummary,
      snapshotArtifactRef: null,
    };
  }
}

/** 删除脚本型网页内容后再压缩空白，确保提取器只面对资料文本。 */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 页面证据只保存必要的脱敏摘要，避免邮箱/手机号等敏感资料扩散。 */
function redactResearchText(value: string): string {
  return redact(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(?:\+?\d[\d -]{7,}\d)/g, "[REDACTED_PHONE]");
}

function summarize(value: string): string {
  if (!value) return "页面未提供可提取的正文内容。";
  return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
}
