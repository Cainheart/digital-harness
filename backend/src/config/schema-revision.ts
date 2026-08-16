/** 应用唯一支持的持久化 Schema 基线。 */
export const SUPPORTED_SCHEMA_REVISION = "0003_task2_integrity_trace_fix" as const;

/** 拒绝让配置、迁移目标和 readiness 使用不同的兼容基线。 */
export function validateSchemaRevision(value: string): typeof SUPPORTED_SCHEMA_REVISION {
  if (value !== SUPPORTED_SCHEMA_REVISION) {
    throw new Error("only 0003_task2_integrity_trace_fix is supported");
  }
  return SUPPORTED_SCHEMA_REVISION;
}
