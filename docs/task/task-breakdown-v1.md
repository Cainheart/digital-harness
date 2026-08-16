# 工程开发任务拆解总览 V1

## 文档定位

本文件是任务目录的索引、依赖总览和统一约束，不再承载十一个任务的全部实施细节。每个任务的交付物、接口设计、上游对齐、开发方法和验收标准分别维护在独立文件中。

- 任务总数：11
- 任务编号：DEV-01～DEV-11
- 任务目录：docs/task/
- 维护原则：任务细节以独立任务文件为准；本文件只维护导航、依赖、跨任务契约和发布检查
- 适用版本：V1
- 代码开发准则：[代码开发准则](../code-development-guidelines.md)；所有 Task 的新增、重写和问题修复必须遵守该准则。

## 上游依据

- [PRD v1](../PRD/PRDv1.md)
- [需求矩阵 v1.6-draft](../requirement/software-requirements-matrix-v1.md)
- [工程概要设计 v0.6-draft](../design/high-level-design-v1.md)
- [BIMA Agent 概要设计 v1](../design/bima-agent-detailed-design-v1.md)
- [Electron 桌面应用详细设计 v1](../design/electron-desktop-app-detailed-design-v1.md)

上游文档出现冲突时，必须先修复冲突并更新版本或变更记录，再继续实现任务；不能在任务文件中自行发明另一套口径。

## 十一个任务索引

| 编号 | 任务文件 | 负责范围 | 主要交付物 | 前置任务 |
|---|---|---|---|---|
| DEV-01 | [task1.md](task1.md) | 本地运行环境与基础设施 | 配置加载、SQLite/Alembic、Keychain 适配、健康检查、启动与关闭流程 | 无 |
| DEV-02 | [task2.md](task2.md) | 领域模型、事件、产物和追溯 | 核心实体、事件总线/Outbox、ArtifactStore、TraceLink、幂等和分页契约 | DEV-01 |
| DEV-03 | [task3.md](task3.md) | 组织、角色、消息和策略 | 组织/员工/角色模型、消息协议、角色 PolicyGate、权限和审计 | DEV-01、DEV-02 |
| DEV-04 | [task4.md](task4.md) | 项目工作流和任务调度 | 项目/任务状态机、事件流、审批、调度、暂停/终止/恢复 | DEV-02、DEV-03 |
| DEV-05 | [task5.md](task5.md) | 模型适配与配置 | OpenAI/DeepSeek 适配、模型配置、Token/成本账本、Keychain 绑定和降级 | DEV-01、DEV-02、DEV-03 |
| DEV-06 | [task6.md](task6.md) | 真实调研与研究证据 | ResearchGrant、来源采集、官方来源/独立性规则、事实与冲突、调研适配器 | DEV-02、DEV-03、DEV-05 |
| DEV-07 | [task7.md](task7.md) | BIMA Coding Agent | 任务上下文、计划、授权、受控执行、Patch、测试验证、诊断、恢复和交付 | DEV-02、DEV-04、DEV-05 |
| DEV-08 | [task8.md](task8.md) | Review、测试、缺陷与 NPI | Review Gate、测试策略/用例/执行、缺陷生命周期、NPI、回归和质量证据 | DEV-02、DEV-04、DEV-07 |
| DEV-09 | [task9.md](task9.md) | Boss 业务控制台 | 项目/任务/员工/审批/通知/归档/模型配置等业务页面和 API | DEV-03、DEV-04、DEV-05、DEV-08 |
| DEV-10 | [task10.md](task10.md) | 像素办公室、观测、评分和发布验收 | Office 投影、真实执行控制台、评分卡、备份恢复、AS-01～AS-18 最终汇总验收 | DEV-01～DEV-09、DEV-11 |
| DEV-11 | [task11.md](task11.md) | Electron 桌面应用与跨平台打包 | Electron Main/Preload、React/Vite production、Python sidecar、安装/升级、Docker 降级、AS-18 | DEV-01；完整集成依赖 DEV-02、DEV-04、DEV-07、DEV-09 |

## 任务依赖关系

~~~mermaid
flowchart TD
    T1["DEV-01 基础设施"] --> T2["DEV-02 领域模型、事件、产物"]
    T1 --> T3["DEV-03 组织、角色、消息、策略"]
    T2 --> T3
    T2 --> T4["DEV-04 工作流、状态机、调度"]
    T3 --> T4
    T1 --> T5["DEV-05 模型适配与成本"]
    T2 --> T5
    T3 --> T5
    T2 --> T6["DEV-06 真实调研"]
    T3 --> T6
    T5 --> T6
    T2 --> T7["DEV-07 BIMA Agent"]
    T4 --> T7
    T5 --> T7
    T2 --> T8["DEV-08 Review、测试、缺陷、NPI"]
    T4 --> T8
    T7 --> T8
    T3 --> T9["DEV-09 Boss 控制台"]
    T4 --> T9
    T5 --> T9
    T8 --> T9
    T1 --> T10["DEV-10 Office、观测、评分、备份、全链路验收"]
    T2 --> T10
    T4 --> T10
    T5 --> T10
    T6 --> T10
    T7 --> T10
    T8 --> T10
    T9 --> T10
    T1 --> T11["DEV-11 Electron 桌面应用与跨平台打包"]
    T2 --> T11
    T4 --> T11
    T7 --> T11
    T9 --> T11
    T11 --> T10
