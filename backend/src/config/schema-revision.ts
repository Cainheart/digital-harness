/** Task 3 完成后，运行时同时要求 Task 1～Task 3 的完整持久化合同。 */
export const SUPPORTED_SCHEMA_REVISION = "0004_task3_organization_policy" as const;

/** 拒绝让配置、迁移目标和 readiness 使用不同的兼容基线。 */
export function validateSchemaRevision(value: string): typeof SUPPORTED_SCHEMA_REVISION {
  if (value !== SUPPORTED_SCHEMA_REVISION) {
    throw new Error("only 0004_task3_organization_policy is supported");
  }
  return SUPPORTED_SCHEMA_REVISION;
}
