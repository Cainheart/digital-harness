# Task 3：数字公司组织、岗位定义、结构化消息与执行策略

> 任务编号：DEV-03
> 任务状态：已完成开发，待验收与 Review
> 任务类型：组织模型、角色边界、消息协议、策略和授权
> 前置任务：task2.md
> 后续消费者：task4.md、task5.md、task6.md、task7.md、task8.md、task9.md、task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

把 PRD 中的数字公司组织和细分岗位落成可配置、可校验、可审计的运行时对象，使每个数字员工只能处理职责范围内的业务对象和工具操作。

本任务建立的是“数字员工是谁、能看什么、能做什么、不能做什么、如何交接”的基础，不实现具体模型执行，也不实现工作流推进。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §5.1～§5.3：五类责任领域、细分岗位和八类岗位定义要求。
- PRD §6.3：Boss 方向意见必须由组长转换为任务。
- PRD §7.3、§7.5：像素办公室组织投影和结构化业务消息。
- PRD §8.1、§8.3：员工不能改流程、扩权或绕过审批。
- 对应 AC-03、AC-04、AC-05、AC-06、AC-14、AC-25。

### 2.2 需求矩阵

- SR-ORG-001～011；
- SR-SCP-004、SR-OBJ-006；
- SR-SEC-008/010、SR-COD-008；
- AS-01、AS-03、AS-04、AS-07、AS-16。

### 2.3 概要设计

- 总体设计 C3、C5、D2、§4.1～§4.4、§9：角色/工具/路径策略、Worker Grant 和组织投影。
- BIMA §3.2、§6.2、§11、§14：Policy Gate、ExecutionGrant、高风险策略和安全边界。

## 3. 具体交付物

### 3.1 建议代码目录

~~~text
backend/app/domain/organization/
backend/app/domain/roles/
backend/app/domain/messages/
backend/app/policy/
backend/app/policy/role_policy.py
backend/app/policy/object_policy.py
backend/app/policy/tool_policy.py
backend/app/policy/path_policy.py
backend/app/api/organization.py
backend/app/api/messages.py
tests/unit/roles/
tests/unit/policy/
tests/integration/messages/
tests/security/authorization/
~~~

### 3.2 组织和岗位初始化数据

必须初始化以下责任领域和员工实例：

| 领域 | 员工/岗位 |
| --- | --- |
| 产品 | 用户/市场 PM、产品方案 PM |
| 开发 | 开发代表、前端开发、后端开发、集成开发、代码质量开发及其他专业成员 |
| NPI | NPI 组长、缺陷分析、前端修复、后端修复、回归协同 |
| 测试 | 测试组长、功能测试、边界/异常测试、接口/集成测试、回归测试 |
| 项目主管 | 流程主管、质量/风险主管 |

岗位定义至少有以下八个非空字段：

~~~json
{
  "roleId": "role_product_solution_pm",
  "domain": "product",
  "title": "产品方案 PM",
  "objective": "定义产品范围、流程、验收和成功指标",
  "responsibilities": [],
  "inputs": [],
  "outputs": [],
  "allowedTools": [],
  "visibleObjects": [],
  "allowedObjects": [],
  "forbiddenActions": [],
  "roleVersion": 1
}
~~~

### 3.3 结构化消息

数字员工之间不能传递无结构的“自由对话”作为业务事实。消息必须保存：

- messageId；
- senderRole、senderInstanceId；
- receiverRole、receiverInstanceId；
- projectId、taskId；
- messageType；
- payload；
- createdAt；
- status；
- handledAt、handledBy；
- 关联的原始对象、响应对象和 traceId。

支持的最小消息类型包括：task_assignment、feasibility_opinion、approval_direction、review_feedback、defect_handoff、regression_request、risk_escalation 和 coordination_item。

### 3.4 策略和授权

策略层至少分四类：

1. 角色策略：岗位能处理什么。
2. 对象策略：岗位能读取/创建/修改/审批哪些对象。
3. 工具策略：岗位能使用调研、文件、命令、测试、证据工具中的哪些工具。
4. 路径/命令策略：任务授权范围内哪些文件和命令可以访问。

角色策略不能替代 V1 用户身份系统；V1 仍然只有本机 Boss，员工角色是业务执行边界。

## 4. 接口设计

### 4.1 组织查询

建议提供：

~~~http
GET /api/v1/organization
GET /api/v1/roles
GET /api/v1/roles/{roleId}
GET /api/v1/organization/office-view
~~~

响应示例：

~~~json
{
  "domains": [
    {
      "domain": "development",
      "displayName": "研发区",
      "groups": ["development", "npi"],
      "members": ["developer_rep", "frontend_dev_01"]
    }
  ],
  "bossDecisionBoundary": [
    "prd_approval",
    "requirement_dispute",
    "major_risk",
    "test_release"
  ],
  "version": 1
}
~~~

office-view 只返回展示所需的组织/员工/工位投影，不返回凭据、完整提示词或未脱敏工具参数。

### 4.2 结构化消息接口

~~~http
POST /api/v1/messages
GET /api/v1/messages?projectId={id}&taskId={id}
POST /api/v1/messages/{messageId}/acknowledge
~~~

请求示例：

