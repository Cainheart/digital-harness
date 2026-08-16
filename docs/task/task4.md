# Task 4：固定研发工作流、状态机、依赖调度与人工关卡

> 任务编号：DEV-04
> 任务状态：待开发
> 任务类型：流程编排、状态机、调度、审批、暂停/恢复/终止
> 前置任务：task2.md、task3.md
> 后续消费者：task6.md、task7.md、task8.md、task9.md、task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

将 PRD 的端到端研发流程落成固定、不可绕过、可暂停、可恢复、可审计的业务控制面。该任务负责“什么时候允许进入下一阶段、谁必须审批、哪些任务可以并行、什么情况必须暂停”，不直接调用模型、网页或 Docker。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §6.1～§6.5：主流程、项目启动、人工审批、自动推进、暂停/恢复/终止、返工和风险。
- PRD §7.5、§7.9：任务状态、项目状态和事件。
- PRD §8.1：业务规则和不能绕过的门禁。
- 对应 AC-02、AC-05～AC-11、AC-19、AC-23。

### 2.2 需求矩阵

- SR-WFL-001～019；
- SR-APR-001～008；
- SR-SCP-002/004；
- SR-REL-003～005、SR-SEC-007/008；
- 项目、任务和通知状态流转矩阵；
- AS-01、AS-03～AS-11。

### 2.3 概要设计

- 总体设计 C1～C6、§5～§7、§9.8：固定工作流、显式状态机、人工关卡、调度、租约、调用流程、恢复。
- BIMA §4.2、§5、§11、§12.3：Workflow Coordinator、状态不变量、风险审批和恢复。

## 3. 具体交付物

### 3.1 建议代码目录

~~~text
backend/app/workflow/graph.py
backend/app/workflow/project_state.py
backend/app/workflow/task_state.py
backend/app/workflow/notification_state.py
backend/app/workflow/gates.py
backend/app/workflow/scheduler.py
backend/app/workflow/recovery.py
backend/app/application/project_commands.py
backend/app/application/approval_commands.py
backend/app/application/task_commands.py
backend/app/api/projects.py
backend/app/api/approvals.py
backend/app/api/commands.py
tests/unit/workflow/
tests/integration/workflow/
tests/e2e/workflow/
~~~

### 3.2 固定研发流程

实现以下流程，不允许任务实现自行增加分支：

~~~text
准备/立项
  → 调研/PRD
  → PM 交叉评审
  → Boss PRD 审批
  → 可行性讨论
  → 需求争议（必要时 Boss 裁决）
  → 开发任务拆解
  → 开发/自测
  → 开发代表 Review
  → 测试策略/用例
  → 真实测试
  → 缺陷/NPI/回归（如需）
  → Boss 测试放行
  → 结项检查/历史归档
~~~

测试放行驳回必须严格走：

~~~text
Boss 驳回 + 方向意见
  → 责任组长整改计划
  → 测试策略/用例
~~~

不得直接回到开发任务拆解，也不得清空已经通过的任务和证据。

### 3.3 项目状态

| 当前状态 | 允许下一状态 | 保护规则 |
| --- | --- | --- |
| 准备中 | 运行中、已终止 | 未确认启动不得产生真实执行。 |
| 运行中 | 等待 Boss、已暂停、已阻塞、结项中、已终止 | 不得直接进入已结项。 |
| 等待 Boss | 运行中、已暂停、已终止 | 未完成关卡不得自动恢复。 |
| 已暂停 | 运行中、已终止 | 暂停期间不得启动新任务。 |
| 已阻塞 | 运行中、已暂停、已终止 | 阻塞未解除不得推进受影响任务。 |
| 结项中 | 已结项、已阻塞、已终止 | 结项检查失败不能结项。 |
| 已结项 | 无 | 只读，不可恢复。 |
| 已终止 | 无 | 只读，不可恢复。 |

### 3.4 任务状态

