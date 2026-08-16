# Task 7：BIMA 编码 Agent、NativeCodingHarness 与隔离执行

> 任务编号：DEV-07
> 任务状态：待开发
> 任务类型：编码 Agent、Harness、上下文工程、Patch、Docker、验证、恢复
> 前置任务：task2.md、task3.md、task4.md、task5.md
> 后续消费者：task8.md、task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

实现 V1 的核心编码 Agent 能力，使开发和 NPI 任务通过以下闭环完成真实、可恢复、可审计的工程执行：

~~~text
Context → Plan → Policy → Implement → Verify → Diagnose/Repair → Handoff
~~~

V1 只实现 NativeCodingHarness。单个执行会话是单 Agent、多阶段状态机；互不冲突的开发任务可以创建多个会话，但任何两个会话不能共享可写工作区。

编码 Agent 只能提出结构化动作，Policy Gate 决定动作是否合法，Tool Gateway/Runner 产生事实结果，Workflow Coordinator 负责推进业务任务状态。编码 Agent 不能自行批准 Review、关闭缺陷、越过人工审批或把模型自述当作测试证据。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §7.7 编码 Agent 产品行为：任务理解、计划、增量实施、执行反馈、失败修复、自检交接。
- PRD §8.1、§8.3、§8.4：不能越权、必须真实执行、必须可暂停/恢复/追踪。
- PRD §10 的 AC-06、AC-08、AC-09、AC-10、AC-16、AC-18、AC-19、AC-25、AC-26。

### 2.2 需求矩阵

- SR-COD-001～012；
- SR-EXE-001～004/009/010；
- SR-SEC-005/008～011；
- SR-REL-001～005；
- SR-OBS-002/003/005；
- AS-01、AS-05、AS-06、AS-08、AS-10、AS-13、AS-16、AS-17。

### 2.3 设计依据

- 总体设计 D1～D8、§4.4、§5.2、§6.3、§9、§10；
- BIMA 详细设计 §1～§19 全部章节，尤其是状态机、Action/Observation、Patch-first、Docker、验证阶梯、Checkpoint、Handoff 和安全设计。
- task2.md 提供 EventStore、ArtifactStore、Attempt 和 TraceLink；
- task3.md 提供角色/工具/路径策略；
- task4.md 提供任务租约、审批和状态推进；
- task5.md 提供 Model Adapter 和配置版本。

## 3. 具体交付物

### 3.1 建议代码目录

~~~text
backend/app/coding/
backend/app/coding/api.py
backend/app/coding/spi.py
backend/app/coding/native_harness.py
backend/app/coding/session_manager.py
backend/app/coding/context_builder.py
backend/app/coding/planner.py
backend/app/coding/agent_loop.py
backend/app/coding/diagnosis.py
backend/app/coding/handoff.py
backend/app/execution/
backend/app/execution/tool_gateway.py
backend/app/execution/file_gateway.py
backend/app/execution/command_gateway.py
backend/app/execution/workspace_manager.py
backend/app/execution/docker_runner.py
backend/app/execution/verification.py
backend/app/execution/evidence_collector.py
worker/coding_worker.py
tests/unit/coding/
tests/integration/coding/
tests/sandbox/coding/
tests/security/coding/
tests/recovery/coding/
~~~

### 3.2 CodingTaskSpec

实现并校验：

~~~json
{
  "taskId": "task_01J",
  "projectId": "project_01J",
  "title": "增加登录表单校验",
  "goal": "提交前校验邮箱格式并展示错误提示",
  "acceptanceCriteria": [
    "非法邮箱不可提交",
    "错误提示可见",
    "现有测试不回归"
  ],
  "workspaceRoot": "workspace://project_01J",
  "baselineCommit": "local-snapshot-sha",
  "allowedPaths": ["frontend/src/**", "frontend/tests/**"],
  "forbiddenPaths": [".env*", "secrets/**", "backend/migrations/**"],
  "stackProfile": "react-ts-vite",
  "verificationProfile": "frontend-default",
  "riskPolicy": "standard",
  "taskVersion": 3
}
~~~