~~~

## 跨任务统一契约

### 统一事实来源

- 领域状态以后端状态机为准。
- 业务事实以领域对象、事件、执行记录和产物为准。
- 前端页面和像素办公室只能读取投影或查询接口，不能建立第二套状态机。
- 评分卡只能读取结构化证据，不能根据前端显示内容自行计算。
- 归档和备份必须保留事件、产物、TraceLink、审计和版本信息。

### 统一追溯字段

任务之间传递的关键数据尽量统一包含：

- project_id
- task_id
- worker_id 或 agent_run_id
- execution_id
- event_id
- trace_id
- artifact_id
- trace_link_id
- created_at/occurred_at
- schema_version 或 rule_version

缺少必要追溯字段的接口，不得作为最终交付接口冻结。

### 统一安全边界

- 密钥只进入 OS Keychain 或等价的安全存储。
- 普通日志、前端接口和备份包不能出现明文凭据。
- Coding Agent 只能在授权 workspace、允许工具和允许命令范围内执行。
- 所有关键操作需要记录审计事件。
- 归档项目默认只读，恢复需要显式的运维流程和一致性校验。

### 统一接口要求

- API 使用稳定版本前缀，例如 /api/v1。
- 写操作需要幂等键或等价的重复提交保护。
- 列表接口必须分页。
- 异步执行必须返回可查询的 execution_id 或 task_id。
- 实时页面使用 SSE 或等价的事件订阅，并支持断线重连或快照补齐。
- 错误响应必须包含稳定错误码、可读原因和可定位的 request_id/trace_id。

## 需求与验收追踪

每个独立任务文件必须同时说明：

1. 具体交付物。
2. 接口和数据设计。
3. 与 PRD、需求矩阵、工程概要设计和 BIMA 概要设计的对应关系。
4. 可执行的验收标准和验收方法。
5. 开发步骤、依赖、测试层级和完成定义。

需求追踪的分布原则：

- PRD AC-01～AC-11：主要由 DEV-01～DEV-05、DEV-09 覆盖。
- PRD AC-12～AC-18：主要由 DEV-04、DEV-07～DEV-10 覆盖。
- PRD AC-19～AC-24：主要由 DEV-02、DEV-07、DEV-08、DEV-10 覆盖。
- PRD AC-25～AC-26：贯穿 DEV-01～DEV-10，最终由 DEV-10 统一验收。
- PRD AC-27：由 DEV-01 提供运行时基础，DEV-11 负责桌面交付，DEV-10 负责最终发布验收。
- 需求矩阵 SR-*：在对应任务文件的“上游依据与设计一致性”章节中逐项说明。
- 工程概要设计 AS-01～AS-18：在对应任务文件中说明实现责任，DEV-10 汇总端到端证据；AS-18 的桌面实现责任由 DEV-11 承担。

需求矩阵中的数据存储、备份和恢复属于补充数据基线，不占用 PRD 的 AC 编号；具体落实见 DEV-01、DEV-02、DEV-10。

## 发布前总检查

在宣布 V1 完成前，必须完成：

- [ ] 十一个任务文件均已完成并由责任人签字或记录审查结论。
- [ ] PRD AC-01～AC-27 均有实现位置和验收证据。
- [ ] 需求矩阵 SR-* 无未解释的缺口。
- [ ] 工程概要设计 AS-01～AS-18 均有任务归属和验证结果；AS-18 的桌面证据由 DEV-11/DEV-10 归档。
- [ ] 关键状态名、事件名、接口语义和权限边界没有文档冲突。
- [ ] 真实调研、Coding Agent、Review、测试和 NPI 均能在同一项目中串联。
- [ ] 像素办公室和执行控制台显示真实数据，不使用不可追溯的演示数据。
- [ ] 评分卡的硬性门槛、证据索引和历史版本可复核。
- [ ] 备份包通过脱敏、完整性、恢复和一致性验证。
- [ ] AS-01～AS-18 均有实际执行记录、结果和证据位置。
- [ ] 安全阻塞问题、数据损坏问题和不可恢复问题为零。

## 维护规则

- 修改单个任务的实施内容时，优先修改对应的 taskN.md。
- 修改任务依赖、跨任务字段、版本引用或发布门槛时，同时更新本索引。
- 新增接口或状态时，必须在所属任务文件中补充请求/响应、来源、权限、幂等和验收。
- 删除或合并任务时，需要同步修改任务编号、依赖图、需求追踪和发布检查。
- DEV-11 的桌面安装、sidecar、升级和跨平台验收必须与 Task 1 的运行时验收分开记录；Task 1 通过不代表桌面安装包已完成。
- 本目录不再保留已完成的一次性一致性审查文件；审查结论和修复后的口径以上游文档及本目录任务文件为准。
