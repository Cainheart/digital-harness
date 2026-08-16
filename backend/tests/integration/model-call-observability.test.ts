import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { makeProject, makeTask, createTestApp, useTestRoot } from "../helpers.js";
import { ExecutionRepository } from "../../src/infra/repositories/execution.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import { newObjectId, utcNow } from "../../src/domain/common.js";
import { OpenAiAdapter } from "../../src/gateway/model/openai-adapter.js";
import { ModelAdapterRegistry, ModelGateway } from "../../src/gateway/model/gateway.js";
import { ModelGatewayError } from "../../src/gateway/model/errors.js";
import { SqliteModelCallRecorder } from "../../src/observability/model-call-recorder.js";
import { summarizeModelInput } from "../../src/observability/redaction.js";
import { TraceContext } from "../../src/observability/trace.js";

describe("Task 5 model call lifecycle and cost observability", () => {
  it("records a successful call, links it to the task and aggregates cost", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    const attempt = {
      id: newObjectId("execution_attempt"),
      projectId: project.id,
      taskId: task.id,
      role: "developer",
      modelConfigVersion: "3",
      workspaceRef: "workspace://task5",
      workerLeaseId: null,
      status: "running",
      startedAt: utcNow(),
      endedAt: null,
      retryOfAttemptId: null,
      retryCount: 0,
      traceId: "tr_task5_attempt",
      version: 1,
    };
    app.runtime.database.transaction((connection) => {
      const projects = new ProjectTaskRepository();
      projects.createProject(connection, project);
      projects.createTask(connection, task);
      new ExecutionRepository().createAttempt(connection, attempt);
    });

    const adapter = new OpenAiAdapter(app.runtime.credentials, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: "req-observable",
            choices: [
              { finish_reason: "stop", message: { content: '{"answer":"ok"}' } },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
          { status: 200 },
        ),
    });
    const secretRef = await app.runtime.credentials.save("openai", "sk-observe-secret");
    const recorder = new SqliteModelCallRecorder(app.runtime.database, () => ({
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000,
    }));
    const gateway = new ModelGateway(
      new ModelAdapterRegistry([adapter]),
      recorder,
    );
    const trace = TraceContext.new();
    const response = await gateway.complete(
      {
        messages: [{ role: "user", content: "return JSON" }],
        outputSchema: Type.Object({ answer: Type.String() }),
      },
      {
        domain: "development",
        provider: "openai",
        modelName: "test-model",
        configVersion: 3,
        secretRef,
        timeoutMs: 1000,
        maxAttempts: 1,
      },
      {
        projectId: project.id,
        taskId: task.id,
        attemptId: attempt.id,
        role: "developer",
        trace,
      },
    );
    expect(response.output).toEqual({ answer: "ok" });
    const listed = recorder.list({ projectId: project.id });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      projectId: project.id,
      taskId: task.id,
      attemptId: attempt.id,
      domain: "development",
      configVersion: 3,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      costMicros: 8,
      finalStatus: "succeeded",
      traceId: trace.traceId,
    });
    expect(listed.items[0]?.inputSummary).not.toContain("return JSON");
    expect(JSON.stringify(listed)).not.toContain("sk-observe-secret");
    expect(listed.aggregate[0]).toMatchObject({
      callCount: 1,
      totalTokens: 5,
      costMicros: 8,
      retryCount: 0,
    });
    const links = app.runtime.database.connection
      .prepare(
        "SELECT target_type,target_id FROM trace_links WHERE source_type='model_call'",
      )
      .all() as Array<{ target_type: string; target_id: string }>;
    expect(links.map((link) => link.target_type).sort()).toEqual([
      "execution_attempt",
      "task",
    ]);
    const consoleResponse = await app.inject({
      method: "GET",
      url: `/api/v1/executions?projectId=${project.id}`,
    });
    expect(consoleResponse.statusCode).toBe(200);
    expect(consoleResponse.json().items[0].modelCallId).toBe(listed.items[0]?.modelCallId);
    await app.close();
  });

  it("persists normalized failure without persisting provider response text", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    const attempt = {
      id: newObjectId("execution_attempt"),
      projectId: project.id,
      taskId: task.id,
      role: "developer",
      modelConfigVersion: "1",
      workspaceRef: "workspace://task5-failure",
      workerLeaseId: null,
      status: "running",
      startedAt: utcNow(),
      endedAt: null,
      retryOfAttemptId: null,
      retryCount: 0,
      traceId: "tr_task5_failure",
      version: 1,
    };
    app.runtime.database.transaction((connection) => {
      const projects = new ProjectTaskRepository();
      projects.createProject(connection, project);
      projects.createTask(connection, task);
      new ExecutionRepository().createAttempt(connection, attempt);
    });
    const adapter = new OpenAiAdapter(app.runtime.credentials, {
      fetchImpl: async () => new Response("provider internal secret detail", { status: 503 }),
    });
    const secretRef = await app.runtime.credentials.save("openai", "sk-failure-secret");
    const gateway = new ModelGateway(
      new ModelAdapterRegistry([adapter]),
      new SqliteModelCallRecorder(app.runtime.database),
    );
    await expect(
      gateway.complete(
        {
          messages: [{ role: "user", content: "return JSON" }],
          outputSchema: Type.Object({ answer: Type.String() }),
        },
        {
          domain: "development",
          provider: "openai",
          modelName: "test-model",
          configVersion: 1,
          secretRef,
          timeoutMs: 1000,
          maxAttempts: 1,
        },
        {
          projectId: project.id,
          taskId: task.id,
          attemptId: attempt.id,
          role: "developer",
          trace: TraceContext.new(),
        },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const call = new SqliteModelCallRecorder(app.runtime.database).list({
      projectId: project.id,
    }).items[0];
    expect(call?.finalStatus).toBe("failed");
    expect(call?.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(call)).not.toContain("provider internal secret detail");
    expect(JSON.stringify(call)).not.toContain("sk-failure-secret");

    const recorder = new SqliteModelCallRecorder(app.runtime.database);
    const redactionHandle = await recorder.started({
      projectId: project.id,
      taskId: task.id,
      attemptId: attempt.id,
      domain: "development",
      role: "developer",
      provider: "openai",
      modelName: "test-model",
      configVersion: 1,
      timeoutMs: 1000,
      trace: TraceContext.new(),
      inputSummary: summarizeModelInput({
        messages: [{ role: "user", content: "return JSON" }],
        outputSchema: Type.Object({ answer: Type.String() }),
      }),
    });
    await recorder.failed(redactionHandle, {
      error: new ModelGatewayError(
        "REDACTION_FAILED",
        "模型结果未通过脱敏安全检查",
        false,
      ),
      retryCount: 0,
    });
    const redactionCall = recorder.list({ projectId: project.id }).items.find(
      (item) => item.errorCode === "REDACTION_FAILED",
    );
    expect(redactionCall?.redactionStatus).toBe("failed");
    await app.close();
  });
});
