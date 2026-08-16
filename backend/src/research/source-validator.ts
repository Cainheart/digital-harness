import {
  canonicalUrl,
  type ConclusionType,
  type ResearchConclusion,
  type ResearchConflict,
  type ResearchSource,
  type SourceType,
} from "../domain/research/index.js";

/** 结论校验结果；不足证据统一降级为待验证假设。 */
export type ConclusionValidationResult = {
  status: ResearchConclusion["status"];
  requiredSources: number;
  validIndependentSources: number;
  conflicts: ResearchConflict[];
  assumptionLabel: "待验证假设" | null;
  reason: string;
};

/** 根据页面元数据和正文关系分类来源，规则不依赖模型自由判断。 */
export class SourceValidator {
  /** 分类官方、独立、转载和不可访问来源。 */
  classify(input: {
    url: string;
    publisher: string | null;
    declaredOfficial?: boolean;
    duplicateOf?: ResearchSource | null;
    accessible: boolean;
  }): SourceType {
    if (!input.accessible) return "inaccessible";
    if (input.duplicateOf) return "repost_or_duplicate";
    if (input.declaredOfficial && isPublisherHost(input.url, input.publisher))
      return "official_first_party";
    if (isResearchPublisher(input.publisher)) return "independent_research";
    return "independent_media";
  }

  /** 按结论类型计算最低来源数量、独立性、转载和冲突规则。 */
  validateConclusion(
    input: {
      conclusionType: ConclusionType;
      statement: string;
      sources: ResearchSource[];
      independenceDeclaration: boolean;
    },
    existingConclusions: ResearchConclusion[] = [],
  ): ConclusionValidationResult {
    const requiredSources = input.conclusionType === "official_feature" ? 1 : 2;
    const accessible = input.sources.filter(
      (source) => source.accessible && source.status === "accessed",
    );
    const validSources = accessible.filter(
      (source) => source.sourceType !== "repost_or_duplicate",
    );
    const independentOrganizations = new Set(
      validSources
        .map((source) => source.publisher?.trim().toLowerCase() ?? "")
        .filter(Boolean),
    );
    const conflicts = this.findConflicts(
      input.statement,
      input.sources,
      existingConclusions,
    );
    const enoughIndependentSources =
      input.conclusionType === "official_feature"
        ? validSources.some(
            (source) => source.sourceType === "official_first_party",
          )
        : independentOrganizations.size >= 2 && input.independenceDeclaration;
    const supported =
      validSources.length >= requiredSources &&
      enoughIndependentSources &&
      conflicts.length === 0;
    return {
      status: supported ? "accepted_for_prd" : "hypothesis_only",
      requiredSources,
      validIndependentSources: independentOrganizations.size,
      conflicts,
      assumptionLabel: supported ? null : "待验证假设",
      reason: supported
        ? "来源数量、可访问性、独立性和冲突规则均满足"
        : "证据不足、来源不独立或存在未解决冲突，只能作为待验证假设",
    };
  }

  /** 保留同项目内对同一方向陈述的相反证据，不修改已有结论。 */
  private findConflicts(
    statement: string,
    sources: ResearchSource[],
    existingConclusions: ResearchConclusion[],
  ): ResearchConflict[] {
    const normalized = normalizeStatement(statement);
    const conflicts: ResearchConflict[] = [];
    for (const existing of existingConclusions) {
      if (normalizeStatement(existing.statement) === normalized) continue;
      if (
        !isPotentiallyConflicting(
          normalized,
          normalizeStatement(existing.statement),
        )
      )
        continue;
      const sourceA = sources[0];
      const sourceB = sources.find(
        (source) => !existing.sourceIds.includes(source.sourceId),
      );
      if (!sourceA || !sourceB) continue;
      conflicts.push({
        conflictId: `conflict_${sourceA.sourceId}_${sourceB.sourceId}`,
        projectId: sourceA.projectId,
        conclusionId: "pending",
        sourceAId: sourceA.sourceId,
        sourceBId: sourceB.sourceId,
        statement,
        evidenceA: sourceA.quote,
        evidenceB: sourceB.quote,
        judgmentReason: null,
        status: "unresolved",
        createdAt: new Date().toISOString(),
      });
    }
    return conflicts;
  }
}

/** 判断官方声明是否来自同一组织域名，避免用户输入把媒体冒充官网。 */
function isPublisherHost(url: string, publisher: string | null): boolean {
  if (!publisher) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const publisherHost = publisher.toLowerCase().replace(/^www\./, "");
    return hostname === publisherHost || hostname.endsWith(`.${publisherHost}`);
  } catch (_error) {
    return false;
  }
}

function isResearchPublisher(publisher: string | null): boolean {
  return Boolean(
    publisher && /(university|research|institute|学术|研究)/i.test(publisher),
  );
}

function normalizeStatement(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isPotentiallyConflicting(left: string, right: string): boolean {
  const sharedTerms = left
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 3 && right.includes(term));
  const polarityConflict =
    (left.includes("not") && !right.includes("not")) ||
    (!left.includes("not") && right.includes("not")) ||
    left.includes("否") !== right.includes("否");
  return sharedTerms.length > 0 && polarityConflict;
}

/** 识别同一来源 URL 及同一页面内容的重复来源。 */
export function isDuplicateSource(
  left: ResearchSource,
  right: ResearchSource,
): boolean {
  return (
    canonicalUrl(left.url) === canonicalUrl(right.url) ||
    (Boolean(left.contentHash) && left.contentHash === right.contentHash)
  );
}
