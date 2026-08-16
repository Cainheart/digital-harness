import { Database, DatabaseConnection } from "../infra/database.js";
import { newObjectId, TaskStatus, utcNow } from "../domain/common.js";
import { Task } from "../domain/entities.js";
import { DomainEventDraft } from "../domain/events.js";
import { InvalidArgumentError, NotFoundError } from "../domain/errors.js";
import {
  INITIAL_ORGANIZATION,
  canonicalRoleId,
} from "../domain/organization/definitions.js";
import {
  CreateMessageInput,
  parseCreateMessage,
  StructuredMessage,
} from "../domain/messages.js";
import { OrganizationRepository } from "../infra/repositories/organization.js";
import { StructuredMessageRepository } from "../infra/repositories/messages.js";
import { ProjectTaskRepository } from "../infra/repositories/project-task.js";
import { EvidenceRepository } from "../infra/repositories/evidence.js";
import { SqliteEventStore } from "../infra/repositories/events.js";
import { PolicyDecisionRepository } from "../policy/decision-repository.js";
import { PolicyGate } from "../policy/policy-gate.js";
import { Action, ExecutionGrant, PolicyDecision } from "../policy/types.js";

/** 组织查询、岗位版本更新、结构化消息和 Policy Gate 的应用服务集合。 */
export class OrganizationService {
  readonly organizationRepository: OrganizationRepository;
  readonly messageRepository: StructuredMessageRepository;
  readonly eventStore: SqliteEventStore;
  readonly policyDecisionRepository: PolicyDecisionRepository;
  readonly policyGate: PolicyGate;
  /** 组装 Task 3 服务并绑定已有 SQLite 数据库。 */
  constructor(
    private readonly database: Database,
    dependencies: {
      organizationRepository?: OrganizationRepository;
      messageRepository?: StructuredMessageRepository;
      eventStore?: SqliteEventStore;
      policyDecisionRepository?: PolicyDecisionRepository;
      policyGate?: PolicyGate;
    } = {},
  ) {
    this.organizationRepository =
      dependencies.organizationRepository ?? new OrganizationRepository();
    this.messageRepository =
      dependencies.messageRepository ?? new StructuredMessageRepository();
    this.eventStore = dependencies.eventStore ?? new SqliteEventStore();
    this.policyDecisionRepository =
      dependencies.policyDecisionRepository ?? new PolicyDecisionRepository();
    this.policyGate = dependencies.policyGate ?? new PolicyGate();
  }
  /** 返回完整组织配置，供设置页和组织图消费。 */
  getOrganization(): typeof INITIAL_ORGANIZATION {
    return this.organizationRepository.getOrganization(
      this.database.connection,
      INITIAL_ORGANIZATION,
    ) as typeof INITIAL_ORGANIZATION;
  }
  /** 返回只含展示字段的办公室投影，不暴露完整策略或内部参数。 */
  getOfficeView(): {
    domains: Array<{
      domainId: string;
      displayName: string;
      officeZone: string;
      groupName: string;
      members: Array<{
        instanceId: string;
        displayName: string;
        roleId: string;
        specialistTag: string;
        status: string;
      }>;
    }>;
    bossDecisionBoundary: string[];
    version: number;
  } {
    const organization = this.organizationRepository.getOrganization(
      this.database.connection,
      INITIAL_ORGANIZATION,
    );
    return {
      domains: organization.domains.map((domain) => ({
        ...domain,
        members: organization.members
          .filter((member) => member.deskGroup === domain.groupName)
          .map((member) => ({
            instanceId: member.instanceId,
            displayName: member.displayName,
            roleId: member.roleId,
            specialistTag: member.specialistTag,
            status: member.status,
          })),
      })),
      bossDecisionBoundary: organization.bossDecisionBoundary,
      version: organization.version,
    };
  }
  /** 返回当前启用岗位定义；完整策略仅对内部 Policy Gate 使用。 */
  listRoles(): ReturnType<OrganizationRepository["listRoles"]> {
    return this.organizationRepository.listRoles(this.database.connection);
  }
  /** 返回一个岗位定义，兼容 role_ 前缀输入。 */
  getRole(roleId: string): ReturnType<OrganizationRepository["getRole"]> {
    return this.organizationRepository.getRole(
      this.database.connection,
      roleId,
    );
  }
  /** 递增岗位策略版本并记录策略变更；历史 Attempt 的快照不会被更新。 */
  // 修改日期：2026-08-16
  // 修改原因：策略版本变更本身是可审计的安全事实；没有变更事件就无法解释新旧 Attempt 为何使用不同授权。
  replaceRole(
    role: Parameters<OrganizationRepository["replaceRole"]>[1],
  ): ReturnType<OrganizationRepository["replaceRole"]> {
    return this.database.transaction((connection) => {
      const before = this.organizationRepository.getRole(
        connection,
        role.roleId,
      );
      const result = this.organizationRepository.replaceRole(connection, role);
      connection
        .prepare(
          "INSERT INTO runtime_events (event_type,trace_id,payload,occurred_at) VALUES (?,?,?,?)",
        )
        .run(
          "RolePolicyVersionChanged",
          `tr_role_policy_${role.roleId}_${role.roleVersion}`,
          JSON.stringify({
            roleId: role.roleId,
            beforeRoleVersion: before.roleVersion,
            afterRoleVersion: role.roleVersion,
          }),
          utcNow(),
        );
      return result;
    });
  }
  /** 启用岗位前执行完整性检查；任一职责字段为空都会返回 INVALID_ROLE_DEFINITION。 */
  enableRole(roleId: string): ReturnType<OrganizationRepository["enableRole"]> {
    return this.database.transaction((connection) => {
      const result = this.organizationRepository.enableRole(connection, roleId);
      connection
        .prepare(
          "INSERT INTO runtime_events (event_type,trace_id,payload,occurred_at) VALUES (?,?,?,?)",
        )
        .run(
          "RoleEnabled",
          `tr_role_enabled_${result.roleId}`,
          JSON.stringify({
            roleId: result.roleId,
            roleVersion: result.roleVersion,
          }),
          utcNow(),
        );
      return result;
    });
  }
  /** 禁用岗位并留下安全审计；已存在的历史 Attempt 不被修改。 */
  disableRole(roleId: string): void {
    this.database.transaction((connection) => {
      this.organizationRepository.disableRole(connection, roleId);
      connection
        .prepare(
          "INSERT INTO runtime_events (event_type,trace_id,payload,occurred_at) VALUES (?,?,?,?)",
        )
        .run(
          "RoleDisabled",
          `tr_role_disabled_${canonicalRoleId(roleId)}`,
          JSON.stringify({ roleId: canonicalRoleId(roleId) }),
          utcNow(),
        );
    });
  }
  /** 发送一条带领域事件的结构化消息；校验失败发生在事件追加之前。 */
  sendMessage(raw: unknown): StructuredMessage {
    const input = parseCreateMessage(raw);
    return this.database.transaction((connection) => {
      const result = this.messageRepository.create(connection, input);
      if (!result.created) return result.message;
      this.eventStore.append(
        connection,
        "structured_message",
        result.message.messageId,
        0,
        [this.messageEvent(result.message, "StructuredMessageCreated")],
      );
      return result.message;
    });
  }
  /** 按项目和任务查询消息，不改变状态。 */
  listMessages(input: {
    projectId?: string | null;
    taskId?: string | null;
    limit?: number;
    cursor?: string | null;
  }): ReturnType<StructuredMessageRepository["list"]> {
    return this.messageRepository.list(this.database.connection, {
      ...input,
      limit: input.limit ?? 100,
      cursor: input.cursor ?? null,
    });
  }
  /** 确认消息并追加处理事件；重复 acknowledge 保持幂等且不重复追加事件。 */
  // 修改日期：2026-08-16
  // 修改原因：状态推进和领域事件必须共用同一事务；重复回调只返回已确认事实，不能制造第二条处理事件。
  acknowledgeMessage(messageId: string, handledBy: string): StructuredMessage {
    return this.database.transaction((connection) => {
      const result = this.messageRepository.acknowledge(
        connection,
        messageId,
        handledBy,
      );
      if (result.changed) {
        const expectedVersion = this.eventStore.countForAggregate(
          connection,
          "structured_message",
          result.message.messageId,
        );
        this.eventStore.append(
          connection,
          "structured_message",
          result.message.messageId,
          expectedVersion,
          [this.messageEvent(result.message, "StructuredMessageAcknowledged")],
        );
      }
      return result.message;
    });
  }
  /** 为新的执行 Attempt 固定当前岗位版本和策略快照，并返回 Worker Grant。 */
  // 修改日期：2026-08-16
  // 修改原因：taskVersion 不一致或重复 Attempt ID 会破坏历史授权不可变性，必须在写入前拒绝而不是依赖 SQLite 的泛化约束错误。
  createExecutionGrant(input: {
    projectId: string;
    taskId: string;
    attemptId: string;
    roleId: string;
    taskVersion?: number;
    modelConfigVersion: string;
    workspaceRoot: string;
    deadline: string;
    leaseExpiresAt: string;
    traceId: string;
  }): ExecutionGrant {
    return this.database.transaction((connection) => {
      const role = this.organizationRepository.getRole(
        connection,
        input.roleId,
      );
      const task = new ProjectTaskRepository().getTask(
        connection,
        input.taskId,
      );
      if (task.projectId !== input.projectId)
        throw new NotFoundError("任务不属于指定项目");
      if (input.taskVersion !== undefined && input.taskVersion !== task.version)
        throw new InvalidArgumentError("taskVersion 与当前任务版本不一致");
      if (
        connection
          .prepare("SELECT 1 FROM execution_attempts WHERE id=?")
          .get(input.attemptId)
      )
        throw new InvalidArgumentError(
          "Attempt ID 已存在，不能覆盖历史执行授权",
        );
      // 修改日期：2026-08-16
      // 修改原因：Task 5 要求 Attempt 创建时复制领域、供应商、模型和凭据引用，运行中的 Attempt 不受后续设置变更影响。
      const modelConfigVersion = Number(input.modelConfigVersion);
      const frozenModel = Number.isSafeInteger(modelConfigVersion)
        ? (connection
            .prepare(
              "SELECT domain,provider,model_name,secret_ref FROM model_configs WHERE domain=? AND config_version=? AND credential_status='configured'",
            )
            .get(role.domain, modelConfigVersion) as
            | {
                domain: string;
                provider: string;
                model_name: string;
                secret_ref: string;
              }
            | undefined)
        : undefined;
      const grant = this.policyGate.createGrant({
        projectId: input.projectId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        taskVersion: input.taskVersion ?? task.version,
        role,
        workspaceRoot: input.workspaceRoot,
        deadline: input.deadline,
        leaseExpiresAt: input.leaseExpiresAt,
        traceId: input.traceId,
      });
      connection
        .prepare(
          "INSERT INTO execution_attempts (id,project_id,task_id,role,role_version,policy_snapshot_json,model_config_version,model_domain,model_provider,model_name,model_secret_ref,model_timeout_ms,model_retry_max_attempts,workspace_ref,worker_lease_id,status,started_at,ended_at,retry_of_attempt_id,retry_count,trace_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.attemptId,
          input.projectId,
          input.taskId,
          canonicalRoleId(role.roleId),
          role.roleVersion,
          JSON.stringify({
            allowedTools: role.allowedTools,
            allowedObjects: role.allowedObjects,
            forbiddenActions: role.forbiddenActions,
            objectActions: role.objectActions,
            pathPolicy: role.pathPolicy,
            commandPolicy: role.commandPolicy,
          }),
          input.modelConfigVersion,
          frozenModel?.domain ?? null,
          frozenModel?.provider ?? null,
          frozenModel?.model_name ?? null,
          frozenModel?.secret_ref ?? null,
          frozenModel ? 30_000 : null,
          frozenModel ? 2 : null,
          input.workspaceRoot,
          null,
          "created",
          utcNow(),
          null,
          null,
          0,
          input.traceId,
          1,
        );
      return grant;
    });
  }
  /** 评价动作并保存项目/任务范围内的策略审计结果。 */
  async authorizeAction(
    roleId: string,
    action: Action,
    grant: ExecutionGrant,
  ): Promise<PolicyDecision> {
    const role = this.getRole(roleId);
    const decision = await this.policyGate.authorizeAction(role, action, grant);
    this.database.transaction((connection) =>
      this.policyDecisionRepository.save(connection, decision, {
        projectId: grant.projectId,
        taskId: grant.taskId,
        attemptId: grant.attemptId,
      }),
    );
    return decision;
  }
  /** 评价结构化计划并保存首个拒绝或最终允许结果。 */
  async evaluatePlan(
    roleId: string,
    task: Pick<Task, "id" | "projectId" | "ownerRole" | "version">,
    plan: Parameters<PolicyGate["evaluatePlan"]>[2],
    grant: ExecutionGrant,
  ): Promise<PolicyDecision> {
    const role = this.getRole(roleId);
    const decision = await this.policyGate.evaluatePlan(
      role,
      task,
      plan,
      grant,
    );
    this.database.transaction((connection) =>
      this.policyDecisionRepository.save(connection, decision, {
        projectId: grant.projectId,
        taskId: grant.taskId,
        attemptId: grant.attemptId,
      }),
    );
    return decision;
  }
  /** 将结构化消息转换为事件草稿，保留原始对象和 trace 关联但不写敏感内容。 */
  private messageEvent(
    message: StructuredMessage,
    eventType: string,
  ): DomainEventDraft {
    return {
      eventType,
      aggregateType: "structured_message",
      aggregateId: message.messageId,
      aggregateVersion: 0,
      payload: {
        messageId: message.messageId,
        projectId: message.projectId,
        taskId: message.taskId,
        messageType: message.messageType,
        senderRole: message.sender.roleId,
        receiverRole: message.receiver.roleId,
        sourceObjectType: message.sourceObjectType,
        sourceObjectId: message.sourceObjectId,
        responseObjectType: message.responseObjectType,
        responseObjectId: message.responseObjectId,
      },
      inputSummary: { messageType: message.messageType },
      outputSummary: { status: message.status },
      result: "success",
      failure: null,
      retryCount: 0,
      durationMs: 0,
      actor: { type: "role", id: message.sender.instanceId },
      traceId: message.traceId ?? `tr_message_${message.messageId}`,
      occurredAt: message.createdAt,
      attemptId: null,
      rejectionReason: null,
      redactionReason: "message payload remains in structured message table",
      eventCategory: "ordinary",
    };
  }
}

