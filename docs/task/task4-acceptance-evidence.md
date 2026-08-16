# Task 4 验收与 Review 证据

## 1. 交付范围与分支状态

- Task：DEV-04，固定研发工作流、状态机、依赖调度与人工关卡。
- 开发分支：`dev_task4`。
- 分支基线：从当时最新本地 `master` 创建，基线提交为 `125b5ad`（`docs: record task-3 master merge`）。
- 远程操作：按本次开发要求，仅保存在本地，未 push 到 GitHub；也未合并回 `master`。
- 与 Task 文档的差异：`docs/task/task4.md` 的通用准则要求使用 `dev/task-4` 并 push；本次以用户明确指定的 `dev_task4` 和“暂存本地、不 push”为准，属于已记录的交付流程偏差，不改变代码契约。
- 首轮完成提交哈希：`caec151`（`feat(task-4): complete workflow governance`）。
- 二次复核修复提交哈希：`1fbabc1`（`fix(task-4): harden second review findings`）。

## 2. 需求与设计追踪

| 依据 | 实现位置 | 验证证据 |
| --- | --- | --- |
| PRD §6.1～§6.5、§7.5、§7.9、§8.1；AC-02、AC-05～AC-11、AC-19、AC-23 | `backend/src/workflow/fixed-workflow.ts`、`backend/src/workflow/state-machine.ts`、`backend/src/application/workflow-coordinator.ts` | 固定节点、项目/任务转移表、人工审批、暂停/恢复/终止、幂等和非法流转集成测试 |
| SR-WFL-001～019 | `backend/src/workflow/state-machine.ts`、`backend/src/workflow/scheduler.ts`、`backend/src/application/workflow-coordinator.ts` | 17 个状态机单元测试；调度领取/释放、Review、P0 风险、终止和正常闭环集成测试 |
| SR-APR-001～008 | `backend/src/application/workflow-coordinator.ts`、`backend/src/api/workflow-routes.ts` | Boss 身份边界、空驳回意见拒绝、PRD/重大风险/测试放行路径、审批重复提交测试 |
| SR-NTF-001～006 | `backend/src/application/workflow-coordinator.ts`、`backend/src/infra/schema.ts` | 审批、暂停、重大风险、终止、结项通知；按 `event_id` 事务去重 |
| SR-REL-003～005、SR-SEC-007/008 | `backend/src/workflow/scheduler.ts`、`backend/src/infra/outbox.ts`、`backend/src/infra/repositories/events.ts` | Grant 版本/角色/项目/Attempt/工作区/期限校验；事务、事件、Outbox、终态只读例外测试 |
| 概要设计 C1～C6、§5～§7、§9.8；BIMA §4.2、§5、§11、§12.3 | `backend/src/application/workflow-coordinator.ts` | Coordinator 只负责状态、业务事件和审批，不调用模型、网页、文件或 Docker；Dashboard 从持久化事实重建 |
| Task 4 §3.2～§4.4、T4-AC-01～12 | `backend/src/api/workflow-routes.ts`、`backend/src/infra/migrations/0005-workflow.ts`、`backend/src/infra/migrations/0006-workflow-hardening.ts` | API、迁移、全流程、拒绝/恢复/风险/租约/Review/幂等回归测试 |

## 3. 实现清单

