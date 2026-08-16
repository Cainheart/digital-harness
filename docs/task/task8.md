# Task 8：开发 Review、测试执行、缺陷流转与 NPI 回归

> 任务编号：DEV-08
> 任务状态：待开发
> 任务类型：开发任务拆解、Review、测试、缺陷、NPI、回归
> 前置任务：task2.md、task3.md、task4.md、task7.md
> 后续消费者：task9.md、task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

把已批准需求转成可分派、可开发、可 Review、可测试和可回归的工程闭环。开发代表必须把批准需求拆成至少 3 个专业任务；未 Review 通过的变更不能进入测试基线；测试失败必须真实形成缺陷并路由 NPI；NPI 修复必须由测试角色真实回归。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §5.1/§5.2：开发、NPI、测试岗位和交付物。
- PRD §6.1、§6.5：开发、Review、测试、缺陷、NPI 和回归。
- PRD §7.5、§7.7：任务、交付物、真实代码、真实测试和 Review 门禁。
- PRD §8.1：未 Review、未回归和阻断性缺陷不能越过流程。
- 对应 AC-06、AC-07、AC-08、AC-18、AC-23、AC-26。

### 2.2 需求矩阵

- SR-OBJ-002～008；
- SR-EXE-001～010；
- SR-WFL-011～015；
- SR-APR-007；
- SR-EVL-004/007；
- SR-COD-007/012；
- AS-01、AS-05、AS-06、AS-17。

### 2.3 概要设计

- 总体设计 B2、C6、D6/D7、§5.4、§6.1、§10；
- BIMA §10、§15、§17；
- task7.md 的 Handoff、VerificationRun、Workspace、Artifact 和 Trace；
- task4.md 的任务状态机、Review 门禁、缺陷回路和测试放行。

## 3. 具体交付物

### 3.1 建议代码目录

~~~text
backend/app/application/decomposition.py
backend/app/application/review.py
backend/app/application/test_design.py
backend/app/application/test_execution.py
backend/app/application/defects.py
backend/app/application/npi.py
backend/app/domain/testing/
backend/app/domain/defects/
backend/app/api/reviews.py
backend/app/api/tests.py
backend/app/api/defects.py
backend/app/api/npi.py
tests/unit/review/
tests/unit/testing/
tests/unit/defects/
tests/integration/quality_flow/
tests/e2e/quality_flow/
~~~

### 3.2 开发任务拆解

开发代表接收已批准 PRD、验收标准和可行性意见，至少创建 3 个不同专业标签的任务。每个任务必须有：

- 标题和目标；
- 专业标签；
- 负责人和分派理由；
- 优先级；
- 前置依赖；
- 预期交付物；
- 关联 PRD/SR/AC；
- 验收标准；
- 工作区路径和 VerificationProfile；
- 当前任务版本。

任务拆解不能把 Boss 方向意见直接复制为成员命令，必须记录责任组长的转换方式。

### 3.3 Review 门禁

开发成员交接必须同时提供：

- 代码变更和完整 diff；
- 自测命令/步骤、环境、时间和结果；
- 关联需求和验收标准；
- 剩余风险和未解决问题；
- HandoffPackage 和 traceId。

开发代表 Review 只能产生：

- approved；
- changes_requested；
- blocked。

Review 通过后才能生成测试基线引用；Review 驳回只创建关联返工任务，不重置其他通过任务。

### 3.4 测试设计和执行

测试组长先创建测试策略，再创建用例：

| 测试类型 | 覆盖重点 |
| --- | --- |
| 功能测试 | 主流程和业务验收标准。 |
| 边界/异常测试 | 空输入、非法状态、外部依赖失败、重复命令和错误处理。 |
| 接口/集成测试 | API Schema、模块契约、事件、Worker、Artifact 和状态推进。 |
| 回归测试 | NPI 修复和相关影响范围。 |

测试用例必须关联已批准验收标准，测试只能选择 Review 通过的版本作为基线。