缺少目标、验收标准、工作区授权、技术栈 Profile 或任务版本时，任务进入阻塞，不能产生代码变更。

### 3.3 ExecutionGrant

~~~json
{
  "grantId": "grant_01J",
  "projectId": "project_01J",
  "taskId": "task_01J",
  "attemptId": "attempt_01J",
  "role": "developer",
  "roleVersion": 1,
  "modelConfigVersion": 7,
  "modelProvider": "openai",
  "modelName": "configured-model",
  "workspaceGrant": {
    "root": "/workspace/project",
    "read": ["/workspace/project/**"],
    "write": ["/workspace/project/frontend/src/**"],
    "deny": ["**/.env*", "**/secrets/**"]
  },
  "toolPolicy": [
    "repo_scan",
    "read_file",
    "search_code",
    "apply_patch",
    "run_verification"
  ],
  "commandPolicy": {
    "allow": ["npm test", "npm run build", "npm run lint"],
    "network": "deny"
  },
  "expiresAt": "2026-08-12T11:20:30Z",
  "policyVersion": 5,
  "traceId": "tr_01J"
}
~~~

每次动作执行前重新校验 Grant 未过期、任务版本匹配、工作区版本匹配、角色正确、路径和工具在授权范围内。

### 3.4 AgentHarness SPI

~~~python
class AgentHarness(Protocol):
    async def start(
        self,
        spec: CodingTaskSpec,
        grant: ExecutionGrant,
    ) -> SessionHandle: ...

    async def resume(
        self,
        session_id: str,
        checkpoint_id: str,
    ) -> SessionHandle: ...

    async def pause(self, session_id: str, reason: str) -> None: ...
    async def cancel(self, session_id: str, reason: str) -> None: ...
    async def stream(self, session_id: str) -> AsyncIterator[AgentEvent]: ...
    async def result(self, session_id: str) -> CodingExecutionResult: ...
~~~

Harness 不直接持有业务数据库写权限；必须通过 SessionRepository、EventStore、ArtifactStore、ModelAdapter 和 ToolExecutor 接口协作。

## 4. 生命周期与状态设计

### 4.1 Harness 状态

| 状态 | 进入条件 | 必须产物 | 允许离开 |
| --- | --- | --- | --- |
| CREATED | 创建 Attempt | SessionCreated | CONTEXT_BUILDING |
| CONTEXT_BUILDING | 获得租约 | ContextPack、扫描清单、缺失项 | PLAN_READY 或 BLOCKED |
| PLAN_READY | 上下文完整 | CodingPlan | POLICY_PENDING |
| POLICY_PENDING | 计划生成 | PolicyDecision | IMPLEMENTING、PLAN_READY 或 REVIEW_REQUESTED |
| IMPLEMENTING | 策略通过 | Action、Observation、PatchBatch | VERIFYING、PAUSED、CANCELLED |
| VERIFYING | Patch 应用成功 | VerificationRun | DIAGNOSING、REVIEW_REQUESTED、BLOCKED、PAUSED |
| DIAGNOSING | 验证失败且可修复 | FailureDiagnosis、下一次计划 | IMPLEMENTING 或 BLOCKED |
| REVIEW_REQUESTED | 验证满足交接条件 | HandoffPackage | COMPLETED、IMPLEMENTING 或 BLOCKED |
| PAUSED | Boss/系统暂停 | Checkpoint、暂停原因 | IMPLEMENTING 或 CANCELLED |
| BLOCKED | 缺少上下文、策略拒绝、重试耗尽或依赖不可用 | FailureReport、安全事件或阻塞说明 | IMPLEMENTING 或终止 |
| CANCELLED | 取消确认 | 取消事件、工作区和证据保留 | 终态 |
| COMPLETED | Review 通过且外层流程允许 | 完整结果 | 终态 |

