import { describe, expect, it } from "vitest";
import { createTestApp, useTestRoot } from "../helpers.js";

describe("Task 5 model settings and credential boundary", () => {
  it("keeps five domains independent and returns no secret material", async () => {
    const app = await createTestApp(useTestRoot());
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/settings/models",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().items).toHaveLength(5);
    expect(initial.body).not.toContain("secretRef");

    const product = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/models/product",
      payload: {
        provider: "openai",
        modelName: "gpt-test-model",
        credential: "sk-fake-task5-secret",
        expectedConfigVersion: 0,
        idempotencyKey: "model-product-v1",
      },
    });
    const development = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/models/development",
      payload: {
        provider: "deepseek",
        modelName: "deepseek-test-model",
        credential: "sk-fake-development-secret",
        expectedConfigVersion: 0,
        idempotencyKey: "model-development-v1",
      },
    });
    for (const [domain, provider] of [
      ["npi", "openai"],
      ["testing", "deepseek"],
      ["project_management", "openai"],
    ] as const) {
      const configured = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/models/${domain}`,
        payload: {
          provider,
          modelName: `${provider}-${domain}-test-model`,
          credential: `sk-${domain}-secret`,
          expectedConfigVersion: 0,
          idempotencyKey: `model-${domain}-v1`,
        },
      });
      expect(configured.statusCode).toBe(200);
    }
    expect(product.statusCode).toBe(200);
    expect(development.statusCode).toBe(200);
    expect(product.body).not.toContain("sk-fake-task5-secret");
    expect(development.body).not.toContain("sk-fake-development-secret");
    expect(product.json().domain).toBe("product");
    expect(product.json().configVersion).toBe(1);
    expect(development.json().provider).toBe("deepseek");
    const replay = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/models/product",
      payload: {
        provider: "openai",
        modelName: "gpt-test-model",
        credential: "sk-fake-task5-secret",
        expectedConfigVersion: 0,
        idempotencyKey: "model-product-v1",
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().configVersion).toBe(1);

    const database = app.runtime.database.connection;
    const stored = database
      .prepare(
        "SELECT domain,provider,model_name,config_version,secret_ref FROM model_configs ORDER BY domain",
      )
      .all() as Array<{
      domain: string;
      provider: string;
      model_name: string;
      config_version: number;
      secret_ref: string | null;
    }>;
    expect(stored.find((row) => row.domain === "product")?.config_version).toBe(1);
    expect(stored.find((row) => row.domain === "development")?.config_version).toBe(1);
    expect(stored.every((row) => !row.secret_ref?.includes("sk-fake"))).toBe(true);
    expect(app.runtime.database.readEventText()).not.toContain("sk-fake");
    await app.close();
  });

  it("freezes the old config version and rejects stale concurrent updates", async () => {
    const app = await createTestApp(useTestRoot());
    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/models/testing",
      payload: {
        provider: "openai",
        modelName: "gpt-v1",
        credential: "sk-testing-v1",
        expectedConfigVersion: 0,
        idempotencyKey: "model-testing-v1",
      },
    });
    expect(first.statusCode).toBe(200);
    const frozen = app.runtime.modelSettings.freeze("testing");

    const second = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/models/testing",
      payload: {
        provider: "openai",
        modelName: "gpt-v2",
        credential: "sk-testing-v2",
        expectedConfigVersion: 1,
        idempotencyKey: "model-testing-v2",
      },
    });
    expect(second.statusCode).toBe(200);
    expect(frozen.configVersion).toBe(1);
    expect(frozen.modelName).toBe("gpt-v1");
    expect(app.runtime.modelSettings.freeze("testing").configVersion).toBe(2);

    const stale = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/models/testing",
      payload: {
        provider: "openai",
        modelName: "gpt-stale",
        credential: "sk-testing-stale",
        expectedConfigVersion: 1,
        idempotencyKey: "model-testing-stale",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("VERSION_CONFLICT");
    await app.close();
  });

  it("deletes credentials without allowing a task to silently switch provider", async () => {
    const app = await createTestApp(useTestRoot());
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/models/npi",
      payload: {
        provider: "deepseek",
        modelName: "deepseek-v1",
        credential: "sk-npi-secret",
        expectedConfigVersion: 0,
        idempotencyKey: "model-npi-v1",
      },
    });
    expect(saved.statusCode).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/settings/models/npi/credential",
      payload: {
        expectedConfigVersion: 1,
        idempotencyKey: "model-npi-delete-v1",
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().credentialStatus).toBe("missing");
    expect(deleted.json().connectionStatus).toBe("blocked");
    expect(deleted.json().provider).toBe("deepseek");

    const connection = await app.inject({
      method: "POST",
      url: "/api/v1/settings/models/npi/connection-test",
    });
    expect(connection.statusCode).toBe(503);
    expect(connection.json().errorCode).toBe("CREDENTIAL_UNAVAILABLE");
    expect(connection.body).not.toContain("sk-npi-secret");
    await app.close();
  });
});