测试执行记录至少保存：

- TestRun ID、TestCase ID、项目、任务和基线版本；
- 命令/步骤、环境/版本、开始/结束时间；
- 实际结果、预期结果、退出码；
- stdout/stderr、截图或日志 Artifact；
- 执行角色和 traceId；
- 通过/失败/阻塞结论。

### 3.5 缺陷和 NPI

失败测试自动生成缺陷，缺陷必须有：

- 来源测试；
- 复现前置条件和步骤；
- 严重级别；
- 实际结果和预期结果；
- 证据；
- NPI 责任角色；
- 状态；
- 修复 Artifact；
- 回归请求和回归结果。

NPI 流程：

~~~text
测试失败
  → 缺陷创建
  → NPI 缺陷分析
  → 复现和定位
  → 前端/后端修复
  → 修复说明和回归请求
  → 测试角色执行回归
  → 回归通过后关闭缺陷
~~~

NPI 不能自行宣布回归通过；测试放行前阻断性缺陷必须为关闭状态。

## 4. 接口设计

### 4.1 编码任务和任务拆解

沿用 BIMA 接口：

~~~http
POST /api/projects/{projectId}/coding-tasks
GET  /api/v1/projects/{projectId}/tasks
GET  /api/v1/tasks/{taskId}
~~~

创建任务请求至少包含：

~~~json
{
  "title": "实现任务筛选",
  "goal": "支持按状态和负责人筛选任务",
  "professionalTag": "frontend",
  "assigneeRole": "frontend_developer",
  "priority": "P1",
  "dependencies": [],
  "acceptanceCriteriaRefs": ["AC-06"],
  "expectedArtifactTypes": ["code_change", "self_test"],
  "workspacePolicy": "frontend-default",
  "verificationProfile": "react-ts-vite",
  "version": 1
}
~~~

### 4.2 Review 接口

~~~http
GET  /api/coding-sessions/{sessionId}/handoff
POST /api/handoffs/{handoffId}/review
~~~

Review 请求：

~~~json
{
  "decision": "changes_requested",
  "opinion": "补充空列表和错误状态测试",
  "reviewerRole": "developer_representative",
  "evidenceVersion": 2,
  "idempotencyKey": "review-handoff_01J-v2"
}
~~~

Review 服务必须验证 Reviewer 角色、Handoff 完整性、diff、验证证据和任务状态。

### 4.3 测试接口

建议提供：

~~~http
POST /api/v1/projects/{projectId}/test-strategies
POST /api/v1/test-strategies/{strategyId}/test-cases
POST /api/v1/test-cases/{testCaseId}/runs
GET  /api/v1/test-runs/{testRunId}
GET  /api/v1/projects/{projectId}/test-report
~~~

测试执行必须使用已 Review 通过的 baselineArtifactVersion；客户端不能自行传入未通过版本绕过门禁。

### 4.4 缺陷和 NPI 接口

~~~http
POST /api/v1/test-runs/{testRunId}/defects
GET  /api/v1/defects/{defectId}
POST /api/v1/defects/{defectId}/npi-analysis
POST /api/v1/defects/{defectId}/fix-request
POST /api/v1/defects/{defectId}/regression-request
POST /api/v1/defects/{defectId}/regression-result
~~~

只有测试角色可以提交回归通过结果；NPI 提交修复只能产生待回归状态。

## 5. 开发实施方法

1. 先写任务拆解、Review 和测试对象的 Schema 与关系约束。
2. 实现至少 3 个专业任务的确定性拆解校验和分派理由。
3. 写 Review 门禁测试：缺少 diff、自测、验收关联或风险字段时不能进入 Review。
4. 实现 Review 三态、局部返工和版本选择。
5. 实现测试策略、测试用例和基于已批准验收标准的覆盖检查。
6. 接入 task7.md 的真实命令/测试执行和 Artifact 证据。
7. 实现测试失败自动建缺陷、NPI 路由、修复和回归。
8. 实现阻断性缺陷放行保护、风险报告和重复失败关联。
9. 使用一个正常任务、一个 Review 驳回任务和一个测试失败任务做 E2E。

