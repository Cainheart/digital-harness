import { randomUUID } from "node:crypto";

/** 为每个 API 请求生成不可猜测且可跨模块关联的 traceId。 */
export function createRequestTraceId(scope: string): string {
  const normalizedScope = scope.trim();

  if (!/^[a-z][a-z0-9-]{0,31}$/.test(normalizedScope)) {
    throw new Error("trace scope must be a lowercase identifier");
  }

  return `tr_${normalizedScope}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
