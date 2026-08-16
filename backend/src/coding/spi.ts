import type {
  CodingExecutionGrant,
  CodingSession,
  CodingObservation,
  HandoffPackage,
} from "../domain/coding/index.js";
import type { AgentEvent } from "./native-harness.js";

/** NativeCodingHarness 对外的最小可替换 SPI；实现不得直接写业务任务状态。 */
export interface AgentHarness {
  start(
    spec: unknown,
    grant: unknown,
    options?: { sourceRoot?: string },
  ): Promise<CodingSession>;
  resume(sessionId: string, checkpointId: string): Promise<CodingSession>;
  pause(sessionId: string, reason: string): Promise<CodingSession>;
  cancel(sessionId: string, reason: string): Promise<CodingSession>;
  stream(sessionId: string): AsyncIterable<AgentEvent>;
  result(sessionId: string): CodingExecutionResult;
}

/** 交接结果只返回执行事实、Review 请求和可审计观察，不包含模型隐藏过程。 */
export type CodingExecutionResult = {
  session: CodingSession;
  handoff: HandoffPackage | null;
  facts: {
    actions: Array<Record<string, unknown>>;
    observations: CodingObservation[];
    verifications: Array<Record<string, unknown>>;
  };
};

/** 供需要时固定 TaskSpec/Grant 的强类型调用入口，运行时仍会重新解析校验。 */
export type AgentStartInput = {
  spec: unknown;
  grant: CodingExecutionGrant;
};