| 当前状态 | 允许下一状态 | 保护规则 |
| --- | --- | --- |
| 待处理 | 进行中、阻塞、已终止 | 依赖不满足不能开始。 |
| 进行中 | 等待 Review、等待审批、阻塞、已完成、已终止 | 需要 Review/测试的任务不能无证据完成。 |
| 等待 Review | 返工、已完成、阻塞、已终止 | 未 Review 通过不能进入测试基线。 |
| 等待审批 | 返工、已完成、阻塞、已终止 | 数字员工不能代替 Boss。 |
| 阻塞 | 进行中、已终止 | 必须保存原因、影响和恢复条件。 |
| 返工 | 进行中、阻塞、已终止 | 关联原任务、意见和新版本。 |
| 已完成 | 无 | 重试必须创建新 Attempt/版本。 |
| 已终止 | 无 | 不得恢复执行。 |

### 3.5 调度和暂停

- 任务只有依赖满足、项目处于可运行状态、角色可用和 Grant 有效时才可领取。
- 不存在依赖冲突的开发/测试任务可以并行；每个并行任务必须有独立 Attempt 和可写工作区。
- P0/P1/P2 优先级高于 P3；P3 不得阻塞、延迟或降低更高优先级任务。
- 进入人工审批、重大风险或系统异常时，受影响流程自动暂停。
- Boss 主动暂停后不启动新任务，已完成内容和正在执行 Attempt 的检查点必须保留。
- 恢复从最近有效状态继续，不重复已完成任务，除非有明确重试命令。

## 4. 接口设计

### 4.1 项目命令

沿用总体概要设计：

~~~http
POST /api/v1/projects
POST /api/v1/projects/{id}/start
POST /api/v1/projects/{id}/pause
POST /api/v1/projects/{id}/resume
POST /api/v1/projects/{id}/terminate/preview
POST /api/v1/projects/{id}/terminate/confirm
GET  /api/v1/projects/{id}/dashboard
~~~

终止预览响应：

~~~json
{
  "projectId": "project_01J",
  "currentStage": "真实测试",
  "currentStatus": "运行中",
  "unfinishedTasks": ["task_01J", "task_02J"],
  "impact": "终止后项目进入历史存档，不可恢复为活动项目",
  "requiresReason": true,
  "requiresSecondConfirmation": true,
  "confirmationToken": "terminate-confirm-01J"
}
~~~

终止确认必须提交非空 reason、confirmationToken、expectedVersion 和 idempotencyKey。

### 4.2 审批接口

~~~http
GET  /api/v1/approvals/{id}
POST /api/v1/approvals/{id}/decision
~~~

通过请求：

~~~json
{
  "decision": "approved",
  "opinion": null,
  "evidenceVersion": 4,
  "expectedVersion": 7,
  "idempotencyKey": "approval-apr_01J-v7"
}
~~~

驳回请求：

~~~json
{
  "decision": "rejected",
  "opinion": "先保证主流程，延后装饰性功能",
  "evidenceVersion": 4,
  "expectedVersion": 7,
  "idempotencyKey": "approval-apr_01J-v8"
}
~~~

空意见驳回返回 422 INVALID_ARGUMENT；不是 Boss、状态不合法、证据版本过期或有阻断性缺陷时返回相应 403/409/422。

### 4.3 Workflow Coordinator 接口

~~~typescript
class WorkflowCoordinator(Protocol):
    async def advance(
        self,
        project_id: str,
        trigger: WorkflowTrigger,
    ) -> AdvanceResult: ...

    async def pause(self, project_id: str, reason: PauseReason) -> None: ...
    async def resume(self, project_id: str, command_id: str) -> None: ...
    async def terminate(self, project_id: str, reason: str) -> None: ...
~~~

AdvanceResult 必须包含新状态、下一任务、等待对象、阻塞原因、通知事件和 traceId。Workflow Coordinator 只能写业务事件和状态，不能直接执行模型、网页、文件或 Docker。

### 4.4 任务调度接口

内部接口：

~~~text
claim(taskId, roleId, taskVersion) -> Lease
heartbeat(attemptId) -> LeaseStatus
release(attemptId, result) -> ScheduleDecision
~~~

领取必须原子检查项目状态、任务依赖、角色、优先级、租约和 Grant；过期租约不能继续执行。

## 5. 开发实施方法

