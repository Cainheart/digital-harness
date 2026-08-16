import { randomUUID } from "node:crypto";

/** 保存跨控制面、Worker 和证据事件传播的 trace/span 标识。 */
export class TraceContext {
  /** 保存 trace、span 和父 span 关系，供跨模块事件保持同一链路。 */
  constructor(
    readonly traceId: string,
    readonly spanId: string,
    readonly parentSpanId: string | null = null,
  ) {}
  /** 创建新的根 trace 和 span。 */
  static new(): TraceContext {
    return new TraceContext(
      `tr_${randomUUID().replaceAll("-", "")}`,
      `sp_${randomUUID().replaceAll("-", "")}`,
    );
  }
  /** 创建继承当前 trace 且以当前 span 为父级的新 span。 */
  child(): TraceContext {
    return new TraceContext(
      this.traceId,
      `sp_${randomUUID().replaceAll("-", "")}`,
      this.spanId,
    );
  }
}