PAUSED、BLOCKED、CANCELLED 状态禁止自动执行新的工具动作。

### 4.2 状态不变量

1. 只有 Workflow Coordinator 能改变业务任务状态。
2. 只有存在有效 Grant、租约和工作区版本匹配时，才能进入 IMPLEMENTING。
3. COMPLETED 前必须存在成功验证证据、完整 diff 和 Review 决策。
4. 每次状态转换必须原子写入状态版本、领域事件和 Outbox。
5. 事件重放不能重复应用 Patch、命令或外部模型调用。
6. 外部副作用通过 idempotencyKey 去重。

## 5. 上下文工程

### 5.1 构建顺序

~~~text
TaskSpec + Grant
  → 目录/技术栈确定性扫描
  → Repo Map
  → 规则文件、入口、构建/测试命令
  → 任务相关文件/符号/调用关系检索
  → 相关测试和历史失败
  → ContextPack
~~~

优先读取 package.json、tsconfig.json、vite.config.*、pyproject.toml、requirements、Dockerfile、测试配置、规则文件和入口文件。模型可以补充相关性判断，但不能覆盖路径授权和规则文件结论。

### 5.2 上下文压缩

窗口接近上限时，只允许生成结构化压缩摘要，必须保留：

- 任务目标和验收标准；
- 已批准约束；
- 已读/已改文件；
- 当前 diff 摘要；
- 已执行命令和验证结果；
- 失败分类、根因假设和重试计数；
- 未解决问题、剩余风险、下一动作；
- Artifact 引用和 Checkpoint ID。

压缩不删除原始事件、Artifact 和证据。

## 6. Action、Observation 和 Patch 设计

### 6.1 Action

模型只能输出结构化动作：

~~~json
{
  "actionId": "act_01J",
  "sessionId": "ses_01J",
  "seq": 17,
  "type": "apply_patch",
  "input": {
    "path": "frontend/src/LoginForm.tsx",
    "baseFileSha256": "sha256:...",
    "patch": "unified-diff"
  },
  "reason": "add email validation before submit",
  "idempotencyKey": "ses_01J:17:apply_patch",
  "requiresApproval": false
}
~~~

允许工具：repo_scan、read_file、search_code、apply_patch、run_verification、save_evidence。默认不提供任意 shell。

### 6.2 Observation

~~~json
{
  "observationId": "obs_01J",
  "actionId": "act_01J",
  "status": "succeeded",
  "exitCode": 0,
  "changedFiles": [
    {
      "path": "frontend/src/LoginForm.tsx",
      "before": "sha256:a",
      "after": "sha256:b"
    }
  ],
  "stdoutRef": "artifact://stdout/obs_01J",
  "stderrRef": null,
  "diffRef": "artifact://diff/obs_01J",
  "durationMs": 382,
  "redactions": [],
  "traceId": "tr_01J"
}
~~~

拒绝也是 Observation，但不能自动当作代码缺陷重试。拒绝原因至少包括 PATH_DENIED、COMMAND_DENIED、GRANT_EXPIRED、RESOURCE_LIMIT、NETWORK_DENIED、SECRET_ACCESS_DENIED、BASE_VERSION_MISMATCH 和 APPROVAL_REQUIRED。

### 6.3 Patch-first 事务

每次写入必须：

1. 校验目标路径、基线 SHA、任务版本和 Grant；
2. 在临时副本应用小批量统一 diff；
3. 执行语法/Schema 快速检查；
4. 失败则回滚当前 Patch，不删除历史成功 Patch；
5. 成功后使用 fsync 和原子替换；
6. 保存 before/after SHA、完整 diff、Patch 序号、工具版本和 traceId；
7. 创建 Checkpoint。

生成物目录、依赖缓存和测试输出不能自动计作业务源代码变更。

## 7. 工作区和命令隔离

每个 attemptId 建立独立工作区和容器：

