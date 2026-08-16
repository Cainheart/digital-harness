# Task 3 验收证据

> 任务：DEV-03；当前分支：`dev/task-3`；基线：`0004_task3_organization_policy`
> 
> 完成提交哈希：`7aa3c6a`（基础实现）、`abd3759`（Review 修复：`fix(task-3): harden policy and message boundaries`）；文档更新继续在同一 `dev/task-3` 分支提交；本分支未合并到 `master`。

## 实现范围

- `0004_task3_organization_policy`：新增组织领域、岗位定义、员工实例、结构化消息和策略审计表；为 `execution_attempts` 增加 `role_version` 与 `policy_snapshot_json`，并支持从 Task 1/2 三个历史 revision 升级。
- 初始化五类责任领域和 19 个岗位/员工实例：产品、开发、NPI、测试、项目主管；研发区的开发组与 NPI 组通过 `deskGroup` 分区。
- `PolicyGate` 提供角色、对象、工具、路径和命令策略，返回 `allow`、`reject`、`approval_required`、策略版本、拒绝原因、风险等级和 traceId。
- 结构化消息支持八种消息类型、项目/任务范围、端点实例校验、幂等键、状态、处理时间和原始/响应对象关联。
- Boss 方向意见转换为责任组长/开发代表任务和结构化交接消息，响应任务默认要求 `response-artifact`。
- Review 修复：消息 acknowledge 幂等、消息请求哈希递归规范化、真实 Boss 端点约束、Boss 响应任务对象引用、岗位/员工版本完整性校验、Grant 范围与期限/工具/命令/工作区边界、角色策略变更审计和 Task 3 Schema 字段/索引启动检查。

## 自动化验收

执行命令：

```text
cd backend
npm run build
npm test
```

当前结果：

- TypeScript 构建通过。
- 10 个 Vitest 测试文件、45 个测试通过。
- Task 3 相关测试覆盖：
  - 岗位职责字段为空时拒绝启用；
  - 五类领域、19 个员工实例和研发/NPI 办公室投影；
  - 缺少 receiver 或 taskId 的消息返回 `422 INVALID_MESSAGE`，且不产生结构化消息和领域事件；
  - 合法消息的幂等、发送方/接收方/任务/trace 追踪和 acknowledge；
  - PM 技术方案审批越权、开发成员自 Review 审批、测试角色写工具、开发角色访问 Keychain；
  - 合法文件写入与测试工具调用、路径/命令策略和过期岗位版本拒绝；
  - 新 Attempt 使用新 `role_version`，历史 Attempt 保留旧版本和策略快照；
  - Boss 方向意见交接到组长任务和响应交付物。
  - 重复 acknowledge 不重复事件、幂等请求键顺序变化不误报冲突、伪造 Boss 身份拒绝、Boss 方向重复转换不重复任务/消息/事件。
  - Grant 工具扩权、非法时间、只读工作区写入、命令控制字符/绝对路径参数、任务负责人不匹配和宽泛负责人跨域使用拒绝。
  - 未知岗位领域/工具/对象动作和敏感岗位配置拒绝；Task 3 消息索引缺失时 Schema readiness 阻断。
  - 结构化计划格式错误和含敏感字段的 Action 被拒绝，敏感内容不进入策略判断结果。
  - 消息 source/response 对象必须存在且属于当前项目，未知或断链引用在写入前拒绝。

## 验收编号映射

