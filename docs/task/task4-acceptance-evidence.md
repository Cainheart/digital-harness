# Task 4 验收与 Review 证据

## 1. 交付范围与分支状态

- Task：DEV-04，固定研发工作流、状态机、依赖调度与人工关卡。
- 开发分支：`dev_task4`。
- 分支基线：从当时最新本地 `master` 创建，基线提交为 `125b5ad`（`docs: record task-3 master merge`）。
- 远程操作：按本次开发要求，仅保存在本地，未 push 到 GitHub；也未合并回 `master`。
- 与 Task 文档的差异：`docs/task/task4.md` 的通用准则要求使用 `dev/task-4` 并 push；本次以用户明确指定的 `dev_task4` 和“暂存本地、不 push”为准，属于已记录的交付流程偏差，不改变代码契约。
- 完成提交哈希：待本地完成提交后回填。

## 2. 需求与设计追踪

| 依据 | 实现位置 | 验证证据 |
| --- | --- | --- |
| PRD §6.1～§6.5、§7.5、§7.9、§8.1；AC-02、AC-05～AC-11、AC-19、AC-23 | `backend/src/workflow/fixed-workflow.ts`、`backend/src/workflow/state-machine.ts`、`backend/src/application/workflow-coordinator.ts` | 固定节点、项目/任务转移表、人工审批、暂停/恢复/终止、幂等和非法流转集成测试 |
| SR-WFL-001～019 | `backend/src/workflow/state-machine.ts`、`backend/src/workflow/scheduler.ts`、`backend/src/application/workflow-coordinator.ts` | 17 个状态机单元测试；调度领取/释放、Review、P0 风险、终止和正常闭环集成测试 |
| SR-APR-001～008 | `backend/src/application/workflow-coordinator.ts`、`backend/src/api/workflow-routes.ts` | Boss 身份边界、空驳回意见拒绝、PRD/重大风险/测试放行路径、审批重复提交测试 |
| SR-NTF-001～006 | `backend/src/application/workflow-coordinator.ts`、`backend/src/infra/schema.ts` | 审批、暂停、重大风险、终止、结项通知；按 `event_id` 事务去重 |
| SR-REL-003～005、SR-SEC-007/008 | `backend/src/workflow/scheduler.ts`、`backend/src/infra/outbox.ts`、`backend/src/infra/repositories/events.ts` | Grant 版本/角色/项目/Attempt/工作区/期限校验；事务、事件、Outbox、终态只读例外测试 |
| 概要设计 C1～C6、§5～§7、§9.8；BIMA §4.2、§5、§11、§12.3 | `backend/src/application/workflow-coordinator.ts` | Coordinator 只负责状态、业务事件和审批，不调用模型、网页、文件或 Docker；Dashboard 从持久化事实重建 |
| Task 4 §3.2～§4.4、T4-AC-01～12 | `backend/src/api/workflow-routes.ts`、`backend/src/infra/migrations/0005-workflow.ts` | API、迁移、全流程、拒绝/恢复/风险/租约/Review/幂等回归测试 |

## 3. 实现清单

- 固定工作流节点：准备/立项、调研/PRD、PM 交叉评审、Boss PRD 审批、可行性讨论、需求争议、开发任务拆解、开发/自测、开发代表 Review、测试策略/用例、真实测试、缺陷/NPI/回归、Boss 测试放行、结项检查/历史归档。
- 项目和任务状态机使用显式允许边；非法转换统一返回 `WORKFLOW_GUARD_BLOCKED`，不写入新状态或事件。
- 测试放行驳回固定回到“测试策略/用例”，生成“测试放行整改计划”，保留既有任务和证据。
- PRD 驳回生成“PM 修订 PRD”；需求争议生成 Boss 审批并由开发代表承接方向；Review 只改变对应任务。
- 调度器实现依赖满足、项目运行状态、岗位可用、P0～P3 优先级、独立 Attempt、Worker Lease、心跳、过期、一次自动重试和阻塞。
- 暂停、恢复、重大风险、检查点、终止二次确认及历史只读状态均落 SQLite；恢复不依赖内存状态。
- API 覆盖项目创建/启动/暂停/恢复/终止预览与确认/推进/Dashboard、审批、任务 Review、通知、风险、任务领取/心跳/释放。
- Schema revision 升级为 `0005_task4_workflow`，迁移包含工作流暂停、租约、风险、检查点、终止确认表及固定索引；启动完整性检查覆盖工作流表字段和 active lease 唯一约束。

