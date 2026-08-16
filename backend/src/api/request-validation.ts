import { validateSafeValue } from "../domain/common.js";
import { InvalidArgumentError } from "../domain/errors.js";

/** 将未知 HTTP body 收敛为对象，避免类型断言把畸形输入带入应用服务。 */
export function requireRecord(
  value: unknown,
  fieldName: string,
  traceId: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidArgumentError(`${fieldName} 必须是对象`, { traceId });
  }

  return value as Record<string, unknown>;
}

/** 读取非空字符串字段，并保留调用方的原始文本用于业务意见等字段。 */
export function requireString(
  value: unknown,
  fieldName: string,
  traceId: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidArgumentError(`${fieldName} 必须是非空字符串`, {
      traceId,
    });
  }

  return value;
}

/** 读取不会进入 SQL、路径或日志分隔边界的安全标识字符串。 */
export function requireSafeString(
  value: unknown,
  fieldName: string,
  traceId: string,
): string {
  const candidate = requireString(value, fieldName, traceId);
  try {
    return validateSafeValue(candidate, fieldName);
  } catch (_error) {
    throw new InvalidArgumentError(`${fieldName} 含有不安全字符`, { traceId });
  }
}

/** 读取可选布尔字段；字段存在但类型错误时不得静默使用默认值。 */
export function optionalBoolean(
  value: unknown,
  fieldName: string,
  defaultValue: boolean,
  traceId: string,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "boolean") {
    throw new InvalidArgumentError(`${fieldName} 必须是布尔值`, { traceId });
  }

  return value;
}