| 编号 | 证据位置 | 结果 |
| --- | --- | --- |
| T3-AC-01 | `backend/src/domain/organization/definitions.ts`、`backend/tests/unit/task3-policy.test.ts` | 通过：完整性校验返回 `INVALID_ROLE_DEFINITION` |
| T3-AC-02 | `backend/src/domain/organization/definitions.ts`、`backend/src/api/task3.ts`、`backend/tests/integration/task3-organization.test.ts` | 通过：五类领域、岗位、成员和办公室分区可查询 |
| T3-AC-03 | `PolicyGate` 技术方案审批规则、Task 3 Policy Gate 测试 | 通过：PM 被拒绝并写策略审计 |
| T3-AC-04 | `PolicyGate` Review 自审批规则、Task 3 Policy Gate 测试 | 通过：成员不能批准自己的 Review |
| T3-AC-05 | `parseCreateMessage`、消息集成测试 | 通过：422 且无业务事件 |
| T3-AC-06 | `StructuredMessageRepository`、消息集成测试和 Boss 交接服务 | 通过：端点、任务、状态、处理时间、原始对象和响应任务可追踪；重复确认不重复事件 |
| T3-AC-07 | 工具/路径/命令策略、Task 3 Policy Gate 测试 | 通过：写工具和 Keychain 越权拒绝并保存安全审计 |
| T3-AC-08 | `BossDirectionService`、Boss 方向集成测试 | 通过：Boss 方向转换为组长任务，不直接成为成员任务 |
| T3-AC-09 | `execution_attempts.role_version`、`policy_snapshot_json`、Attempt 版本集成测试 | 通过：新旧 Attempt 策略版本隔离 |

## Review 结果

本轮 Review 已完成，未发现仍需阻断 Task 3 验收的 P0/P1 问题。发现并修复的问题如下：

| 级别 | 发现 | 修复与回归证据 |
| --- | --- | --- |
| P1 | 重复 acknowledge 会重复追加领域事件并可能造成版本冲突 | `StructuredMessageRepository.acknowledge` 使用条件更新并返回 `changed`；重复确认集成测试验证事件总数保持不变 |
| P1 | Boss 端点只检查 role，任意 instanceId 可伪造 Boss | 限制为本机 `boss-local` 身份；伪造 Boss 消息返回 `INVALID_MESSAGE` 且不写业务事实 |
| P1 | Boss 方向交接缺少结构化响应任务引用，重复转换可能重复派发 | 消息增加 `responseObjectType/responseObjectId`；按 approval 幂等返回已有任务、消息和交付物要求 |
| P1 | Grant 可使用超出岗位的工具/命令，且未完整阻断过期时间、只读写入、控制字符、路径参数和负责人跨域 | Policy Gate 增加项目/任务/Attempt/角色/版本/工具/命令/工作区/期限/负责人绑定；新增单测覆盖扩权、非法时间、只读写入、命令和负责人边界 |
| P1 | 数据库中的禁用岗位、员工旧 roleVersion 或不完整岗位配置仍可能被业务读取 | 岗位读取重新执行完整性校验；员工端点要求启用且版本一致；敏感/不完整配置统一返回 `INVALID_ROLE_DEFINITION` |
| P1 | 消息可以携带不存在或跨项目的 source/response 对象引用，造成断链事实 | 仅允许已知业务对象，写入前校验对象存在且 project_id 一致；新增断链消息拒绝测试 |
| P2 | Schema revision 正确但 Task 3 表字段或复合索引损坏时，启动检查无法提前阻断 | `ensureSchemaContract` 增加 Task 3 关键字段、基线数据量和索引检查；新增损坏索引测试 |

### Review 范围与剩余风险

- 已逐项核对 PRD 5.1～5.3、6.3、7.3、7.5、8.1、8.3，需求矩阵 SR-ORG-001～011、SR-SCP-004、SR-OBJ-006、SR-APR-008、SR-COD-001/002/008、SR-SEC-008/010，以及概要设计中的 ExecutionGrant、Policy Gate、事件和 Schema 完整性约束。
- Task 3 当前交付的是组织、岗位策略、结构化消息和 Boss 方向交接基础；完整的执行 Worker、Docker 真实执行、测试放行和项目主管通知编排仍属于后续 Task，不作为本次 Task 3 的未完成项。
- 当前分支仍未合并到 `master`；只有验收和 Review 结论通过后才允许合并。

## 分支交付

- 开发分支：`dev/task-3`。
- 完成提交：`7aa3c6a`、`abd3759`。
- Review：已完成；发现项已在 `abd3759` 修复，回归测试 45/45 通过。
- 合并到 `master`：验收和 Review 通过后再执行；当前未合并。
