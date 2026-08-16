import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { DeepSeekAdapter, OpenAiAdapter } from "../../src/gateway/model/index.js";
import { createModelGatewayError } from "../../src/gateway/model/errors.js";
import { MemoryCredentialAdapter } from "../../src/infra/keychain.js";
import { TraceContext } from "../../src/observability/trace.js";

function config(secretRef: string, provider: "openai" | "deepseek") {
  return {
    domain: "development" as const,
    provider,
    modelName: "test-model",
    configVersion: 3,
    secretRef,
    timeoutMs: 1000,
    maxAttempts: 2,
  };
}

describe("Task 5 provider adapters", () => {
  it("normalizes a valid OpenAI-compatible structured response", async () => {
    const credentials = new MemoryCredentialAdapter();
    const secretRef = await credentials.save("openai", "sk-unit-secret");
    const adapter = new OpenAiAdapter(credentials, {
      fetchImpl: async (_input, init) => {
        expect(init?.headers).toMatchObject({
          authorization: "Bearer sk-unit-secret",
        });
        return new Response(
          JSON.stringify({
            id: "req-test",
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify({ answer: "ok" }) },
              },
            ],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 3,
              total_tokens: 7,
            },
          }),
          { status: 200 },
        );
      },
    });
    const result = await adapter.complete(
      {
        messages: [{ role: "user", content: "return JSON" }],
        outputSchema: Type.Object({ answer: Type.String() }),
      },
      config(secretRef, "openai"),
      TraceContext.new(),
    );
    expect(result.output).toEqual({ answer: "ok" });
    expect(result.usage.totalTokens).toBe(7);
  });

  it("blocks credentials echoed by the provider and normalizes auth failures", async () => {
    const credentials = new MemoryCredentialAdapter();
    const secretRef = await credentials.save("deepseek", "sk-echo-secret");
    const echoed = new DeepSeekAdapter(credentials, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ answer: "sk-echo-secret" }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    await expect(
      echoed.complete(
        {
          messages: [{ role: "user", content: "return JSON" }],
          outputSchema: Type.Object({ answer: Type.String() }),
        },
        config(secretRef, "deepseek"),
        TraceContext.new(),
      ),
    ).rejects.toMatchObject({ code: "REDACTION_FAILED" });

    const authFailed = new OpenAiAdapter(credentials, {
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    await expect(
      authFailed.complete(
        {
          messages: [{ role: "user", content: "return JSON" }],
          outputSchema: Type.Object({ answer: Type.String() }),
        },
        config(secretRef, "openai"),
        TraceContext.new(),
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects invalid structured output without returning raw provider content", async () => {
    const credentials = new MemoryCredentialAdapter();
    const secretRef = await credentials.save("openai", "sk-structured-secret");
    const adapter = new OpenAiAdapter(credentials, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ wrong: true }) } }],
          }),
          { status: 200 },
        ),
    });
    await expect(
      adapter.complete(
        {
          messages: [{ role: "user", content: "return JSON" }],
          outputSchema: Type.Object({ answer: Type.String() }),
        },
        config(secretRef, "openai"),
        TraceContext.new(),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
      message: "模型返回的结构化结果不符合约定",
    });
    expect(createModelGatewayError("TIMEOUT").timedOut).toBe(true);
  });

  it("normalizes rate limits, timeouts and bounded retry counts", async () => {
    const credentials = new MemoryCredentialAdapter();
    const secretRef = await credentials.save("openai", "sk-retry-secret");
    let attempts = 0;
    const rateLimited = new OpenAiAdapter(credentials, {
      fetchImpl: async () => {
        attempts += 1;
        return new Response("slow down", { status: 429 });
      },
    });
    await expect(
      rateLimited.complete(
        {
          messages: [{ role: "user", content: "return JSON" }],
          outputSchema: Type.Object({ answer: Type.String() }),
        },
        config(secretRef, "openai"),
        TraceContext.new(),
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryCount: 1 });
    expect(attempts).toBe(2);

    const timedOut = new OpenAiAdapter(credentials, {
      fetchImpl: async () => {
        throw new DOMException("request aborted", "AbortError");
      },
    });
    await expect(
      timedOut.complete(
        {
          messages: [{ role: "user", content: "return JSON" }],
          outputSchema: Type.Object({ answer: Type.String() }),
        },
        { ...config(secretRef, "openai"), maxAttempts: 1 },
        TraceContext.new(),
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT", timedOut: true });
  });
});