/** Boss 方向交接允许接收方向级任务的责任岗位白名单。 */
const DIRECTION_LEAD_ROLES = new Set([
  "product_solution_pm",
  "developer_representative",
  "npi_lead",
  "test_lead",
  "process_supervisor",
  "quality_risk_supervisor",
]);
/** Boss 方向意见交接的应用服务；Boss 意见只产生责任岗位任务，不直接产生成员执行命令。 */
export class BossDirectionService {
  /** 将审批方向写入响应任务、组长消息和可追踪领域事件。 */
  constructor(
    private readonly database: Database,
    private readonly organization = new OrganizationRepository(),
    private readonly messages = new StructuredMessageRepository(),
    private readonly projects = new ProjectTaskRepository(),
    private readonly evidence = new EvidenceRepository(),
    private readonly events = new SqliteEventStore(),
  ) {}
  /** 创建或幂等返回响应任务，确保同一审批不会产生多条方向任务。 */
  // 修改日期：2026-08-16
  // 修改原因：审批重试和 Worker 重试都可能重复提交 Boss 方向；必须返回既有任务/消息并保留响应对象引用，不能重复派发。
  convert(input: {
    approvalId: string;
    directionOpinion: string;
    assignedLead: { roleId: string; instanceId: string };
    responseArtifactRequired?: boolean;
  }): {
    approvalId: string;
    directionOpinion: string;
    assignedLead: { roleId: string; instanceId: string };
    responseTaskId: string;
    responseArtifactRequired: boolean;
    messageId: string;
  } {
    if (!input.directionOpinion.trim())
      throw new InvalidArgumentError("directionOpinion 不能为空");
    return this.database.transaction((connection) => {
      const approval = this.evidence.getApproval(connection, input.approvalId);
      if (approval.responseTaskId)
        return this.readExistingConversion(
          connection,
          approval,
          input.directionOpinion,
        );
      const lead = this.organization.getMember(
        connection,
        input.assignedLead.instanceId,
      );
      this.assertLead(lead.roleId, input.assignedLead.roleId);
      const responseArtifactRequired = input.responseArtifactRequired !== false;
      const task: Task = {
        id: newObjectId("task_direction"),
        projectId: approval.projectId,
        title: `落实 Boss 方向：${input.directionOpinion.slice(0, 80)}`,
        ownerRole: canonicalRoleId(lead.roleId),
        specialistTag: lead.specialistTag,
        assignmentReason: `approval:${approval.id}`,
        priority: "P1",
        dependencies: approval.taskId ? [approval.taskId] : [],
        expectedDeliverables: responseArtifactRequired
          ? ["direction-response", "response-artifact"]
          : ["direction-response"],
        status: TaskStatus.PENDING,
        createdAt: utcNow(),
        startedAt: null,
        endedAt: null,
        version: 1,
      };
      this.projects.createTask(connection, task);
      const now = utcNow();
      connection
        .prepare(
          "UPDATE approvals SET direction=?,response_task_id=?,status=?,decided_at=?,version=version+1 WHERE id=? AND response_task_id IS NULL",
        )
        .run(
          input.directionOpinion,
          task.id,
          "direction_assigned",
          now,
          approval.id,
        );
      const messageInput: CreateMessageInput = {
        sender: { roleId: "boss", instanceId: approval.bossId },
        receiver: { roleId: lead.roleId, instanceId: lead.instanceId },
        projectId: approval.projectId,
        taskId: task.id,
        messageType: "approval_direction",
        payload: {
          approvalId: approval.id,
          directionOpinion: input.directionOpinion,
          responseTaskId: task.id,
          responseArtifactRequired,
        },
        idempotencyKey: `approval-direction-${approval.id}-${task.id}`,
        sourceObjectType: "approval",
        sourceObjectId: approval.id,
        responseObjectType: "task",
        responseObjectId: task.id,
        traceId: `tr_direction_${approval.id}`,
      };
      const messageResult = this.messages.create(connection, messageInput);
      const message = messageResult.message;
      if (messageResult.created)
        this.events.append(
          connection,
          "structured_message",
          message.messageId,
          0,
          [this.messageEvent(message, approval.bossId)],
        );
      const expectedVersion = this.events.countForAggregate(
        connection,
        "approval",
        approval.id,
      );
      this.events.append(connection, "approval", approval.id, expectedVersion, [
        {
          eventType: "BossDirectionAssigned",
          aggregateType: "approval",
          aggregateId: approval.id,
          payload: {
            projectId: approval.projectId,
            taskId: task.id,
            approvalId: approval.id,
            responseTaskId: task.id,
            assignedLeadRole: lead.roleId,
            assignedLeadInstance: lead.instanceId,
            responseArtifactRequired,
          },
          inputSummary: { approvalId: approval.id },
          outputSummary: { responseTaskId: task.id },
          result: "success",
          failure: null,
          retryCount: 0,
          durationMs: 0,
          actor: { type: "boss", id: approval.bossId },
          traceId: `tr_direction_${approval.id}`,
          occurredAt: now,
          attemptId: null,
          rejectionReason: null,
          redactionReason:
            "direction text is stored only as structured business input",
          eventCategory: "ordinary",
        },
      ]);
      return {
        approvalId: approval.id,
        directionOpinion: input.directionOpinion,
        assignedLead: { roleId: lead.roleId, instanceId: lead.instanceId },
        responseTaskId: task.id,
        responseArtifactRequired,
        messageId: message.messageId,
      };
    });
  }
  /** 校验方向只能交给已启用的责任岗位，不能把 Boss 意见转成任意成员命令。 */
  private assertLead(actualRoleId: string, requestedRoleId: string): void {
    if (
      canonicalRoleId(actualRoleId) !== canonicalRoleId(requestedRoleId) ||
      !DIRECTION_LEAD_ROLES.has(canonicalRoleId(actualRoleId))
    )
      throw new InvalidArgumentError(
        "assignedLead 必须是已启用的责任组长、开发代表或责任 PM",
      );
  }
  /** 读取已经完成的交接，重复请求不重复创建任务、消息或领域事件。 */
  private readExistingConversion(
    connection: DatabaseConnection,
    approval: ReturnType<EvidenceRepository["getApproval"]>,
    directionOpinion: string,
  ): {
    approvalId: string;
    directionOpinion: string;
    assignedLead: { roleId: string; instanceId: string };
    responseTaskId: string;
    responseArtifactRequired: boolean;
    messageId: string;
  } {
    if (approval.direction && approval.direction !== directionOpinion)
      throw new InvalidArgumentError("该审批已经绑定不同的 Boss 方向意见");
    const task = connection
      .prepare(
        "SELECT id,expected_deliverables_json FROM tasks WHERE project_id=? AND id=?",
      )
      .get(approval.projectId, approval.responseTaskId) as
      | { id: string; expected_deliverables_json: string }
      | undefined;
    const message = connection
      .prepare(
        "SELECT message_id,receiver_role,receiver_instance_id FROM structured_messages WHERE project_id=? AND source_object_type='approval' AND source_object_id=? AND response_object_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(approval.projectId, approval.id, approval.responseTaskId) as
      | {
          message_id: string;
          receiver_role: string;
          receiver_instance_id: string;
        }
      | undefined;
    if (!task || !message)
      throw new InvalidArgumentError("审批已有响应任务但缺少结构化交接记录");
    return {
      approvalId: approval.id,
      directionOpinion: approval.direction ?? directionOpinion,
      assignedLead: {
        roleId: message.receiver_role,
        instanceId: message.receiver_instance_id,
      },
      responseTaskId: task.id,
      responseArtifactRequired: (
        JSON.parse(task.expected_deliverables_json) as string[]
      ).includes("response-artifact"),
      messageId: message.message_id,
    };
  }
  /** 生成结构化消息领域事件，事件正文只保存脱敏摘要和对象引用。 */
  private messageEvent(
    message: StructuredMessage,
    bossId: string,
  ): DomainEventDraft {
    return {
      eventType: "StructuredMessageCreated",
      aggregateType: "structured_message",
      aggregateId: message.messageId,
      payload: {
        messageId: message.messageId,
        projectId: message.projectId,
        taskId: message.taskId,
        messageType: message.messageType,
        senderRole: message.sender.roleId,
        receiverRole: message.receiver.roleId,
        responseObjectType: message.responseObjectType,
        responseObjectId: message.responseObjectId,
      },
      inputSummary: { messageType: message.messageType },
      outputSummary: { status: message.status },
      result: "success",
      failure: null,
      retryCount: 0,
      durationMs: 0,
      actor: { type: "boss", id: bossId },
      traceId: message.traceId ?? `tr_message_${message.messageId}`,
      occurredAt: message.createdAt,
      attemptId: null,
      rejectionReason: null,
      redactionReason: "direction text remains in structured message payload",
      eventCategory: "ordinary",
    };
  }
}
