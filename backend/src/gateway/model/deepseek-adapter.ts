import type { CredentialAdapter } from "../../infra/keychain.js";
import type { ModelFetch } from "./model-adapter.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter.js";

/** DeepSeek OpenAI-compatible Chat Completions 的 V1 模型适配器。 */
export class DeepSeekAdapter extends OpenAiCompatibleAdapter {
  readonly provider = "deepseek" as const;

  /** 使用 DeepSeek 兼容端点，也允许测试注入本地模拟供应商。 */
  constructor(
    credentials: CredentialAdapter,
    options: { endpoint?: string; fetchImpl?: ModelFetch; timeoutMs?: number } = {},
  ) {
    super(
      credentials,
      options.endpoint ?? "https://api.deepseek.com/chat/completions",
      options.fetchImpl,
      options.timeoutMs,
    );
  }
}