- 固定工作流节点：准备/立项、调研/PRD、PM 交叉评审、Boss PRD 审批、可行性讨论、需求争议、开发任务拆解、开发/自测、开发代表 Review、测试策略/用例、真实测试、缺陷/NPI/回归、Boss 测试放行、结项检查/历史归档。
- 项目和任务状态机使用显式允许边；非法转换统一返回 `WORKFLOW_GUARD_BLOCKED`，不写入新状态或事件。
- 测试放行驳回固定回到“测试策略/用例”，生成“测试放行整改计划”，保留既有任务和证据。
- PRD 驳回生成“PM 修订 PRD”；需求争议生成 Boss 审批并由开发代表承接方向；Review 只改变对应任务。
- 调度器实现依赖满足、项目运行状态、岗位可用、P0～P3 优先级、独立 Attempt、Worker Lease、心跳、过期、一次自动重试和阻塞。
- 暂停、恢复、重大风险、检查点、终止二次确认及历史只读状态均落 SQLite；恢复不依赖内存状态。
- API 覆盖项目创建/启动/暂停/恢复/终止预览与确认/推进/Dashboard、审批、任务 Review、通知、风险、任务领取/心跳/释放。
- Schema revision 升级为 `0006_task4_workflow_hardening`，迁移包含工作流暂停、租约、风险、检查点、终止确认表及固定索引；启动完整性检查覆盖工作流表字段、Grant 原始期限、风险响应任务关联和 active lease 唯一约束。

## 4. 测试与构建结果

在 `backend/` 目录执行：

```text
npm test -- --reporter=dot
13 个测试文件通过，75 个测试通过。

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
- 二次复核回归：缺陷/NPI/回归可达性、审批与响应任务关联、审批通知闭环、一般风险整改任务与风险报告通知、风险重复提交幂等、跨项目风险任务拒绝、过期租约重放、Grant 岗位策略绑定、Grant 原始期限边界、Review 证据完整性和 0005→0006 migration。

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

### 5.2 首轮 Findings 与处理结果

| 严重级别 | 定位/触发 | 实际问题 | 处理与回归 |
| --- | --- | --- | --- |
| P1 | `workflow-coordinator.ts` 的重大风险分支；POST P0 风险 | 自动暂停事务完成后继续落入普通风险插入分支，可能因重复 `riskId` 产生 500 | 已立即返回统一结果；新增 P0 风险暂停、审批恢复和风险 resolved 集成测试 |
| P1 | `workflow-coordinator.ts` 的终态事件写入；完成/终止命令 | 项目先切为只读后，通用 Outbox 写入保护会阻止本次终态事件 | 已增加受状态机控制的 terminal-event 例外，仍在同一事务内写事件和 Outbox；正常闭环与终止测试通过 |
| P2 | `schema.ts` 的通知去重迁移 | 直接为历史 `notifications.event_id` 创建唯一索引可能因既有重复历史数据阻断迁移 | 已改为事务内 `NOT EXISTS` 去重，不新增破坏性历史索引迁移；审批幂等回归通过 |
| P2 | `scheduler.ts` 的 Grant 工作区校验 | 仅校验工作区字符串非空不足以证明项目/Attempt 范围 | 已要求 `workspace://{projectId}/{attemptId}` 精确前缀及合法子路径；租约集成测试通过 |

以上是首轮 findings 的处理结果；该结论已在二次复核中重新审查，不能单独作为最终 Review 结论。

### 5.3 二次复核 Findings 与处理结果（2026-08-16）

二次复核没有沿用首轮“无开放 P0/P1”结论，而是重新从需求矩阵、Task 4 验收标准、Schema/API 契约和异常路径构造反例。发现的问题均已在 `1fbabc1` 修复，并由新增回归测试覆盖：