## 4. 测试与构建结果

在 `backend/` 目录执行：

```text
npm test -- --reporter=dot
13 个测试文件通过，71 个测试通过。

npm run typecheck
通过。

npm run build
通过。

git diff --check
通过，无空白错误。
```

新增回归覆盖：

- 正常闭环：从启动、PRD 审批、测试放行到结项归档。
- PRD 驳回和测试放行驳回的指定回路。
- 非法恢复和终态保护。
- 主动暂停/恢复、终止空原因拒绝、终止二次确认和只读。
- 调度领取、独立租约、释放到 Review、开发代表 Review 通过。
- P0 风险暂停、P0 通知、Boss 批准恢复和风险关闭。
- 相同审批命令重复提交返回同一结果，不产生重复业务事实。
- 项目/任务状态机的完整允许边和非法边矩阵。
- 既有 Task 1～3 测试回归、数据库迁移生命周期和安全策略测试。

## 5. Code Review 记录

### 5.1 审查清单

- [x] 已对照 PRD、需求矩阵、Task 4 验收标准和概要设计建立追踪关系。
- [x] API、领域对象、Schema 字段、外键、索引、迁移、事务和终态只读行为一致。
- [x] Boss、Worker、责任岗位、任务负责人和 Grant 默认拒绝，输入不能扩大项目、Attempt、工作区、工具或命令范围。
- [x] expectedVersion、Attempt/Lease 版本、不可变领域事件、Outbox 和审批幂等保持一致。
- [x] 已覆盖主流程、拒绝、空值、过期、跨范围、重复提交、租约释放、迁移和恢复路径。
- [x] 新增实现使用业务职责命名的 kebab-case 文件，没有用 Task 编号命名生产代码。
- [x] Coordinator 不执行模型、网页、文件或 Docker；执行授权仍由 Task Scheduler 和现有策略边界控制。
- [x] 已清理未使用的辅助校验函数，并对已有实现先搜索后扩展；新增 Coordinator/Scheduler/Schema 职责与既有 Task 3 Repository/Policy/EventStore 边界分离。
- [x] 复杂新增文件已格式化并人工检查，事务和控制流保持分段可读。
- [x] 本次问题修复均在代码附近记录了 `2026-08-16` 修改日期和修改原因。

### 5.2 Findings 与处理结果

| 严重级别 | 定位/触发 | 实际问题 | 处理与回归 |
| --- | --- | --- | --- |
| P1 | `workflow-coordinator.ts` 的重大风险分支；POST P0 风险 | 自动暂停事务完成后继续落入普通风险插入分支，可能因重复 `riskId` 产生 500 | 已立即返回统一结果；新增 P0 风险暂停、审批恢复和风险 resolved 集成测试 |
| P1 | `workflow-coordinator.ts` 的终态事件写入；完成/终止命令 | 项目先切为只读后，通用 Outbox 写入保护会阻止本次终态事件 | 已增加受状态机控制的 terminal-event 例外，仍在同一事务内写事件和 Outbox；正常闭环与终止测试通过 |
| P2 | `schema.ts` 的通知去重迁移 | 直接为历史 `notifications.event_id` 创建唯一索引可能因既有重复历史数据阻断迁移 | 已改为事务内 `NOT EXISTS` 去重，不新增破坏性历史索引迁移；审批幂等回归通过 |
| P2 | `scheduler.ts` 的 Grant 工作区校验 | 仅校验工作区字符串非空不足以证明项目/Attempt 范围 | 已要求 `workspace://{projectId}/{attemptId}` 精确前缀及合法子路径；租约集成测试通过 |

以上 findings 已处理，没有开放的 P0/P1 finding。剩余风险是 Task 4 按设计只实现控制面和调度边界，未在本任务中启动真实模型、浏览器、文件或 Docker 执行；这些由后续 Task 5～8 的 Worker/执行面消费本任务接口时继续验证。

## 6. 完成状态

- 验收状态：通过本地自动化测试、类型检查、构建和代码审查。
- Review 状态：通过；无开放 P0/P1 finding。
- 合并状态：未合并到 `master`，符合本次“仅本地暂存、不 push”的要求。
- 完成提交哈希：待本地完成提交后回填。
