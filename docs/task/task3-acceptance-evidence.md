# Task 3 验收证据

> 任务：DEV-03；当前分支：`dev/task-3`；基线：`0004_task3_organization_policy`
> 
> 完成提交哈希将在完成提交后回填；本分支未合并到 `master`，等待验收和 Review。

## 实现范围

- `0004_task3_organization_policy`：新增组织领域、岗位定义、员工实例、结构化消息和策略审计表；为 `execution_attempts` 增加 `role_version` 与 `policy_snapshot_json`，并支持从 Task 1/2 三个历史 revision 升级。
- 初始化五类责任领域和 19 个岗位/员工实例：产品、开发、NPI、测试、项目主管；研发区的开发组与 NPI 组通过 `deskGroup` 分区。
- `PolicyGate` 提供角色、对象、工具、路径和命令策略，返回 `allow`、`reject`、`approval_required`、策略版本、拒绝原因、风险等级和 traceId。
- 结构化消息支持八种消息类型、项目/任务范围、端点实例校验、幂等键、状态、处理时间和原始/响应对象关联。
- Boss 方向意见转换为责任组长/开发代表任务和结构化交接消息，响应任务默认要求 `response-artifact`。

## 自动化验收

执行命令：

```text
cd backend
npm run build
npm test
```

当前结果：

- TypeScript 构建通过。
- 10 个 Vitest 测试文件、37 个测试通过。
- Task 3 相关测试覆盖：
  - 岗位职责字段为空时拒绝启用；
  - 五类领域、19 个员工实例和研发/NPI 办公室投影；
  - 缺少 receiver 或 taskId 的消息返回 `422 INVALID_MESSAGE`，且不产生结构化消息和领域事件；
  - 合法消息的幂等、发送方/接收方/任务/trace 追踪和 acknowledge；
  - PM 技术方案审批越权、开发成员自 Review 审批、测试角色写工具、开发角色访问 Keychain；
  - 合法文件写入与测试工具调用、路径/命令策略和过期岗位版本拒绝；
  - 新 Attempt 使用新 `role_version`，历史 Attempt 保留旧版本和策略快照；
  - Boss 方向意见交接到组长任务和响应交付物。

## 验收编号映射

| 编号 | 证据位置 | 结果 |
| --- | --- | --- |
| T3-AC-01 | `backend/src/domain/organization/definitions.ts`、`backend/tests/unit/task3-policy.test.ts` | 通过：完整性校验返回 `INVALID_ROLE_DEFINITION` |
| T3-AC-02 | `backend/src/domain/organization/definitions.ts`、`backend/src/api/task3.ts`、`backend/tests/integration/task3-organization.test.ts` | 通过：五类领域、岗位、成员和办公室分区可查询 |
| T3-AC-03 | `PolicyGate` 技术方案审批规则、Task 3 Policy Gate 测试 | 通过：PM 被拒绝并写策略审计 |
| T3-AC-04 | `PolicyGate` Review 自审批规则、Task 3 Policy Gate 测试 | 通过：成员不能批准自己的 Review |
| T3-AC-05 | `parseCreateMessage`、消息集成测试 | 通过：422 且无业务事件 |
| T3-AC-06 | `StructuredMessageRepository`、消息集成测试和 Boss 交接服务 | 通过：端点、任务、状态、处理时间、原始对象和响应任务可追踪 |
| T3-AC-07 | 工具/路径/命令策略、Task 3 Policy Gate 测试 | 通过：写工具和 Keychain 越权拒绝并保存安全审计 |
| T3-AC-08 | `BossDirectionService`、Boss 方向集成测试 | 通过：Boss 方向转换为组长任务，不直接成为成员任务 |
| T3-AC-09 | `execution_attempts.role_version`、`policy_snapshot_json`、Attempt 版本集成测试 | 通过：新旧 Attempt 策略版本隔离 |

## 分支交付

- 开发分支：`dev/task-3`。
- 完成提交：待创建后回填哈希。
- Review：待验收方执行。
- 合并到 `master`：验收和 Review 通过后再执行；当前未合并。
