# Task 7 验收与 Review 证据

> 任务：DEV-07 / Task 7
> 分支：`dev_task7`
> 基线：`master` / `48dc2bfd7e1ad7e65552fd7128e4767ef5e6b11c`
> 实现提交：`35ffc6f4a35ae2343f4de0144194d462a6e91279`
> 状态：本地已提交，未 push，未合并到 `master`
> 验收日期：2026-08-17

## 1. 分支和交付边界

- 本次从当时最新的本地 `master` 创建并切换到 `dev_task7`，开发、测试和提交均发生在该分支。
- 代码开发准则中的示例分支名是 `dev/task-7`；本次采用用户明确指定的 `dev_task7`，没有直接在 `master` 开发。
- 当前 HEAD 是实现提交 `35ffc6f4`，工作区在验收时保持干净；没有执行 `git push`、`merge` 或远端写入。
- Task 7 只实现 `NativeCodingHarness` 和它依赖的执行边界；Workflow Coordinator 仍拥有业务任务状态推进权限，Task 8/10 负责后续测试放行、NPI 路由和完整项目流程消费。

## 2. 实现追踪

| 验收项 | 实现位置 | 证据和结果 |
| --- | --- | --- |
| T7-AC-01 缺少上下文 | `backend/src/domain/coding/index.ts:314-358`、`backend/src/coding/native-harness.ts:86-177` | 结构化 Spec/Grant 先校验；目标、验收标准、授权或技术配置缺失时形成 `BLOCKED` 投影，不能创建 Action。缺失 Grant 在会话创建前安全拒绝，不产生可写会话或代码变更。 |
| T7-AC-02 结构化计划 | `backend/src/coding/context-builder.ts:23-93`、`backend/src/coding/planner.ts:17-121`、`backend/src/coding/native-harness.ts:668-724` | Context → Plan → Policy 顺序固定；计划包含目标、影响文件、方案、版本化验证命令、风险、不确定项和结构化动作。模型 Planner 通过 Task 5 `ModelGateway`，确定性 Planner 只作为无模型测试/本地 fallback。 |
| T7-AC-03 越权计划 | `backend/src/coding/policy.ts:18-164`、`backend/src/coding/native-harness.ts:303-448` | 路径、命令、工具、角色、项目/任务/版本和 PolicyGate 均在进入实施前校验；验证命令必须与固定 VerificationProfile 完全一致；拒绝写入 `policy_decisions`、Observation 和 DomainEvent。 |
| T7-AC-04 增量 Patch | `backend/src/execution/file-gateway.ts:17-130`、`backend/src/infra/repositories/coding.ts:139-294` | 单文件 unified diff、before/after SHA、完整 diff Artifact、Patch 序号、原因、Attempt/traceId 和 Checkpoint 均持久化；文件写入使用临时文件、fsync 和原子 rename。 |
| T7-AC-05 基线冲突 | `backend/src/execution/file-gateway.ts:74-130` | 当前 SHA 或 hunk 上下文不匹配返回 `BASE_VERSION_MISMATCH`，不覆盖工作区；失败 Observation 保留拒绝原因。 |
| T7-AC-06 真实验证 | `backend/src/execution/verification.ts:15-131`、`backend/src/execution/command-gateway.ts:32-73`、`backend/src/domain/coding/index.ts:476-496` | 版本化 Profile 按顺序通过 CommandGateway 执行；每个步骤保存开始/结束时间、退出码、stdout/stderr Artifact、错误码、失败分类和 traceId。后端 Profile 固定为 `ruff check .`、`npm test -- --run`、`npm run typecheck`、`npm run db:check`。 |
| T7-AC-07 失败修复 | `backend/src/coding/native-harness.ts:450-519`、`backend/src/coding/native-harness.ts:801-849` | 输出分类为 `CODE_DEFECT`、`TEST_FLAKE`、`ENVIRONMENT`、`POLICY`、`CREDENTIAL` 或 `UNKNOWN`；同类失败最多 2 次、单 Attempt 最多 3 次，策略/凭据/未知失败不进入代码重试，超过上限转 `BLOCKED`。 |
| T7-AC-08 工作区隔离 | `backend/src/execution/workspace-manager.ts:20-221` | 每个 Attempt 使用独立随机目录；复制源目录时拒绝符号链接和目标目录递归复制；工作区边界、普通文件和快照 SHA 均受控。专项测试验证两个 Attempt 修改同名文件互不覆盖。 |
| T7-AC-09 工具拒绝 | `backend/src/execution/command-gateway.ts:32-237`、`backend/src/execution/file-gateway.ts:112-216` | 不开放任意 shell；命令禁止控制字符、管道、重定向、反引号、变量展开和路径逃逸；Docker 默认 network none、read-only、非 root、资源限制；文件路径拒绝绝对路径、穿越、符号链接和授权范围外目标。 |
| T7-AC-10 暂停/恢复 | `backend/src/coding/native-harness.ts:179-249`、`backend/src/coding/native-harness.ts:250-289`、`backend/src/infra/repositories/coding.ts:217-254` | 暂停写入原因、完整上下文、工作区快照和 Checkpoint；暂停/阻塞状态拒绝新工具动作；恢复前重新检查快照、Grant、Worker lease 和当前 Policy，不重复已有 Observation。 |
| T7-AC-11 Review 交接 | `backend/src/coding/native-harness.ts:521-650`、`backend/src/api/coding.ts:9-172` | Handoff 包含真实 diff、验证运行、实际命令、风险、失败、回滚快照和 traceId；Harness 不产生审批结果，只有 `developer_representative` 能提交 approved/changes_requested/blocked。 |
| T7-AC-12 Worker 崩溃/恢复 | `backend/src/coding/native-harness.ts:303-448`、`backend/src/coding/native-harness.ts:912-958`、`backend/src/infra/repositories/coding.ts:139-254` | Action 的 `running` 标记、幂等键、expectedVersion、工作区快照和 Checkpoint 支持动作前后安全恢复；生产入口要求 Scheduler 已领取 running Attempt 和有效 Worker lease。当前自动化验证覆盖进程内幂等/Checkpoint 恢复，未在本机执行真实 Worker kill 的端到端测试，见 Review 剩余风险。 |
| T7-AC-13 额外变更 | `backend/src/coding/native-harness.ts:450-590` | Verify 和 Handoff 两个边界都重新扫描基线以来的变更，并同时检查 TaskSpec 与 Grant 的可写路径；发现未授权文件时进入 `BLOCKED` 并列出文件名。 |