1. 先把需求矩阵的项目/任务/通知状态表转换成状态枚举、允许转换表和禁止转换测试。
2. 写状态机不变量测试：非法状态、越过审批、未 Review 进入测试、未关闭阻断缺陷放行、终止后恢复等必须先失败再实现。
3. 实现项目命令、审批命令、终止预览/确认和幂等。
4. 实现固定工作流节点和边，特别固定测试放行驳回回路。
5. 实现任务依赖、优先级、租约和并行调度。
6. 实现暂停/恢复/阻塞/系统异常/重大风险通知和恢复条件。
7. 通过 Worker 接口交给 task5.md～task8.md，通过查询 API 交给 task9.md/task10.md。

需要使用：

- Node.js 22 LTS、TypeScript、Fastify、TypeBox、Drizzle ORM；
- LangGraph 或等价的固定流程运行时，但业务状态仍由显式状态机守卫；
- SQLite 事务、Outbox、Worker Lease；
- Vitest、状态机表驱动测试、并发/幂等集成测试和 E2E 流程测试。

## 6. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T4-AC-01 | 正常闭环 | 执行代表性项目 | 流程按固定顺序从立项走到结项，所有人工关卡和交付物均存在。 |
| T4-AC-02 | PRD 驳回 | Boss 驳回并填写方向意见 | 回到 PM 修订，旧版和新版及意见可追踪，未批准 PRD 不能拆开发任务。 |
| T4-AC-03 | 需求争议 | PM 与开发代表产生不一致 | 生成争议审批，Boss 决定后由组长转任务，不让 Boss 填技术方案。 |
| T4-AC-04 | Review 驳回 | 驳回一个开发任务 | 只进入相关任务返工，其他通过任务不重置。 |
| T4-AC-05 | 测试放行驳回 | Boss 驳回测试放行 | 进入责任组长整改计划，再回到测试策略/用例，不回到任务拆解。 |
| T4-AC-06 | 重大风险 | 注入重大风险 | 受影响流程暂停，生成 P0 通知、证据和 Boss 审批入口。 |
| T4-AC-07 | 主动暂停/恢复 | Boss 暂停并恢复 | 暂停期间无新任务；恢复后从最近有效状态继续，不重复已完成任务。 |
| T4-AC-08 | 终止 | 终止空原因、未二次确认、已确认 | 前两者被拒绝；确认后进入已终止和历史存档，不可恢复。 |
| T4-AC-09 | 优先级调度 | 同时提交 P0 和 P3 | P0 优先；P3 不阻塞高优先级任务，并记录调整原因。 |
| T4-AC-10 | 非法流转 | 直接把运行中改为已结项 | 返回 409 WORKFLOW_GUARD_BLOCKED，状态和事件不变。 |
| T4-AC-11 | 幂等审批 | 重复提交相同审批命令 | 返回原审批结果，不生成重复审批或状态事件。 |
| T4-AC-12 | 重启恢复 | 在运行中、等待 Boss、已暂停分别重启 | 状态、未完成任务和人工关卡保持，60 秒内可见。 |
| T4-AC-COMMIT | 分支、验收与开发完成提交 | Task 开发、测试和文档完成后检查 `git branch --show-current`、`git log`、提交哈希和工作区状态 | Task 4 在从最新 `master` 创建的 `dev/task-4` 分支上完成；已创建完成提交，提交哈希已写入验收证据；验收和 Review 成功后才合并到 `master`，并记录合并提交哈希。 |

必须保存流程事件序列、状态前后态、审批记录、通知、调度租约、暂停/恢复原因、终止确认和错误响应。

## 7. 完成定义与交接

- 开发结束时已在 `dev/task-4` 分支创建一次可识别的 Task 4 完成提交，提交哈希已记录在验收证据中，相关工作区无未提交变更；验收和 Review 成功后才允许合并到 `master`，并记录合并提交哈希。
- 项目、任务、通知状态机与需求矩阵完全一致。
- 四类 Boss 审批不可被 Worker、Harness 或自动流程代替。
- 测试放行驳回路径已覆盖责任组长整改计划。
- 调度器支持依赖、P0～P3、并行和租约。
- task5.md 可领取模型执行任务，task6.md 可推进 PM 调研，task7.md 可创建 Coding Attempt，task8.md 可推进 Review/测试/NPI，task9.md/task10.md 可调用项目控制和查询接口。
