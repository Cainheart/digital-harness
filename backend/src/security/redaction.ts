/** 字段名中出现这些词时，结构化审计只允许保留固定掩码。 */
const SENSITIVE_FIELD_PATTERN =
  /api[_ -]?key|authorization|bearer|cookie|secret|password|token|prompt/i;

/** 替换日志、审计和错误载荷中的常见凭据模式；不用于凭据校验。 */
export function redact(value: string, secrets: Iterable<string> = []): string {
  let result = value.replace(
    /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    "$1[REDACTED]",
  );
  result = result.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]*\b/g, "[REDACTED]");
  for (const secret of [...new Set(secrets)].sort(
    (a, b) => b.length - a.length,
  )) {
    if (secret) {
      result = result.split(secret).join("[REDACTED]");
    }
  }

  return result;
}

/** 递归脱敏结构化元数据，避免仅扫描 JSON 文本时遗漏 token/password 字段。 */
export function redactJsonValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_FIELD_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redact(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redactJsonValue(item, name),
      ]),
    );
  }

  return value;
}

/** 将脱敏后的元数据编码为可写入运行事件的 JSON 文本。 */
export function redactJson(value: unknown): string {
  const serialized = JSON.stringify(redactJsonValue(value));
  if (serialized === undefined) {
    return "null";
  }

  return serialized;
}
