/** 替换日志、审计和错误载荷中的常见凭据模式；不用于凭据校验。 */
export function redact(value: string, secrets: Iterable<string> = []): string {
  let result = value.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  result = result.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]*\b/g, "[REDACTED]");
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) if (secret) result = result.split(secret).join("[REDACTED]");
  return result;
}
