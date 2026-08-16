# Task 2：核心业务对象、版本、领域事件与证据追踪

> 任务编号：DEV-02
> 任务状态：实现与自动化验收通过，提交待用户确认（2026-08-16）
> 任务类型：领域模型、持久化、事件、证据和追踪链
> 前置任务：task1.md
> 后续消费者：task3.md、task4.md、task5.md、task6.md、task7.md、task8.md、task9.md、task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

建立所有业务模块共享的事实源和追踪链。项目、任务、审批、交付物、Review、测试、缺陷、模型调用、工具调用和事件都必须有稳定的对象标识、版本、责任角色、状态、时间和上下游关联。

本任务是后续任务的数据契约任务：它不决定具体工作流是否允许推进，但必须让工作流能够原子写入事实，让执行器能够提交证据，让 UI 能够查询一致状态，让验收能够从需求追踪到最终证据。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §7.5：项目、任务、消息、交付物和缺陷。
- PRD §7.9：项目状态与事件记录。
- PRD §8.4：重启、追加历史和幂等。
- PRD §9.3～§9.4：七维指标、追踪完整率 100% 和九条硬性合格线。
- 对应 AC-05～AC-08、AC-12、AC-19～AC-23。

### 2.2 需求矩阵

- SR-OBJ-001～008、SR-EVT-001～006；
- SR-REL-001/002/004/005；
- SR-DAT-001～007、SR-NFR-005/008；
- AS-01、AS-03、AS-05、AS-06、AS-10、AS-11、AS-12、AS-15。

### 2.3 概要设计

- 总体设计 §4.2、§4.5、§5、§7、§8、§9：B 业务服务、E 数据平台、事务/Outbox、核心关系图、Artifact Store、Trace 和备份。
- BIMA §4.2～§4.3、§6、§12、§15：事件不变量、对象 Schema、Checkpoint、Handoff 和 Review。

## 3. 具体交付物

### 3.1 建议代码目录

~~~text
backend/src/domain/
backend/src/infra/repositories/
backend/src/infra/artifacts.ts
backend/src/infra/outbox.ts
backend/src/api/
backend/tests/unit/
backend/tests/integration/
~~~

### 3.2 领域对象和最小字段

| 对象 | 必须保存的内容 |
| --- | --- |
| Project | 项目名称、业务目标、目标用户、优先级、截止时间、约束、阶段、主状态、创建/结束时间、版本。 |
| Task | 标题、负责人、专业标签、分派理由、优先级、依赖、预期交付物、状态、开始/结束时间、版本。 |
| Artifact/ArtifactVersion | 名称、类型、版本、负责人、任务、状态、创建时间、内容引用、父版本、上下游链接。 |
| Approval | 审批类型、待审批对象、证据版本、决定、方向意见、Boss、时间、状态和响应任务。 |
| Review | 交付物版本、Reviewer、决定、意见、证据版本、时间、返工任务关联。 |
| TestCase | 验收标准关联、前置条件、步骤、预期结果、测试类型、负责人、版本。 |
| TestRun | 测试用例、基线版本、命令/步骤、环境、起止时间、实际结果、退出结果、证据。 |
| Defect | 来源测试、复现信息、严重级别、实际/预期结果、证据、NPI 负责人、状态、回归结果。 |
| ExecutionAttempt | 任务、角色、模型配置版本、工作区、租约、状态、开始/结束时间、重试信息。 |
| ModelCall/ToolCall | 项目、任务、角色、Attempt、提供商/工具、起止时间、耗时、摘要、错误、Token/成本、traceId。 |
| Notification | 事件、类型、等级、对象、未读/已读/待处理/已处理、处理人、处理动作、时间。 |
| DomainEvent | 事件 ID、类型、聚合、聚合版本、时间、操作者、输入/输出摘要、结果、失败、重试、traceId。 |

### 3.3 Schema 和迁移

- 使用 Drizzle ORM/better-sqlite3 定义并访问关系和约束。
- 使用 TypeScript migration journal 管理版本；迁移 SQL 由应用内 migration 模块执行。
- 当前 Schema 基线为 `0003_task2_integrity_trace_fix`；该版本补充 Artifact 完整性状态、DomainEvent 上下文持久化字段，并修复 Artifact/Notification TraceLink trigger。
- 所有业务对象必须有稳定 ID，推荐使用不可猜测的时间有序 ID。
- 交付物内容、大型 stdout/stderr、diff 和网页快照不直接塞入业务表，保存到 Artifact Store 后在数据库保存引用和 SHA-256。
- 事件表只追加，不允许更新历史事件正文。

### 3.4 追踪关系

必须支持以下双向链路：

~~~text
PRD/验收标准
  ↔ 需求/任务
  ↔ 交付物版本
  ↔ Review/审批
  ↔ 测试用例/测试运行
  ↔ 缺陷/NPI 修复/回归
  ↔ 模型调用/工具调用/事件
  ↔ EV 验收证据
~~~

## 4. 接口设计

### 4.1 统一命令信封

所有写命令使用：

~~~json
{
  "commandId": "cmd_01J",
  "idempotencyKey": "project-start-01J",
  "aggregateId": "project_01J",
  "expectedVersion": 12,
  "actor": {"type": "boss", "id": "boss-local"},
  "payload": {}
}
~~~

统一成功响应：

~~~json
{
  "aggregateId": "project_01J",
  "version": 13,
  "eventId": "evt_01J",
  "allowedActions": ["pause", "terminate"],
  "traceId": "tr_01J"
}
~~~

