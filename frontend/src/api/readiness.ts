import type { ReadinessView } from "../features/readiness/readiness.types";

/** Readiness 请求超时后必须回到可解释的失败状态，不允许页面永久等待。 */
const READINESS_TIMEOUT_MS = 5_000;

/** 只通过控制面读取最新状态，并校验响应结构后再交给页面。 */
export async function fetchReadiness(): Promise<ReadinessView> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    READINESS_TIMEOUT_MS,
  );

  try {
    const response = await fetch("/api/v1/readiness", {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const payload: unknown = await response.json();
    if (!isReadinessView(payload)) {
      throw new Error("运行准备响应格式无效");
    }

    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("运行准备检查超时，请稍后重试");
    }

    throw error instanceof Error ? error : new Error("运行准备检查失败");
  } finally {
    window.clearTimeout(timeout);
  }
}

/** 读取后端稳定错误消息；解析失败时不把原始响应暴露给用户。 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      return payload.message;
    }
  } catch (_error) {
    // 非 JSON 错误响应使用下面的稳定兜底消息。
  }

  return "运行准备检查失败";
}

/** 在 Renderer 边界拒绝缺少状态、检查或允许动作字段的后端响应。 */
function isReadinessView(value: unknown): value is ReadinessView {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isCheckStatus(candidate.status) &&
    typeof candidate.checkedAt === "string" &&
    isCheckMap(candidate.checks) &&
    Array.isArray(candidate.allowedActions) &&
    candidate.allowedActions.every((action) => typeof action === "string") &&
    typeof candidate.traceId === "string" &&
    candidate.traceId.length > 0
  );
}

/** 校验总体状态只来自后端冻结的三态集合。 */
function isCheckStatus(value: unknown): value is ReadinessView["status"] {
  return value === "ready" || value === "blocked" || value === "degraded";
}

/** 校验每项 readiness 的展示字段，避免渲染任意后端对象。 */
function isCheckMap(value: unknown): value is ReadinessView["checks"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }

    const check = item as Record<string, unknown>;
    const nullableText = (candidate: unknown): boolean =>
      candidate === undefined ||
      candidate === null ||
      typeof candidate === "string";
    return (
      isCheckStatus(check.status) &&
      typeof check.message === "string" &&
      nullableText(check.impact) &&
      nullableText(check.nextAction) &&
      !!check.details &&
      typeof check.details === "object" &&
      !Array.isArray(check.details)
    );
  });
}