## 3. AS-17 执行记录

| 场景 | 测试位置 | 结果 |
| --- | --- | --- |
| 正常开发 1 次 | `backend/tests/integration/coding.test.ts:206-286` | 通过 Context → Plan → Policy → Patch → Verify → Handoff；Review 请求不会自动变成完成。 |
| Review 驳回 1 次 | `backend/tests/integration/coding.test.ts:316-366` | `changes_requested` 要求非空意见，状态只回到 `IMPLEMENTING`，Handoff 记录保留，未进入 `COMPLETED`。 |
| 测试失败/NPI 修复 1 次 | `backend/tests/integration/coding.test.ts:413-485` | 注入失败命令，形成 3 次有上限的 `FailureDiagnosis`，最终阻塞；Task 7 交付诊断和修复上下文，实际缺陷表/NPI 路由由后续 Workflow Coordinator 消费。 |
| 中断恢复 1 次 | `backend/tests/integration/coding.test.ts:368-411` | 暂停后 Action 数量不增加；从匹配的 Checkpoint 恢复到 `IMPLEMENTING`，工作区快照不匹配时阻止恢复。 |

## 4. 需求矩阵和设计追踪

| 需求组 | 对应实现 |
| --- | --- |
| SR-COD-001～002 | TypeBox TaskSpec/Grant/Plan 合同、ContextBuilder、Model/Deterministic Planner、Policy Gate。 |
| SR-COD-003～007 | FileGateway Patch-first、Observation/Checkpoint/Verification/Handoff Repository、人工 Review 门禁。 |
| SR-COD-008、SR-SEC-008～010 | 角色策略映射、Grant 项目/任务/Attempt/role/version/trace/期限校验、路径/命令默认拒绝、Docker Runner。 |
| SR-COD-009、SR-EXE-010 | 基线变更扫描、TaskSpec 与 Grant 可写路径交集、额外文件 Handoff 阻断。 |
| SR-COD-010、SR-OBS-002/003/005、SR-SEC-011 | DomainEvent、PolicyDecision、Action/Observation/Verification/Handoff 事实表，统一 project/task/attempt/role/trace 字段。 |
| SR-COD-011、SR-REL-001/002/004/005 | Pause/Cancel/Resume、Checkpoint、幂等键、expectedVersion、工作区快照和 Attempt lease 检查。 |
| SR-COD-012、SR-EXE-003/004/007/008 | Review 只允许开发代表决策；失败输出诊断并交给后续 NPI/测试流程，不由编码 Agent 关闭缺陷或放行。 |
| SR-EXE-001/002/006/009 | 真实命令网关、Attempt 隔离目录、验证 Artifact、事件和事实记录。 |
| SR-DAT/REL Schema 要求 | `0009_task7_coding` migration、6 张 coding 表、项目索引、外键、唯一幂等约束和启动完整性检查。 |

