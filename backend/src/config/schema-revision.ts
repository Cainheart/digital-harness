/** 当前运行时要求的最后一个已验收持久化合同版本。 */
export const SUPPORTED_SCHEMA_REVISION = "0012_task10_observability_ops" as const;

/** 拒绝让配置、迁移目标和 readiness 使用不同的兼容基线。 */
export function validateSchemaRevision(
  value: string,
): typeof SUPPORTED_SCHEMA_REVISION {
  if (value !== SUPPORTED_SCHEMA_REVISION) {
    throw new Error(`only ${SUPPORTED_SCHEMA_REVISION} is supported`);
  }
  return SUPPORTED_SCHEMA_REVISION;
}
