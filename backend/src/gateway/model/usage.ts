import type { ModelUsage } from "./model-adapter.js";

/** 单位为 micro-USD/百万 Token 的模型价格。 */
export type ModelPricing = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
};
/** 按供应商和模型查找价格；未知模型显式返回零价而不是猜测。 */
export type PricingResolver = (
  provider: string,
  model: string,
) => ModelPricing;

/** 默认价格表只提供可验证的测试/本地基线，生产部署应注入明确费率。 */
export const DEFAULT_MODEL_PRICING: PricingResolver = () => ({
  inputMicrosPerMillion: 0,
  outputMicrosPerMillion: 0,
});

/** 校验非负整数 Token，避免供应商异常响应污染成本指标。 */
export function normalizeUsage(usage: Partial<ModelUsage>): ModelUsage {
  const inputTokens = nonNegativeInteger(usage.inputTokens, "inputTokens");
  const outputTokens = nonNegativeInteger(usage.outputTokens, "outputTokens");
  const totalTokens =
    usage.totalTokens === undefined
      ? inputTokens + outputTokens
      : nonNegativeInteger(usage.totalTokens, "totalTokens");
  if (totalTokens < inputTokens + outputTokens) {
    throw new Error("totalTokens cannot be lower than input plus output tokens");
  }
  return { inputTokens, outputTokens, totalTokens };
}

/** 按整数微美元计算一次调用成本，结果不会因为浮点误差漂移。 */
export function calculateCostMicros(
  usage: ModelUsage,
  pricing: ModelPricing,
): number {
  const inputCost =
    (usage.inputTokens * pricing.inputMicrosPerMillion) / 1_000_000;
  const outputCost =
    (usage.outputTokens * pricing.outputMicrosPerMillion) / 1_000_000;
  const cost = Math.round(inputCost + outputCost);
  if (!Number.isSafeInteger(cost) || cost < 0) {
    throw new Error("model cost is outside the supported integer range");
  }
  return cost;
}

/** 规范化供应商用量字段并拒绝负数、NaN 和无穷值。 */
function nonNegativeInteger(value: number | undefined, field: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}