~~~json
{
  "sender": {"roleId": "product_solution_pm", "instanceId": "emp_02"},
  "receiver": {"roleId": "developer_representative", "instanceId": "emp_07"},
  "projectId": "project_01J",
  "taskId": "task_01J",
  "messageType": "feasibility_opinion",
  "payload": {
    "decision": "needs_clarification",
    "issues": ["验收条件缺少边界说明"],
    "evidenceRefs": ["artifact://prd/v2"]
  },
  "idempotencyKey": "msg-feasibility-task_01J-v2"
}
~~~

缺少发送方、接收方、项目、任务、时间或处理状态的消息必须返回 422 INVALID_MESSAGE，不得进入业务流。

### 4.3 Policy Gate 接口

~~~typescript
class PolicyGate(Protocol):
    async def evaluate_plan(
        self,
        role: RoleDefinition,
        task: Task,
        plan: StructuredPlan,
        grant: ExecutionGrant,
    ) -> PolicyDecision: ...

    async def authorize_action(
        self,
        role: RoleDefinition,
        action: Action,
        grant: ExecutionGrant,
    ) -> ActionAuthorization: ...
~~~

PolicyDecision 支持 allow、reject、approval_required，必须返回策略版本、拒绝原因、风险等级和 traceId。

### 4.4 Boss 方向意见交接

Boss 的审批意见不能直接变成成员命令。接口应返回：

~~~json
{
  "approvalId": "apr_01J",
  "directionOpinion": "优先保证主流程，装饰性功能后置",
  "assignedLead": {
    "roleId": "developer_representative",
    "instanceId": "emp_07"
  },
  "responseTaskId": "task_direction_01J",
  "responseArtifactRequired": true
}
~~~

## 5. 开发实施方法

1. 先将 PRD §5.1/§5.2 的组织和岗位表转成版本化初始化数据。
2. 写岗位定义完整性测试：八类字段任一为空，岗位不得领取任务。
3. 写角色/对象/工具/路径策略的正向和越权测试，再实现 Policy Gate。
4. 实现结构化消息 Schema、幂等、状态和追踪。
5. 实现组织查询和 office-view 投影，供 task9.md/task10.md 使用。
6. 将 Boss 方向意见转换为组长任务和响应交付物，验证 Boss 不会成为成员级任务执行人。
7. 将策略对象交给 task4.md 用于工作流门禁，交给 task5.md/task7.md 用于 Grant。

需要使用：

- TypeScript/TypeBox Schema、Drizzle ORM；
- 结构化事件/消息；
- Policy Gate 和确定性规则；
- Vitest、属性测试或表驱动测试；
- OpenTelemetry traceId 和脱敏日志。

## 6. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T3-AC-01 | 岗位完整性 | 删除任一岗位八类字段后尝试启用 | 系统拒绝启用并说明缺失字段。 |
| T3-AC-02 | 组织配置 | 查询组织和 office-view | 五类领域、研发区内开发/NPI 分区、岗位、成员和专业标签均可识别。 |
| T3-AC-03 | PM 越权 | 让用户/市场 PM 提交技术方案审批 | Policy Gate 拒绝，并产生越权事件。 |
| T3-AC-04 | Review 权限 | 让开发成员批准自己的 Review | 拒绝；只能交接给开发代表。 |
| T3-AC-05 | 结构化消息 | 缺少 receiver 或 taskId 发送消息 | 返回 422 INVALID_MESSAGE，没有业务事件。 |
| T3-AC-06 | 合法交接 | 发送任务分派和方向意见消息 | 消息可追踪到发送方、接收方、任务、处理时间和响应交付物。 |
| T3-AC-07 | 工具越权 | 测试角色调用写入工具，或开发角色访问 Keychain | 拒绝并写入脱敏安全事件。 |
| T3-AC-08 | Boss 边界 | 查看 Boss 表单和方向意见转换结果 | Boss 不需要填写技术方案/成员任务；意见由组长转换为任务。 |
| T3-AC-09 | 策略版本 | 修改角色策略后启动新 Attempt | 新 Attempt 使用新版本，旧 Attempt 仍保留旧版本和审计。 |
| T3-AC-COMMIT | 分支、验收与开发完成提交 | Task 开发、测试和文档完成后检查 `git branch --show-current`、`git log`、提交哈希和工作区状态 | Task 3 在从最新 `master` 创建的 `dev/task-3` 分支上完成；已创建完成提交，提交哈希已写入验收证据；验收和 Review 成功后才合并到 `master`，并记录合并提交哈希。 |

验收证据包括：岗位初始化数据、策略评估结果、拒绝原因、消息记录、角色/任务/工具关联和安全事件。

## 7. 完成定义与交接

- 开发结束时已在 `dev/task-3` 分支创建一次可识别的 Task 3 完成提交，提交哈希已记录在验收证据中，相关工作区无未提交变更；验收和 Review 成功后才允许合并到 `master`，并记录合并提交哈希。
- 所有岗位定义通过完整性校验，组织查询和 office-view 可被前端消费。
- 结构化消息、Policy Gate 和 Grant 字段已冻结。
- 角色越权、对象越权、工具越权和 Boss 边界测试通过。
- task4.md 可使用角色/组长/消息进行状态推进，task5.md 可使用领域配置，task6.md 可使用 PM 和 ResearchGrant，task7.md 可使用工具/路径策略。
- 不能通过修改任务输入或模型输出绕过策略层。