同一个 idempotencyKey 再次请求必须返回原结果，不能重复写事件、创建任务或应用外部副作用。

### 4.2 领域事件接口

~~~typescript
interface EventStore {
  append(aggregateType: string, aggregateId: string, expectedVersion: number, events: DomainEventDraft[]): Promise<AppendResult>;
  listAfter(eventId: string | null, projectId?: string | null): Promise<DomainEvent[]>;
}
~~~

每个事件必须能够定位到业务对象；安全事件和调用事件额外携带 attemptId、actor、拒绝原因和脱敏原因。

### 4.3 Artifact Store 接口

~~~typescript
interface ArtifactStore {
  put(content: Buffer, mediaType: string, metadata: ArtifactMetadata): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Buffer>;
  verify(ref: ArtifactRef): Promise<VerificationResult>;
  deleteForProject(projectId: string): Promise<DeleteReport>;
}
~~~

ArtifactRef 至少包含 artifactId、sha256、mediaType、size、createdAt 和存储相对路径。删除时必须遵守历史删除和备份保管规则。

### 4.4 查询和事件流

沿用总体设计：

~~~http
GET /api/v1/events?after={eventId}
~~~

此接口返回 text/event-stream。事件流只发布已事务提交的事件；不得先推送 UI 再写数据库。

后续查询 API 至少要能按 projectId、taskId、artifactId、traceId、actor 和时间范围过滤事件/证据。

## 5. 开发实施方法

1. 先画出核心关系图和对象生命周期，固定主键、版本字段、外键和删除策略。
2. 先写 TypeBox/领域对象 Schema、非法字段测试、版本冲突测试和事件追加测试，再写 Drizzle/SQLite 实现。
3. 实现事务边界：业务状态、领域事件、Outbox 和版本号必须在同一事务中提交。
4. 实现 Artifact Store 的内容寻址、SHA-256、大小限制、元数据校验和引用删除。
5. 实现 TraceLink 和覆盖率查询，先用代表性项目的人工数据验证双向导航。
6. 实现幂等命令处理，再交给 task4.md 接入工作流命令。
7. 使用 SQLite WAL 做单机集成测试；模拟崩溃、重复消息、重复命令和部分失败。

需要使用：

- Node.js 22 LTS、TypeScript、TypeBox、Drizzle ORM、better-sqlite3、SQLite WAL；
- 本地文件 Artifact Store 和 SHA-256；
- OpenTelemetry/结构化 JSON Log 的链路字段；
- Vitest、事务回滚测试、临时目录、数据迁移测试。

## 6. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T2-AC-01 | 创建/读取 Project 和 Task | 写入完整对象后重新查询 | 必填字段、版本、责任角色、状态和时间均一致。 |
| T2-AC-02 | 交付物版本 | 创建 v1、修订为 v2 | v1 不被覆盖，v2 可回溯父版本和修改原因。 |
| T2-AC-03 | 事件追加 | 产生审批、失败、重试和恢复事件 | 事件按时间和聚合版本追加，原始失败/驳回仍可查询。 |
| T2-AC-04 | 事务原子性 | 在状态写入与事件写入之间模拟崩溃 | 不出现状态已变但事件缺失，或事件存在但状态未提交的半完成结果。 |
| T2-AC-05 | 幂等命令 | 重复提交同一 idempotencyKey | 返回相同结果，不新增任务、审批、交付物或外部副作用。 |
| T2-AC-06 | 版本冲突 | 使用旧 expectedVersion 写入 | 返回 409 VERSION_CONFLICT，不覆盖最新数据。 |
| T2-AC-07 | Artifact 完整性 | 修改 Artifact 文件或清单 | SHA-256 校验失败，引用被标记为不可用，不伪造通过。 |
| T2-AC-08 | 追踪链 | 从验收标准查询到任务、用例、测试、缺陷和证据 | 代表性项目关键对象断链数为 0，支持前后双向导航。 |
| T2-AC-09 | 重启恢复 | 写入项目/任务/事件后重启数据库和应用 | 已提交数据、版本和事件链全部保留。 |
| T2-AC-10 | 删除边界 | 删除历史项目并检查业务库、Artifact、Trace 和审计 | 业务内容按规则删除，最小删除审计保留，备份按保管策略处理。 |
| T2-AC-COMMIT | 分支、验收与开发完成提交 | Task 开发、测试和文档完成后检查 `git branch --show-current`、`git log`、提交哈希和工作区状态 | Task 2 在从最新 `master` 创建的 `dev/task-2` 分支上完成；已创建完成提交，提交哈希已写入验收证据；验收和 Review 成功后才合并到 `master`，并记录合并提交哈希。 |

证据包括：迁移日志、数据库查询、事件序列、Artifact 清单、SHA 校验、幂等响应、版本冲突响应和追踪链报告。

## 7. 完成定义与交接

- 开发结束时已在 `dev/task-2` 分支创建一次可识别的 Task 2 完成提交，提交哈希已记录在验收证据中，相关工作区无未提交变更；验收和 Review 成功后才允许合并到 `master`，并记录合并提交哈希。
- 对象 Schema、迁移和仓储接口已冻结，后续任务不能私自新增同义对象。
- 事务、事件、Outbox、Artifact 和 TraceLink 有集成测试。
- task3.md 可以使用项目/任务/角色/消息对象，task4.md 可以使用状态和事件，task7.md 可以保存 Attempt/Observation/Checkpoint，task9.md/task10.md 可以查询读模型。
- 关键对象追踪完整率、审计不可覆盖和幂等测试通过。