| 严重级别 | 定位/触发 | 实际问题 | 修复与回归证据 |
| --- | --- | --- | --- |
| P1 | `workflow-coordinator.ts`，真实测试阶段存在未关闭缺陷 | `REAL_TEST` 原先可直接进入测试放行，`DEFECT_NPI_REGRESSION` 不可达，SR-WFL-001/012 的缺陷路由被绕过 | 查询当前项目未关闭缺陷；有缺陷时先进入缺陷/NPI/回归；新增开放缺陷回归测试 |
| P1 | `workflow-coordinator.ts`，PRD/需求争议/测试放行驳回 | 响应任务虽然创建，但 `approvals.response_task_id` 没有回写，审批与责任任务断链，违反 SR-APR-008/SR-EVT-005 | 新增 `linkApprovalResponseTask` 并在三类回路写回关联；审批读取回归断言响应任务存在 |
| P1 | `workflow-coordinator.ts`，Boss 审批完成 | 审批业务已完成但对应站内通知仍为 pending，违反 SR-NTF-004～006 | 审批决定事务内关闭 approval 通知；回归检查通知 pending/unread/handled 字段 |
| P1 | `scheduler.ts`，Worker 提交扩大后的 tool/command policy | 调度器原先接受调用方自带策略，调用方可把 Grant 权限扩大到岗位策略之外，违反 SR-SEC-008 | Claim 时按当前启用岗位和 roleVersion 重新绑定工具/命令白名单；新增越权策略拒绝测试 |
| P1 | `scheduler.ts`，心跳延长超过 Grant deadline | 仅限制单次心跳时长，累计心跳可能越过原始 Grant 有效期 | `workflow_leases.grant_expires_at` 持久化并在 heartbeat 中截断；新增 300 秒心跳不越过 Grant 期限测试 |
| P1 | `workflow-coordinator.ts`，P2/P3 一般风险 | 原实现只插入风险记录，没有责任组长整改任务、风险报告事件或关联通知，违反 SR-WFL-013/014 和 SR-NTF-001 | 按受影响任务责任领域路由到组长，写入 `response_task_id`，追加 `RiskReported` 事件和通知；新增整改任务、重复风险幂等测试 |
| P2 | `scheduler.ts`，同一 Attempt 重复 Claim/过期 Claim | 重复领取没有完整核对 Attempt 的模型/角色版本；已过期活动租约可能被当作有效结果返回，且过期事实不能提交 | 校验执行 Attempt 绑定、岗位策略和租约/Grant 两个期限；过期结果先落库再由 API 返回 409；新增过期重放测试 |
| P2 | `workflow-coordinator.ts`，Review 操作者仅用 ID 比较 | 只比较 actor ID 无法阻止使用负责人 role 伪造身份的自 Review | 同时校验 actor.id 与 actor.type；新增负责人 role 伪造 Review 拒绝测试 |
| P2 | `state-machine.ts`，Worker 声明需要 Review 但证据不完整 | 任务可在缺少执行证据时进入 WAITING_REVIEW，违反 SR-COD-007/任务状态保护规则 | WAITING_REVIEW 转移增加 `evidenceComplete` 门禁；新增不完整证据拒绝测试 |
| P2 | `schema.ts`/`database.ts`，已有 0005 数据库升级 | 新增租约期限和风险响应字段没有旧库迁移路径会导致启动结构不一致 | Schema revision 升级到 `0006_task4_workflow_hardening`，新增 0005→0006 migration 和生命周期测试 |

二次复核后的结论：上述 P1/P2 findings 均已关闭，没有开放的 P0/P1 finding。Task 4 仍按边界只实现控制面、状态机、审批、通知和调度租约，不在本任务启动真实模型、浏览器、文件或 Docker；这些执行面能力由 Task 5～8 按本任务 Grant/Lease 接口继续消费和验证。Task 3 的 Policy Gate Grant 与 Task 4 的 Scheduler Grant 是两个不同层次的 DTO：前者负责动作授权判断，后者负责任务领取和租约生命周期；Task 4 不以重复 DTO 替代 Policy Gate，Claim 仍从持久化岗位策略重新做服务端绑定。

## 6. 完成状态

- 验收状态：通过本地自动化测试、类型检查、构建和代码审查。
- Review 状态：通过；无开放 P0/P1 finding。
- 合并状态：未合并到 `master`，符合本次“仅本地暂存、不 push”的要求。
- 首轮完成提交哈希：`caec151`（`feat(task-4): complete workflow governance`）。
- 最终本地修复提交哈希：`1fbabc1`（`fix(task-4): harden second review findings`）。
