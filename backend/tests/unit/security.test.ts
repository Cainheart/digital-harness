import { describe, expect, it } from "vitest";
import {
  MemoryCredentialAdapter,
  SecretLease,
} from "../../src/infra/keychain.js";
import { redact } from "../../src/security/redaction.js";
import { redactJson } from "../../src/security/redaction.js";
import { TraceContext } from "../../src/observability/trace.js";

describe("security and observability adapters", () => {
  it("redacts bearer and API key values", () => {
    expect(
      redact("Authorization: Bearer abc-secret sk-live-secret", ["abc-secret"]),
    ).toBe("Authorization: Bearer [REDACTED] [REDACTED]");
  });
  it("redacts sensitive fields in structured audit metadata", () => {
    expect(
      redactJson({ token: "secret-value", nested: { prompt: "hidden" } }),
    ).toBe('{"token":"[REDACTED]","nested":{"prompt":"[REDACTED]"}}');
  });
  it("keeps credentials in memory leases and never in string output", async () => {
    const adapter = new MemoryCredentialAdapter();
    const ref = await adapter.save("openai", "secret-value");
    const lease = await adapter.read(ref);
    expect(ref).toMatch(/^memory:\/\//);
    expect(lease).toBeInstanceOf(SecretLease);
    expect(String(lease)).not.toContain("secret-value");
    expect((await adapter.check(ref)).available).toBe(true);
    await adapter.delete(ref);
    expect((await adapter.check(ref)).available).toBe(false);
  });
  it("propagates trace id while changing span id", () => {
    const root = TraceContext.new();
    const child = root.child();
    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).not.toBe(root.spanId);
    expect(child.parentSpanId).toBe(root.spanId);
  });
});