- 容器非 root；
- 基础镜像只读；
- 工作区按最小路径挂载；
- CPU、内存、磁盘和执行时间受限；
- 默认网络关闭；
- 依赖安装必须是显式高风险动作，并由开发代表批准；
- .env、secrets、Keychain、SSH、系统目录和工作区外路径默认拒绝；
- 取消、超时、异常时必须回收进程和租约，但保留工作区快照和证据。

## 8. 验证阶梯、失败修复与 Review 交接

### 8.1 默认验证阶梯

前端 Profile：

~~~text
npm run lint
npm run typecheck
npm test -- --run
npm run build
~~~

后端 Profile：

~~~text
ruff check .
pytest -q
python -m compileall app
alembic check
~~~

实际命令只能来自版本化 VerificationProfile，不能由模型临时扩大权限。

### 8.2 失败分类和重试

| 分类 | 示例 | 动作 |
| --- | --- | --- |
| CODE_DEFECT | 断言、类型或编译错误 | 允许诊断和最小修复。 |
| TEST_FLAKE | 偶发超时、非确定失败 | 一次复跑后再判断。 |
| ENVIRONMENT | 缺包、资源超限、端口冲突 | 按策略修复，否则阻塞。 |
| POLICY | 越权路径、命令或网络 | 立即阻塞，不当代码缺陷重试。 |
| CREDENTIAL | Key 缺失或泄露风险 | 阻塞并请求配置。 |
| UNKNOWN | 无法建立根因 | 阻塞并交接人工。 |

同一失败类型最多自动修复 2 次，单 Attempt 最多自动修复 3 次。每次修复必须改变诊断假设或 Patch，不能盲目重复。

### 8.3 HandoffPackage

~~~json
{
  "handoffId": "handoff_01J",
  "sessionId": "ses_01J",
  "status": "review_requested",
  "summary": "完成邮箱格式校验并补充测试",
  "changedFiles": [
    "frontend/src/LoginForm.tsx",
    "frontend/src/LoginForm.test.tsx"
  ],
  "diffRef": "artifact://diff/handoff_01J",
  "verificationRuns": ["artifact://verification/run_01J"],
  "commands": ["npm run lint", "npm test -- --run"],
  "remainingRisks": [],
  "knownFailures": [],
  "rollback": {
    "workspaceSnapshot": "sha256:...",
    "patchSeq": [1, 2]
  },
  "traceId": "tr_01J"
}
~~~

Review 只能产生 approved、changes_requested、blocked。approved 只表示开发代表接受交付物，不等于测试放行或项目结项。

## 9. 接口设计：HTTP 和 Worker 接口

~~~http
POST /api/projects/{projectId}/coding-tasks
POST /api/coding-sessions
GET  /api/coding-sessions/{sessionId}
GET  /api/coding-sessions/{sessionId}/events
POST /api/coding-sessions/{sessionId}/pause
POST /api/coding-sessions/{sessionId}/resume
POST /api/coding-sessions/{sessionId}/cancel
GET  /api/coding-sessions/{sessionId}/handoff
POST /api/handoffs/{handoffId}/review
~~~

Worker 内部接口：

~~~text
POST /internal/v1/grants/claim
POST /internal/v1/attempts/{attemptId}/heartbeat
POST /internal/v1/attempts/{attemptId}/tool-records
POST /internal/v1/attempts/{attemptId}/result
POST /internal/v1/attempts/{attemptId}/cancelled
~~~

启动响应必须包含 sessionId、attemptId、status、leaseExpiresAt 和 eventStream。

## 10. 开发实施方法

