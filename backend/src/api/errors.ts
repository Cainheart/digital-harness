import { DomainError } from "../domain/errors.js";

/** 描述可展示给调用方的运行边界错误，且不包含敏感凭据。 */
export class RuntimeBoundaryError extends Error {
  readonly code: string;
  readonly impact: string;
  readonly paused: boolean;
  readonly dataPreserved: boolean;
  readonly nextAction: string;
  readonly traceId: string;
  readonly schemaRevision?: string;
  readonly statusCode: number;

  /** 保存错误分类、影响、恢复动作和 trace 信息。 */
  constructor(options: RuntimeBoundaryOptions) {
    super(options.message);
    this.name = "RuntimeBoundaryError";
    this.code = options.code;
    this.impact = options.impact;
    this.paused = options.paused ?? false;
    this.dataPreserved = options.dataPreserved ?? true;
    this.nextAction = options.nextAction;
    this.traceId = options.traceId;
    this.schemaRevision = options.schemaRevision;
    this.statusCode = options.statusCode ?? 409;
  }

  /** 转换为 API 稳定 JSON 载荷。 */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      impact: this.impact,
      paused: this.paused,
      dataPreserved: this.dataPreserved,
      nextAction: this.nextAction,
      traceId: this.traceId,
      ...(this.schemaRevision ? { schemaRevision: this.schemaRevision } : {}),
    };
  }
}

type RuntimeBoundaryOptions = {
  code: string;
  message: string;
  impact: string;
  paused?: boolean;
  dataPreserved?: boolean;
  nextAction: string;
  traceId: string;
  schemaRevision?: string;
  statusCode?: number;
};
/** 生成 Fastify 异常处理器使用的 JSON 兼容错误载荷。 */
export function errorPayload(
  error: RuntimeBoundaryError | DomainError,
): Record<string, unknown> {
  return error.toPayload();
}
