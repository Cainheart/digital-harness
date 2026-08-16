import type { CredentialAdapter } from "../../infra/keychain.js";
import type { ModelFetch } from "./model-adapter.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter.js";

/** OpenAI Chat Completions 的 V1 模型适配器。 */
export class OpenAiAdapter extends OpenAiCompatibleAdapter {
  readonly provider = "openai" as const;

  /** 使用官方兼容端点，也允许测试注入本地模拟供应商。 */
  constructor(
    credentials: CredentialAdapter,
    options: { endpoint?: string; fetchImpl?: ModelFetch; timeoutMs?: number } = {},
  ) {
    super(
      credentials,
      options.endpoint ?? "https://api.openai.com/v1/chat/completions",
      options.fetchImpl,
      options.timeoutMs,
    );
  }
}