1. 先定义 CodingTaskSpec、ExecutionGrant、Action、Observation、Checkpoint、VerificationRun 和 HandoffPackage 的 Pydantic Schema。
2. 先写状态不变量、Grant 匹配、路径拒绝、命令拒绝、幂等 Patch 和暂停禁止新动作测试。
3. 实现 Session/Lease/Checkpoint 和 EventStore/ArtifactStore 适配。
4. 实现 Context Builder 和 Planner，使用固定测试仓库验证上下文范围不会读取整个仓库。
5. 实现 Policy Gate、Tool Gateway、Workspace Manager 和 Docker Runner。
6. 实现 Patch-first 事务和 before/after SHA。
7. 实现 VerificationProfile、验证阶梯、失败分类和有限修复。
8. 接入 task5.md 的 Model Adapter，模型只返回结构化 Plan/Action。
9. 实现 HandoffPackage 和 Review API，交给 task8.md。
10. 完成 Worker 崩溃、控制面重启、租约过期和工作区 SHA 不匹配恢复测试。

需要使用：

- Python 3.12、FastAPI、Pydantic、asyncio；
- LiteLLM/Model Adapter；
- Docker Engine/Docker Desktop；
- 文件系统 SHA-256、临时副本、原子 rename；
- pytest、Docker sandbox、资源限制测试、提示注入/路径逃逸样本；
- OpenTelemetry、Artifact Store、SQLite WAL。

## 11. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T7-AC-01 | 缺少任务上下文 | 删除目标、验收标准或 Grant 后启动 | 进入 BLOCKED，不产生代码变更。 |
| T7-AC-02 | 结构化计划 | 启动正常开发任务 | Plan 包含目标、影响文件、方案、命令、风险和不确定项。 |
| T7-AC-03 | 越权计划 | 计划写入 forbiddenPaths 或运行未授权命令 | Policy Gate 拒绝，产生安全事件，不进入实施。 |
| T7-AC-04 | 增量 Patch | 修改多个文件并观察 Patch 记录 | 每批有文件列表、基线 SHA、diff、原因、Patch 序号和证据。 |
| T7-AC-05 | 基线冲突 | 外部修改文件后应用 Patch | 返回 BASE_VERSION_MISMATCH，不覆盖外部变更。 |
| T7-AC-06 | 真实验证 | 完成一次前端或后端任务 | 真实命令、版本、时间、退出码、stdout/stderr 和 Artifact 均存在。 |
| T7-AC-07 | 失败修复 | 注入类型错误或测试失败 | 形成 FailureDiagnosis 和下一次最小修复；达到上限后阻塞。 |
| T7-AC-08 | 工作区隔离 | 并行 Attempt 修改同名文件 | 各自工作区互不覆盖，可独立产生 diff。 |
| T7-AC-09 | 工具拒绝 | 尝试路径穿越、任意 shell、网络、Keychain 访问 | 被拒绝并记录结构化原因，不当作代码错误重试。 |
| T7-AC-10 | 暂停/恢复 | 运行中暂停、重启、恢复 | 暂停无新动作，恢复从 Checkpoint 继续，不重复 Patch/外部副作用。 |
| T7-AC-11 | Review 交接 | 验证通过后请求 Review | Handoff 包含 diff、验证、风险、失败、回滚和 trace；不能自动批准。 |
| T7-AC-12 | Worker 崩溃 | 在动作前后终止 Worker | 通过租约、事件序号、幂等键和工作区 SHA 判断安全恢复或阻塞。 |
| T7-AC-13 | 额外变更 | 在工作区增加未说明文件 | Handoff 被阻塞并列出额外变更。 |

AS-17 必须完整执行：正常开发 1 次、Review 驳回 1 次、测试失败/NPI 修复 1 次、中断恢复 1 次。

## 12. 完成定义与交接

- 一个真实开发任务可以产生上下文、计划、增量 diff、真实验证、失败诊断/修复、交接包和 Review 请求。
- 编码 Agent 不直接改变业务状态，不自行批准 Review，不关闭缺陷，不跳过测试放行。
- 所有文件、命令、测试、模型调用、失败和恢复证据都可按任务、Attempt 和 traceId 查询。
- 越界路径、未授权命令、网络访问、凭据访问、过期 Grant、版本冲突和超出重试上限均能阻止执行并留下脱敏事件。
- task8.md 可以选择已 Review 的基线并执行测试；task10.md 可以读取完整执行链和安全事件。