需要使用：

- Node.js/TypeScript/Fastify/TypeBox/Drizzle ORM；
- task2.md 的对象、事件、Artifact 和 TraceLink；
- task4.md 的任务状态、审批和调度；
- task7.md 的 NativeCodingHarness、VerificationRun、Docker 和 Handoff；
- Vitest、真实测试命令、前后端 Profile、E2E 测试和缺陷回归测试。

## 6. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T8-AC-01 | 需求拆解 | 给开发代表一份已批准 PRD | 至少生成 3 个专业任务，每个有负责人、依赖、验收关联和分派理由。 |
| T8-AC-02 | 开发自测交接 | 缺少代码或自测证据提交 Review | 请求被拒绝，任务不进入等待 Review。 |
| T8-AC-03 | Review 通过 | 提交完整 Handoff 给开发代表 | 产生 approved，测试基线只引用通过版本。 |
| T8-AC-04 | Review 驳回 | 驳回一个任务 | 只生成该任务返工，其他任务不重置。 |
| T8-AC-05 | 测试策略/用例 | 创建测试策略和用例 | 每条批准验收标准至少有一个测试用例，测试类型和负责人完整。 |
| T8-AC-06 | 未 Review 基线 | 指定未 Review 版本执行测试 | API 被拒绝并返回 WORKFLOW_GUARD_BLOCKED。 |
| T8-AC-07 | 真实测试证据 | 执行通过和失败测试 | 命令/步骤、版本、时间、退出码、实际结果和 Artifact 完整。 |
| T8-AC-08 | 测试失败建缺陷 | 注入一个失败 TestRun | 自动创建 Defect 并路由 NPI，不能直接进入放行。 |
| T8-AC-09 | NPI 修复回归 | NPI 提交修复后尝试关闭缺陷 | 修复只能进入待回归；只有测试角色真实回归通过才能关闭。 |
| T8-AC-10 | 回归失败 | 回归再次失败 | 缺陷保持打开，生成新的失败/风险关联，不允许结项。 |
| T8-AC-11 | 阻断性缺陷放行 | 存在未关闭阻断性缺陷提交测试放行 | 提交或通过均被拒绝，并显示缺陷证据。 |
| T8-AC-12 | 追踪完整性 | 从验收标准检查任务、用例、TestRun、Defect、Fix、Regression | 关键对象断链数为 0。 |
| T8-AC-COMMIT | 分支、验收与开发完成提交 | Task 开发、测试和文档完成后检查 `git branch --show-current`、`git log`、提交哈希和工作区状态 | Task 8 在从最新 `master` 创建的 `dev/task-8` 分支上完成；已创建完成提交，提交哈希已写入验收证据；验收和 Review 成功后才合并到 `master`，并记录合并提交哈希。 |

AS-05、AS-06 和 AS-17 必须分别保留 Review 驳回局部返工、测试失败/NPI 回归和编码 Agent 中断恢复的完整链路。

## 7. 完成定义与交接

- 开发结束时已在 `dev/task-8` 分支创建一次可识别的 Task 8 完成提交，提交哈希已记录在验收证据中，相关工作区无未提交变更；验收和 Review 成功后才允许合并到 `master`，并记录合并提交哈希。
- 每条批准验收标准至少关联测试用例。
- 测试基线只能来自开发代表 Review 通过的版本。
- 测试失败、缺陷、NPI 修复、回归和关闭结论形成完整追踪链。
- NPI 的文字声明不能替代真实回归证据；阻断性缺陷未关闭时放行操作被拒绝。
- task9.md 可以展示任务/Review/测试/缺陷，task10.md 可以计算质量指标和 AS-06/AS-17 证据。
