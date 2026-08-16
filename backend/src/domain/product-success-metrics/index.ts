import { validateSafeValue } from "../common.js";
import type { ProductSuccessMetric } from "../research/index.js";

/** 解析 PM 创建的项目成功指标，保证四个产品指标字段不可缺省。 */
export function parseProductSuccessMetric(
  input: Record<string, unknown>,
  projectId: string,
  taskId: string,
): Omit<
  ProductSuccessMetric,
  "metricId" | "createdAt" | "reviewId" | "reviewedAt"
> {
  const text = (name: string): string => {
    const value = input[name];
    if (typeof value !== "string" || !value.trim())
      throw new Error(`${name} must be a non-empty string`);
    return value;
  };
  const owner = input.owner ?? "product_solution_pm";
  const reviewer = input.reviewer ?? "product_market_pm";
  if (owner !== "product_solution_pm")
    throw new Error("success metric owner must be product_solution_pm");
  if (reviewer !== "product_market_pm" && reviewer !== "user_market_pm")
    throw new Error("success metric reviewer must be the other PM");
  validateSafeValue(projectId, "projectId");
  validateSafeValue(taskId, "taskId");
  return {
    projectId,
    taskId,
    name: text("name"),
    targetValue: text("targetValue"),
    measurementDefinition: text("measurementDefinition"),
    verificationMethod: text("verificationMethod"),
    owner: "product_solution_pm",
    reviewer: reviewer as "product_market_pm" | "user_market_pm",
    status: "pending_review",
    evidenceRefs: parseStringArray(input.evidenceRefs ?? [], "evidenceRefs"),
  };
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim())
      throw new Error(`${name} must contain non-empty strings`);
    return item;
  });
}
