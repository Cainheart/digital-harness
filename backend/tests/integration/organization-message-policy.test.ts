import { describe, expect, it } from "vitest";
import {
  BossDirectionService,
  OrganizationService,
} from "../../src/application/organization-service.js";
import { Approval } from "../../src/domain/entities.js";
import { TaskStatus, utcNow, newObjectId } from "../../src/domain/common.js";
import { EvidenceRepository } from "../../src/infra/repositories/evidence.js";
import { ProjectTaskRepository } from "../../src/infra/repositories/project-task.js";
import {
  createTestApp,
  makeProject,
  makeTask,
  useTestRoot,
} from "../helpers.js";

describe("Task 3 organization, messages and policy integration", () => {
  it("initializes five domains and an office projection without hidden policy fields", async () => {
    const app = await createTestApp(useTestRoot());
    const organization = await app.inject({
      method: "GET",
      url: "/api/v1/organization",
    });
    expect(organization.statusCode).toBe(200);
    const body = organization.json() as {
      domains: unknown[];
      roles: Array<Record<string, unknown>>;
      members: unknown[];
    };
    expect(body.domains).toHaveLength(5);
    expect(body.roles.length).toBeGreaterThanOrEqual(19);
    expect(body.members).toHaveLength(19);
    const office = await app.inject({
      method: "GET",
      url: "/api/v1/organization/office-view",
    });
    const projection = office.json() as {
      domains: Array<Record<string, unknown>>;
    };
    expect(office.statusCode).toBe(200);
    expect(
      projection.domains.find((item) => item.groupName === "development")
        ?.officeZone,
    ).toBe("研发区");
    expect(
      projection.domains.find((item) => item.groupName === "npi")?.officeZone,
    ).toBe("研发区");
    expect(JSON.stringify(projection)).not.toContain("allowedTools");
    await app.close();
  });

  it("rejects incomplete messages before writing a business event", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    new ProjectTaskRepository();
    app.runtime.database.transaction((connection) => {
      const repo = new ProjectTaskRepository();
      repo.createProject(connection, project);
      repo.createTask(connection, task);
    });
    const beforeMessages = (
      app.runtime.database.connection
        .prepare("SELECT COUNT(*) AS count FROM structured_messages")
        .get() as { count: number }
    ).count;
    const beforeEvents = (
      app.runtime.database.connection
        .prepare("SELECT COUNT(*) AS count FROM domain_events")
        .get() as { count: number }
    ).count;
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload: {
        sender: { roleId: "product_solution_pm", instanceId: "emp_02" },
        projectId: project.id,
        taskId: task.id,
        messageType: "task_assignment",
        payload: {},
        idempotencyKey: "missing_receiver",
      },
    });
    const invalidReference = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload: {
        sender: { roleId: "product_solution_pm", instanceId: "emp_02" },
        receiver: { roleId: "developer_representative", instanceId: "emp_07" },
        projectId: project.id,
        taskId: task.id,
        messageType: "task_assignment",
        payload: {},
        idempotencyKey: "partial-response-reference",
        responseObjectType: "task",
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().code).toBe("INVALID_MESSAGE");
    expect(invalidReference.statusCode).toBe(422);
    expect(invalidReference.json().code).toBe("INVALID_MESSAGE");
    expect(
      (
        app.runtime.database.connection
          .prepare("SELECT COUNT(*) AS count FROM structured_messages")
          .get() as { count: number }
      ).count,
    ).toBe(beforeMessages);
    expect(
      (
        app.runtime.database.connection
          .prepare("SELECT COUNT(*) AS count FROM domain_events")
          .get() as { count: number }
      ).count,
    ).toBe(beforeEvents);
    await app.close();
  });

  it("rejects a forged Boss endpoint before inserting a message", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    app.runtime.database.transaction((connection) => {
      const repo = new ProjectTaskRepository();
      repo.createProject(connection, project);
      repo.createTask(connection, task);
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload: {
        sender: { roleId: "boss", instanceId: "boss-forged" },
        receiver: { roleId: "developer_representative", instanceId: "emp_07" },
        projectId: project.id,
        taskId: task.id,
        messageType: "approval_direction",
        payload: { direction: "只允许真实 Boss 身份" },
        idempotencyKey: "forged-boss",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("INVALID_MESSAGE");
    expect(
      (
        app.runtime.database.connection
          .prepare("SELECT COUNT(*) AS count FROM structured_messages")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    await app.close();
  });

  it("rejects a message with a missing trace object", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    app.runtime.database.transaction((connection) => {
      const repo = new ProjectTaskRepository();
      repo.createProject(connection, project);
      repo.createTask(connection, task);
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload: {
        sender: { roleId: "product_solution_pm", instanceId: "emp_02" },
        receiver: { roleId: "developer_representative", instanceId: "emp_07" },
        projectId: project.id,
        taskId: task.id,
        messageType: "review_feedback",
        payload: {},
        idempotencyKey: "missing-source",
        sourceObjectType: "approval",
        sourceObjectId: "approval_missing",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("INVALID_MESSAGE");
    expect(
      (
        app.runtime.database.connection
          .prepare("SELECT COUNT(*) AS count FROM structured_messages")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    await app.close();
  });

  it("persists, traces and acknowledges a valid message idempotently", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    app.runtime.database.transaction((connection) => {
      const repo = new ProjectTaskRepository();
      repo.createProject(connection, project);
      repo.createTask(connection, task);
    });
    const payload = {
      sender: { roleId: "product_solution_pm", instanceId: "emp_02" },
      receiver: { roleId: "developer_representative", instanceId: "emp_07" },
      projectId: project.id,
      taskId: task.id,
      messageType: "feasibility_opinion",
      payload: { decision: "needs_clarification", issues: ["边界不清"] },
      idempotencyKey: "msg-feasibility-1",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload: {
        ...payload,
        payload: { issues: ["边界不清"], decision: "needs_clarification" },
      },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().messageId).toBe(first.json().messageId);
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_type='structured_message'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/messages?projectId=${project.id}&taskId=${task.id}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${first.json().messageId}/acknowledge`,
      payload: { handledBy: "emp_07" },
    });
    const repeatedAcknowledged = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${first.json().messageId}/acknowledge`,
      payload: { handledBy: "emp_07" },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().status).toBe("acknowledged");
    expect(acknowledged.json().handledBy).toBe("emp_07");
    expect(repeatedAcknowledged.statusCode).toBe(200);
    expect(repeatedAcknowledged.json().version).toBe(2);
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_type='structured_message'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(2);
    await app.close();
  });

  it("binds new attempts to the new role version while preserving the old snapshot", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id, { ownerRole: "backend_developer" });
    app.runtime.database.transaction((connection) => {
      const repo = new ProjectTaskRepository();
      repo.createProject(connection, project);
      repo.createTask(connection, task);
    });
    const service = new OrganizationService(app.runtime.database);
    const firstGrant = service.createExecutionGrant({
      projectId: project.id,
      taskId: task.id,
      attemptId: "attempt_old",
      roleId: "backend_developer",
      modelConfigVersion: "model-v1",
      workspaceRoot: "workspace_old",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      traceId: "tr_attempt_old",
    });
    const changed = { ...service.getRole("backend_developer"), roleVersion: 2 };
    service.replaceRole(changed);
    const secondGrant = service.createExecutionGrant({
      projectId: project.id,
      taskId: task.id,
      attemptId: "attempt_new",
      roleId: "backend_developer",
      modelConfigVersion: "model-v2",
      workspaceRoot: "workspace_new",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      traceId: "tr_attempt_new",
    });
    expect(firstGrant.roleVersion).toBe(1);
    expect(secondGrant.roleVersion).toBe(2);
    const rows = app.runtime.database.connection
      .prepare(
        "SELECT id,role_version,policy_snapshot_json FROM execution_attempts WHERE id IN ('attempt_old','attempt_new') ORDER BY id",
      )
      .all() as Array<{
      id: string;
      role_version: number;
      policy_snapshot_json: string;
    }>;
    expect(rows.map((row) => row.role_version)).toEqual([2, 1]);
    expect(rows.every((row) => row.policy_snapshot_json.length > 2)).toBe(true);
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_events WHERE event_type='RolePolicyVersionChanged'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    await app.close();
  });

  it("persists policy decisions and emits a redacted security event for API denials", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    app.runtime.database.transaction((connection) => {
      const repo = new ProjectTaskRepository();
      repo.createProject(connection, project);
      repo.createTask(connection, task);
    });
    const service = new OrganizationService(app.runtime.database);
    const grant = service.createExecutionGrant({
      projectId: project.id,
      taskId: task.id,
      attemptId: "attempt_policy_audit",
      roleId: "functional_tester",
      modelConfigVersion: "model-v1",
      workspaceRoot: "workspace_policy",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      traceId: "tr_policy_audit",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/policy/authorize-action",
      payload: {
        roleId: "functional_tester",
        action: {
          kind: "use_tool",
          toolName: "file.write",
          path: "workspace://project/src/app.ts",
          pathMode: "write",
          projectId: project.id,
          taskId: task.id,
        },
        grant,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().decision).toBe("reject");
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM policy_decisions WHERE decision='reject'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_events WHERE event_type='SecurityPolicyDenied'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    await app.close();
  });

  it("converts Boss direction into a lead task and response artifact requirement", async () => {
    const app = await createTestApp(useTestRoot());
    const project = makeProject();
    const task = makeTask(project.id);
    const approval: Approval = {
      id: newObjectId("approval"),
      projectId: project.id,
      taskId: task.id,
      approvalType: "requirement_dispute",
      subjectType: "task",
      subjectId: task.id,
      artifactVersionId: null,
      evidenceVersionId: null,
      decision: "rejected",
      direction: null,
      bossId: "boss-local",
      status: "waiting_direction",
      responseTaskId: null,
      createdAt: utcNow(),
      decidedAt: null,
      version: 1,
    };
    app.runtime.database.transaction((connection) => {
      const projects = new ProjectTaskRepository();
      projects.createProject(connection, project);
      projects.createTask(connection, task);
      new EvidenceRepository().createApproval(connection, approval);
    });
    const directions = new BossDirectionService(app.runtime.database);
    const result = directions.convert({
      approvalId: approval.id,
      directionOpinion: "优先保证主流程",
      assignedLead: {
        roleId: "developer_representative",
        instanceId: "emp_07",
      },
    });
    const repeated = directions.convert({
      approvalId: approval.id,
      directionOpinion: "优先保证主流程",
      assignedLead: {
        roleId: "developer_representative",
        instanceId: "emp_07",
      },
    });
    expect(result.assignedLead.roleId).toBe("developer_representative");
    expect(result.responseArtifactRequired).toBe(true);
    expect(repeated).toEqual(result);
    expect(
      (
        app.runtime.database.connection
          .prepare("SELECT expected_deliverables_json FROM tasks WHERE id=?")
          .get(result.responseTaskId) as { expected_deliverables_json: string }
      ).expected_deliverables_json,
    ).toContain("response-artifact");
    const message = app.runtime.database.connection
      .prepare(
        "SELECT response_object_type,response_object_id FROM structured_messages WHERE message_id=?",
      )
      .get(result.messageId) as {
      response_object_type: string;
      response_object_id: string;
    };
    expect(message).toEqual({
      response_object_type: "task",
      response_object_id: result.responseTaskId,
    });
    expect(
      (
        app.runtime.database.connection
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id=?")
          .get(project.id) as { count: number }
      ).count,
    ).toBe(2);
    expect(
      (
        app.runtime.database.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_type='approval' AND aggregate_id=?",
          )
          .get(approval.id) as { count: number }
      ).count,
    ).toBe(1);
    await app.close();
  });
});
