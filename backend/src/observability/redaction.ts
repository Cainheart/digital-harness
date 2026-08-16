import { createHash } from "node:crypto";
import type { StructuredModelRequest } from "../gateway/model/model-adapter.js";
import { redact } from "../security/redaction.js";

/** 模型摘要的安全边界结果；下游只允许保存 passed 状态的正文。 */
export type RedactionResult = {
  value: string;
  status: "passed";
  reason: string;
};

/** 只保存消息数量、角色、长度和哈希，不保存完整提示词或隐藏提示词。 */
export function summarizeModelInput(
  request: StructuredModelRequest,
  secrets: Iterable<string> = [],
): RedactionResult {
  const content = request.messages.map((message) => message.content).join("\n");
  const summary = {
    messageCount: request.messages.length,
    roles: request.messages.map((message) => message.role),
    contentChars: content.length,
    contentSha256: hashText(content),
    outputSchema: "structured",
  };
  return safeSummary(summary, secrets, "input summary excludes prompt content");
}

/** 只保存结构化输出的字段形状和哈希，不保存模型原文或内部思维过程。 */
export function summarizeModelOutput(
  output: unknown,
  secrets: Iterable<string> = [],
): RedactionResult {
  const serialized = JSON.stringify(output);
  if (serialized === undefined) {
    throw new Error("model output is not JSON serializable");
  }
  const summary = {
    outputType: Array.isArray(output) ? "array" : typeof output,
    fields:
      output && typeof output === "object" && !Array.isArray(output)
        ? Object.keys(output as Record<string, unknown>).map((key) =>
            isSensitiveField(key) ? "[REDACTED_FIELD]" : key,
          )
        : [],
    contentChars: serialized.length,
    contentSha256: hashText(serialized),
  };
  return safeSummary(summary, secrets, "output summary excludes model content");
}

/** 对错误摘要只保留稳定错误码，避免写入供应商响应和提示词片段。 */
export function summarizeModelError(
  code: string,
  secrets: Iterable<string> = [],
): RedactionResult {
  return safeSummary(
    { errorCode: code },
    secrets,
    "error summary is normalized before persistence",
  );
}

/** 对结构化摘要进行字段脱敏、凭据扫描和 JSON 可序列化检查。 */
function safeSummary(
  value: Record<string, unknown>,
  secrets: Iterable<string>,
  reason: string,
): RedactionResult {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("summary is not JSON serializable");
  }
  const redacted = redact(serialized, secrets);
  if (containsCredentialPattern(redacted)) {
    throw new Error("summary contains a credential pattern after redaction");
  }
  return {
    value: redacted,
    status: "passed",
    reason,
  };
}

/** 判断摘要中是否仍有常见 API Key、Bearer 或提示词泄露模式。 */
function containsCredentialPattern(value: string): boolean {
  const bearerPattern = /Bearer\s+\S+/i;
  const apiKeyPattern = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]*\b/i;
  const namedSecretPattern = new RegExp(
    "(?:api[_ -]?key|authorization|password|secret)\\s*[:=]\\s*[^\\[\\]\\\",}\\s]+",
    "i",
  );
  return (
    bearerPattern.test(value) ||
    apiKeyPattern.test(value) ||
    namedSecretPattern.test(value)
  );
}

/** 过滤敏感字段名，防止摘要字段形状携带凭据语义。 */
function isSensitiveField(value: string): boolean {
  return /api[_ -]?key|authorization|bearer|cookie|secret|password|token|prompt/i.test(
    value,
  );
}

/** 使用 SHA-256 生成不可逆摘要，供调用记录对账而不保存原文。 */
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