## 5. Review 清单

- [x] 已核对 `docs/task/task7.md` 的状态机、Action/Observation、Patch-first、Docker、验证阶梯、有限重试、Checkpoint、Handoff 和 T7-AC-01～13。
- [x] 已核对 PRD 相关 §7.7、§8.1、§8.3、§8.4、§10 验收关联，以及概要设计 D1～D8、§4.4、§5.2、§6.3、§9、§10。
- [x] 新增生产代码均使用业务职责命名：`native-harness`、`context-builder`、`planner`、`policy`、`workspace-manager`、`file-gateway`、`command-gateway`、`verification`；没有使用 `task7.ts` 作为代码文件名。
- [x] 已检索并复用 Task 2 EventStore/ArtifactStore、Task 3 PolicyGate/角色策略、Task 4 Workflow lease/Attempt、Task 5 ModelGateway；新增模块只负责 Task 7 的编码执行边界。
- [x] 已检查输入、状态、权限、项目范围、任务版本、Attempt、租约、路径、命令、资源、时间、并发/幂等和异常恢复边界。
- [x] 已在问题修复位置补充 `2026-08-17` 修改日期和原因，包括 Context 配置损坏、Patch 目标精确匹配、恢复重新策略校验、Handoff 实际命令、工作区嵌套和 Schema 完整性校验。
- [x] 已执行类型检查、构建、专项测试、全量测试、数据库完整性检查和 `git diff --check`。

### Review Findings

| 严重级别 | 文件/行号 | 触发输入或复现步骤 | 实际结果 | 预期结果及影响 | 修复提交或不修复理由 | 回归测试/剩余风险 |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | 无 | 未发现 | 无 P0 问题 | 不得绕过权限、审批、真实验证或数据边界 | 无需修复 | 全量测试 101/101 通过 |
| P1 | 无 | 未发现 | 无 P1 问题 | 核心执行、持久化和安全门禁满足 Task 7 设计 | 无需修复 | `typecheck`、`build`、`db:check` 通过 |
| P2 | `backend/src/execution/command-gateway.ts:75-124` | 在没有 Docker Engine 的机器上执行真实验证 | Docker Runner 返回结构化资源阻塞；本次专项测试注入受控 CommandRunner，没有宣称 Docker 已现场执行 | 生产环境必须由 Docker readiness 决定是否授予真实执行许可；不能静默降级到宿主机 shell | 保留为部署/验收环境风险；NativeProcessRunner 仅供测试或明确本地开发使用，默认 Runtime 仍是 Docker | 需在具备 Docker 的 CI/验收环境补一次真实容器执行和资源限制测试 |
| P2 | `backend/src/coding/native-harness.ts:801-849` | 验证失败后需要创建 defects/NPI/regression 业务对象 | Task 7 产生脱敏 FailureDiagnosis、证据引用和有限修复状态，但不直接写 NPI 业务表 | Task 7 文档将 task8/task10 作为后续消费者；Harness 不应越权改变业务任务或关闭缺陷 | 按设计边界保留，不视为 Task 7 内部缺陷；后续 Coordinator 必须消费该诊断并路由 NPI | 当前专项测试验证诊断、上限和 BLOCKED；NPI 端到端属于后续任务验收 |
| P2 | `backend/src/coding/native-harness.ts:303-448` | 杀掉真实独立 Worker 进程并在动作写入前后恢复 | 代码已持久化 running Action、幂等键、Checkpoint、expectedVersion 和 Worker lease 门禁；本次没有单独启动 Worker 进程并执行 kill | 重启后不能重复 Patch/命令，无法判定时必须阻塞 | 保留为环境级补测项，不降低本地 Task 7 提交的安全默认值 | 已覆盖幂等重放、暂停恢复和快照冲突；需要进程级 recovery harness 补测 |

## 6. 可复现命令

在 `backend/` 目录执行：

```bash
npm run typecheck
npm run build
npx vitest run tests/integration/coding.test.ts
npm test -- --run
npm run db:check
```

最终结果：专项测试 9/9；全量 19 个测试文件、101 个测试全部通过；类型检查、构建和数据库完整性检查全部通过。`db:check` 返回 `writable: true`、`revision: 0009_task7_coding`、`dataPreserved: true`。
