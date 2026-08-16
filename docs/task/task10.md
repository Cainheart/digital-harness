# Task 10：像素办公室、真实执行观测、评分卡、备份恢复与 V1 全链路验收

## 任务元数据

- 任务编号：DEV-10
- 任务名称：交付像素办公室、真实执行控制台、评分卡、备份恢复与 V1 全链路验收
- 对应产品域：像素办公室（Pixel Office）、真实执行观测（Execution Console）、项目评分卡（Scorecard）、数据运维与发布验收
- 前置任务：DEV-01、DEV-02、DEV-04、DEV-05、DEV-06、DEV-07、DEV-08、DEV-09、DEV-11
- 主要协作方：前端、后端、BIMA Agent、Review/Test、数据与安全、发布负责人
- 交付性质：面向用户的可视化与运维能力，以及覆盖 AS-01～AS-18 的最终集成验收
- 完成标志：像素办公室可以反映真实系统状态，执行控制台可以查看真实执行证据，评分卡可以基于证据计算，备份恢复可验证，全链路验收达到发布门槛
- 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

本任务负责把前面任务已经实现的项目、角色、工作流、模型、调研、编码 Agent、Review、测试和归档能力，汇聚成一个可以被业务用户观察、操作和验收的完整产品闭环。

本任务不是单独制作一个静态动画页面，也不是用演示数据伪装执行过程。必须实现以下原则：

1. 像素办公室只呈现真实后端状态的投影，不能成为第二套状态机。
2. 真实执行控制台必须能追溯到项目、任务、Agent、模型、事件、日志、产物、测试与 Review 证据。
3. 评分卡必须从结构化证据计算，不能只依靠人工填写或前端固定分数。
4. 备份与恢复必须覆盖业务数据、事件、产物、执行证据和必要的系统元数据，但不得导出明文凭据。
5. V1 最终验收必须以 PRD、需求矩阵、工程概要设计、BIMA Agent 详细设计和 Electron 桌面应用详细设计中已定义的验收标准为依据，而不是以页面“看起来完成”为依据。

## 2. 上游依据与设计一致性

### 2.1 PRD 对齐

本任务直接落实以下 PRD 内容：

- PRD §7.3：像素办公室需要呈现项目、员工、任务、工作状态和实时动态。
- PRD §7.4：必须提供真实执行控制台，展示模型调用、Token、耗时、工具、命令、测试、错误和重试等真实过程。
- PRD §9：项目结果必须可追溯、可复盘、可评分，并展示完成度、质量和成本。
- PRD §10：V1 必须能够从项目创建、任务拆分、调研、编码、Review、测试到归档形成闭环。
- AC-12：项目与阶段状态可见。
- AC-13：项目工作流闭环可观察。
- AC-14：像素办公室反映真实系统状态。
- AC-15：能够查看真实执行轨迹。
- AC-16：能够查看模型、Token、耗时、工具调用和错误重试等执行信息。
- AC-19：版本归档后可追溯和复盘。
- AC-20：项目资料可归档和恢复。
- AC-21：权限和敏感信息不能因可视化而泄露。
- AC-22：编码任务能够形成结果、测试和 Review 证据。
- AC-23：关键数据具备备份、恢复和完整性校验能力。
- AC-24：项目评分能够由证据支撑。
- AC-25：系统具备安全边界和审计能力。
- AC-26：Coding Agent 只能在授权范围和受控环境中执行。

### 2.2 需求矩阵对齐

本任务覆盖或汇总验收以下需求：

- SR-PXO-001～SR-PXO-007：像素办公室的布局、角色、状态、任务、导航和实时更新。
- SR-OBS-001～SR-OBS-006：真实执行过程、事件、模型、Token、耗时、工具、错误、重试和证据链。
- SR-EVL-001～SR-EVL-010：评分卡、评分维度、硬性门槛、证据来源和不可伪造要求。
- SR-DAT-001～SR-DAT-007：SQLite、事件、产物、证据、备份、恢复和数据完整性。
- SR-NFR-001～SR-NFR-009：可用性、性能、并发、可观测性、审计、可恢复性和可维护性。
- SR-SEC-001～SR-SEC-012：凭据隔离、日志脱敏、权限、受控执行、审计和敏感信息保护。
- SR-ARC-004～SR-ARC-007：归档、恢复、版本追溯、归档后只读和审计。
- AS-01～AS-18：V1 端到端验收样例；AS-18 的桌面安装、Electron/sidecar 和升级证据由 DEV-11 提供，本任务负责最终发布门禁汇总。

### 2.3 概要设计对齐

- 工程概要设计 AS-01：所有关键行为必须能从业务请求追踪到事件、执行记录、产物和验收结果。
- 工程概要设计 AS-07：项目工作流必须通过状态机和事件流驱动，前端不得自行推断业务真相。
- 工程概要设计 AS-08：BIMA Agent 的执行过程必须可观测、可暂停、可恢复、可诊断。
- 工程概要设计 AS-09：Review、测试、拒绝、返工和 NPI 形成闭环。
- 工程概要设计 AS-10：归档和恢复必须保留版本、产物、事件和审计信息。
- 工程概要设计 AS-11：数据模型需要支持执行成本、Token、耗时、工具调用和错误追踪。
- 工程概要设计 AS-12：敏感数据和凭据不能进入普通日志、产物包或前端展示。
- 工程概要设计 AS-13：系统需要具备备份恢复和发布前验证能力。
- 工程概要设计 AS-14：前端、后端、Agent、调研、Review 和测试组件通过稳定接口协作。
- 工程概要设计 AS-15：像素办公室是状态可视化层，不拥有领域状态。
- 工程概要设计 AS-16：评估结果必须能够回指到事实证据。
- 工程概要设计 AS-17：最终交付需要通过功能、安全、恢复和全链路验收。

相关概要设计和专项详细设计中，与本任务直接相关的内容包括：

- 工程概要设计 A4：前端业务控制台、像素办公室与后端 API/SSE 的关系。
- 工程概要设计 A5：执行轨迹、产物、事件和审计的可追溯链。
- 工程概要设计 B4：事件驱动的状态投影和前端实时更新。
- 工程概要设计 E2：运行数据、事件、产物、备份与恢复。
- 工程概要设计 E4：安全边界、日志脱敏和凭据保护。
- 工程概要设计 E5：测试、发布和全链路验收。
- BIMA Agent 概要设计 §13：执行观测与证据链。
- BIMA Agent 概要设计 §17：受控执行、归档、审计和交付证据。
- Electron 桌面应用详细设计 §3～§9：桌面启动、sidecar、IPC、Docker 降级、升级和跨平台验收。

## 3. 具体交付物

### 3.1 像素办公室前端

建议目录：

    frontend/src/features/office/
    frontend/src/features/office/OfficeView.tsx
    frontend/src/features/office/officeProjection.ts
    frontend/src/features/office/officeTypes.ts
    frontend/src/features/office/officeEvents.ts
    frontend/src/features/office/office.css

交付内容：

1. 像素办公室主视图：
   - Boss 区域。
   - 角色或 Agent 工位区域。
   - 调研区、开发区、Review 区、测试区和归档区。
   - 项目或任务的当前阶段标识。
   - 工作中、等待输入、等待审批、Review 中、测试中、阻塞、已完成、已取消等状态。
2. 状态映射规则：
   - 后端领域状态映射到有限的前端展示状态。
   - 每个展示状态必须有文字、图标、颜色和可访问性标签。
   - 不允许用动画帧、客户端定时器或随机状态替代真实事件。
3. 角色与任务交互：
   - 点击角色进入角色详情或其关联任务列表。
   - 点击任务进入任务详情或真实执行控制台。
   - 点击项目进入项目仪表盘。
   - 点击阻塞、审批或错误状态，进入对应处理入口。
4. 实时更新：
   - 通过 SSE 或等价的服务端推送机制订阅项目事件。
   - 断线后重新连接。
   - 重连后通过最后事件 ID 或重新拉取快照补齐数据。
   - 事件乱序、重复和延迟不能导致前端出现不可解释的状态。
5. 降级体验：
   - 无实时连接时显示“实时连接已断开”，但仍然可以查看最近一次快照。
   - 没有配置像素素材时使用可替换的默认备用资源。
   - 页面加载失败时显示错误原因、刷新入口和项目上下文。

### 3.2 真实执行控制台

建议目录：

    frontend/src/features/execution-console/
    frontend/src/features/execution-console/ExecutionConsole.tsx
    frontend/src/features/execution-console/executionTypes.ts
    frontend/src/features/execution-console/executionTimeline.ts
    frontend/src/features/execution-console/executionRedaction.ts
    backend/app/api/executions.py
    backend/app/application/execution_query.py

控制台至少需要展示以下事实字段：

| 类别 | 必须展示的内容 | 数据来源 |
|---|---|---|
| 业务上下文 | 项目、任务、角色、Agent Run、执行目的 | 任务和执行记录 |
| 模型调用 | Provider、模型、请求时间、响应时间、耗时、调用状态 | ModelAdapter/调用账本 |
| Token 与成本 | 输入 Token、输出 Token、总 Token、估算成本、计费币种 | 使用量账本 |
| 工具调用 | 工具名称、调用参数摘要、返回摘要、耗时、状态 | Tool/Action 事件 |
| 命令执行 | 命令摘要、工作目录、退出码、耗时、输出摘要 | Sandbox/Workspace 事件 |
| 测试验证 | 测试命令、测试套件、通过数、失败数、验证结论 | Verification 记录 |
| 错误和重试 | 错误类型、错误摘要、重试次数、退避、最终结论 | Error/Retry 事件 |
| 产物与证据 | Patch、日志、测试报告、Review 结果、归档包 | ArtifactStore/TraceLink |
| 时间线 | 事件顺序、事件 ID、Trace ID、发生时间、来源组件 | EventStore |

控制台必须区分：

- 事件摘要：用于快速浏览。
- 完整证据：需要权限后查看。
- 敏感字段：只显示已脱敏摘要，不允许前端绕过接口获取原文。
- 执行状态：以后端状态和事件为准，不用前端轮询猜测。

### 3.3 项目评分卡

建议目录：

    frontend/src/features/scorecard/
    frontend/src/features/scorecard/ScorecardView.tsx
    frontend/src/features/scorecard/scorecardTypes.ts
    backend/app/application/scorecard.py
    backend/app/api/scorecard.py

评分卡需要至少包含七个维度：

1. 需求覆盖度。
2. 调研质量和来源独立性。
3. 设计与实现一致性。
4. 测试通过率和验证充分性。
5. Review 质量和缺陷闭环。
6. 执行成本与资源效率。
7. 可追溯性、安全性和归档完整度。

评分卡还需要单独展示硬性门槛。以下任意一项不满足，不能只用平均分掩盖：

1. 关键需求没有覆盖证据。
2. 关键来源不足或来源独立性不满足。
3. 设计、实现和测试之间缺少 TraceLink。
4. 存在未关闭的阻塞性缺陷。
5. 关键测试失败或没有可复现的测试报告。
6. 敏感信息进入日志、产物或导出包。
7. Coding Agent 超出授权范围执行。
8. 关键执行记录、事件或产物不可追溯。
9. 备份或恢复校验失败。

评分卡每一项必须返回：

- 维度编号。
- 分数或状态。
- 计算规则版本。
- 证据 ID 列表。
- 未通过原因。
- 修复建议。
- 计算时间。
- 计算所依据的数据版本或归档版本。

### 3.4 数据备份与恢复

建议目录：

    backend/app/ops/backup.py
    backend/app/ops/restore.py
    backend/app/application/archive.py
    backend/tests/ops/test_backup_restore.py
    scripts/backup-create
    scripts/backup-verify
    scripts/restore-validate

备份包至少覆盖五类内容：

1. 项目、任务、角色、权限、配置和工作流状态。
2. 事件、审计记录、执行记录、Token/成本账本和错误重试记录。
3. 研究来源、事实、调研结论、设计文档、Patch、测试报告、Review 结果和归档元数据。
4. 事件与产物之间的 TraceLink、需求与测试之间的覆盖关系。
5. 数据库 schema 版本、迁移版本、应用版本、备份时间、环境标识和校验清单。

备份包不得包含：

- API Key、模型密钥、数据库密码、OS Keychain 原文。
- 未经脱敏的授权 Header、Cookie、Token 或私有连接串。
- 与当前项目无关的用户目录、宿主机完整文件系统或未授权工作区。

备份包需要有 manifest 和完整性校验。建议 manifest 字段：

    backup_id
    created_at
    application_version
    schema_version
    project_ids
    artifact_count
    event_count
    trace_link_count
    file_checksums
    redaction_policy_version
    source_environment

恢复时必须：

1. 先校验 manifest、文件数量和 SHA-256。
2. 在临时目标环境执行 schema 兼容性检查。
3. 以事务方式恢复 SQLite 数据和事件。
4. 恢复产物、测试报告、Review 记录和 TraceLink。
5. 不恢复凭据原文，只建立待重新绑定 Keychain 的引用。
6. 恢复后执行一致性检查：
   - 外键完整。
   - 事件序列没有断裂。
   - 产物引用存在。
   - TraceLink 两端存在。
   - 归档状态与评分卡快照一致。
7. 生成恢复报告，记录成功项、跳过项、失败项和需要人工处理的项。

### 3.5 V1 全链路验收资产

需要交付：

- AS-01～AS-18 端到端验收用例。
- 每个用例的前置数据、操作步骤、期望结果、证据位置和实际结果。
- 功能测试、接口测试、集成测试、权限测试、安全测试、恢复测试和性能基线。
- 至少一个完整示例项目的可复现演练数据。
- 发布前阻塞问题清单和处理结论。
- V1 验收报告和发布建议。

## 4. 接口设计

### 4.1 像素办公室投影接口

建议实现：

    GET /api/v1/projects/{project_id}/office

返回最近一次完整快照：

    {
      "project_id": "project-001",
      "snapshot_version": 42,
      "generated_at": "2026-08-12T10:00:00Z",
      "project_status": "EXECUTING",
      "rooms": [
        {
          "room_id": "coding",
          "label": "开发区",
          "status": "ACTIVE",
          "occupants": [
            {
              "worker_id": "worker-bima-01",
              "role": "CODING_AGENT",
              "display_name": "Coding Agent",
              "status": "VERIFYING",
              "task_id": "task-001",
              "current_activity": "运行测试",
              "last_event_id": "evt-0099",
              "updated_at": "2026-08-12T09:59:58Z"
            }
          ]
        }
      ],
      "active_tasks": 3,
      "blocked_tasks": 0,
      "pending_approvals": 1
    }

建议实现：

    GET /api/v1/projects/{project_id}/office/events

要求：

- 使用 SSE 或项目已有的等价事件推送机制。
- 支持 Last-Event-ID。
- 每条事件带 event_id、project_id、entity_type、entity_id、event_type、occurred_at 和 projection_version。
- 服务器重启或连接断开后，前端可以用快照加事件补齐。
- 推送的数据只能是当前用户有权访问的项目和字段。

事件示例：

    {
      "event_id": "evt-0100",
      "project_id": "project-001",
      "entity_type": "TASK",
      "entity_id": "task-001",
      "event_type": "TASK_STATUS_CHANGED",
      "payload": {
        "from": "IMPLEMENTING",
        "to": "VERIFYING"
      },
      "occurred_at": "2026-08-12T10:00:01Z",
      "projection_version": 43
    }

### 4.2 执行查询接口

建议实现：

    GET /api/v1/executions
    GET /api/v1/executions/{execution_id}
    GET /api/v1/executions/{execution_id}/timeline
    GET /api/v1/executions/{execution_id}/artifacts

查询参数建议：

- project_id。
- task_id。
- worker_id。
- status。
- from、to。
- trace_id。
- page、page_size。
- sort。

单次执行详情需要至少返回：

    {
      "execution_id": "run-001",
      "project_id": "project-001",
      "task_id": "task-001",
      "worker_id": "worker-bima-01",
      "status": "COMPLETED",
      "trace_id": "trace-001",
      "started_at": "2026-08-12T09:50:00Z",
      "finished_at": "2026-08-12T09:59:58Z",
      "duration_ms": 598000,
      "model_usage": {
        "provider": "openai",
        "model": "configured-model",
        "input_tokens": 1200,
        "output_tokens": 840,
        "total_tokens": 2040,
        "estimated_cost": 0.12,
        "currency": "USD"
      },
      "tool_calls": 8,
      "commands": 5,
      "tests": {
        "total": 24,
        "passed": 24,
        "failed": 0
      },
      "errors": [],
      "retry_count": 1,
      "artifact_ids": ["artifact-patch-001", "artifact-report-001"],
      "trace_link_ids": ["trace-link-001"]
    }

接口约束：

- 列表接口返回摘要，详情接口返回完整证据索引。
- 日志和工具参数默认返回脱敏摘要；需要更高权限时仍然受字段级策略限制。
- 同一执行记录的所有事件必须能够按 trace_id、execution_id 和 event_id 互相定位。
- 查询接口必须使用分页，不能将整个项目的执行日志一次性返回。
- 不能将模型密钥、授权头、完整环境变量和宿主机绝对路径暴露到前端。

### 4.3 评分卡接口

建议实现：

    GET /api/v1/projects/{project_id}/scorecard
    POST /api/v1/projects/{project_id}/scorecard/recalculate
    GET /api/v1/projects/{project_id}/scorecard/evidence

评分卡响应建议：

    {
      "project_id": "project-001",
      "scorecard_version": "v1",
      "calculated_at": "2026-08-12T10:10:00Z",
      "overall_score": 86,
      "release_status": "BLOCKED",
      "dimensions": [
        {
          "dimension_id": "traceability",
          "score": 92,
          "status": "PASS",
          "rule_version": "score-rule-v1",
          "evidence_ids": ["trace-link-001", "test-report-001"],
          "issues": []
        }
      ],
      "hard_gates": [
        {
          "gate_id": "security-no-secret-leak",
          "status": "PASS",
          "evidence_ids": ["security-scan-001"]
        },
        {
          "gate_id": "backup-restore-verified",
          "status": "FAIL",
          "evidence_ids": ["restore-report-001"],
          "reason": "恢复演练尚未完成"
        }
      ],
      "recommendations": [
        "完成恢复演练后重新计算发布门槛"
      ]
    }

规则：

- 只有拥有项目查看权限的用户可以查看评分卡；重新计算需要项目负责人或系统角色权限。
- 评分卡计算结果必须持久化版本，并可回看历史版本。
- 前端不能自行计算总分、改变门槛或删除失败证据。
- 评分卡必须显示“数据不足”而不是将缺失项自动当成通过。

### 4.4 备份恢复运维接口和命令

备份恢复属于运维能力，默认不作为普通业务页面的任意导入导出功能。建议提供受保护的内部接口或命令：

    POST /internal/ops/backups
    GET /internal/ops/backups/{backup_id}
    POST /internal/ops/backups/{backup_id}/verify
    POST /internal/ops/restores/validate
    POST /internal/ops/restores

命令行形式可为：

    backup-create --project project-001 --output backup-001
    backup-verify --input backup-001
    restore-validate --input backup-001 --target staging
    restore-apply --input backup-001 --target staging --change-ticket CHG-001

约束：

- 创建、验证、恢复都要有审计记录。
- 生产恢复必须有显式授权、目标环境确认和变更单或等价审批依据。
- 恢复前先做 dry-run/validate，不能直接覆盖生产数据。
- 所有运维接口默认关闭公网访问，并通过管理员权限、网络边界和审计保护。

### 4.5 数据类型和事件边界

本任务只能消费以下已经由上游任务定义的数据，不得新增一套平行事实：

- DEV-01：运行时、数据库、Keychain 和基础健康状态。
- DEV-02：领域对象、事件、产物和 TraceLink。
- DEV-04：项目和任务状态机。
- DEV-05：模型调用、Token、成本和配置。
- DEV-06：真实调研证据。
- DEV-07：Agent Run、Action、Observation、Patch 和验证结果。
- DEV-08：Review、测试、缺陷和 NPI。
- DEV-09：Boss 业务操作和权限边界。

本任务新增的主要读模型或派生对象：

| 对象 | 作用 | 是否业务真相 |
|---|---|---|
| OfficeProjection | 为像素办公室提供快照和状态投影 | 否，来源于领域状态和事件 |
| ExecutionReadModel | 为执行控制台提供分页查询和时间线 | 否，来源于执行事件和账本 |
| ScorecardSnapshot | 固化某时刻的评分和证据索引 | 是一个可追溯的评估快照，但不替代原始证据 |
| BackupManifest | 描述备份内容、版本和校验清单 | 是运维元数据，不替代业务数据 |
| RestoreReport | 描述恢复结果和差异 | 是恢复操作证据 |

## 5. 开发实施方法

### 5.1 第一步：冻结前置契约和样例数据

在开发 UI 前，先由前后端共同确认：

1. 项目、任务、Agent Run、事件和产物的字段名称。
2. 状态枚举及其可视化映射。
3. 事件 ID、Trace ID、Projection Version 的格式。
4. 执行详情的脱敏规则。
5. 评分卡规则版本和证据 ID 规则。
6. 备份 manifest 和恢复报告格式。

使用固定的示例项目生成契约测试数据，避免前端依赖开发者本地临时数据。

### 5.2 第二步：先实现读模型和接口，再实现像素办公室

实现顺序：

1. 从事件、执行记录和领域表建立查询服务。
2. 实现 office snapshot 和 events 接口。
3. 实现 execution list/detail/timeline/artifacts 接口。
4. 实现 scorecard 计算、快照和证据接口。
5. 实现备份 manifest、校验、恢复 validate 和恢复报告。
6. 最后实现像素办公室和执行控制台页面。

原因是 UI 必须消费真实接口。若先画页面再补接口，容易产生只在演示状态下可用的假数据和重复状态逻辑。

### 5.3 第三步：像素办公室采用投影模型

实现要点：

- OfficeProjection 根据项目状态、任务状态、Agent Run 和最近事件生成。
- 投影必须具备 snapshot_version。
- 事件更新必须幂等。
- 客户端只处理白名单事件和白名单状态。
- 不允许前端直接修改领域状态。
- 动画只表现“当前状态的视觉变化”，不能表示尚未发生的业务行为。
- 角色点击、任务点击和状态点击统一导航到真实项目、任务或执行详情。

建议为每个状态建立可测试的映射表：

| 后端状态 | 办公室展示状态 | 文字 | 允许的用户动作 |
|---|---|---|---|
| IMPLEMENTING | WORKING | 工作中 | 查看执行 |
| VERIFYING | TESTING | 验证中 | 查看测试 |
| WAITING_APPROVAL | WAITING_APPROVAL | 等待审批 | 打开审批 |
| BLOCKED | BLOCKED | 已阻塞 | 查看原因/处理 |
| COMPLETED | DONE | 已完成 | 查看产物 |
| CANCELLED | STOPPED | 已终止 | 查看终止原因 |

### 5.4 第四步：建立真实执行查询和脱敏层

实现一个统一的 ExecutionQueryService：

1. 按 project_id、task_id、execution_id 和 trace_id 查询。
2. 从事件和账本聚合模型调用、Token、成本、工具、命令、测试和错误。
3. 给每类证据生成摘要和权限过滤结果。
4. 通过分页和时间范围保护查询性能。
5. 在返回给前端前执行字段级脱敏。
6. 对缺失字段返回 unknown 或 unavailable，并显示数据缺失原因，不得填入虚构值。

需要覆盖的测试：

- Token 账本与控制台总数一致。
- 重试不重复计算成本。
- 同一事件在时间线中不会重复出现。
- 事件乱序时仍能显示正确的排序和最终状态。
- 敏感参数在列表、详情、错误和导出路径均被脱敏。

### 5.5 第五步：实现评分卡规则引擎

评分卡计算建议拆为：

    EvidenceCollector -> DimensionEvaluators -> HardGateEvaluator
    -> ScorecardSnapshotWriter -> RecommendationBuilder

每个 DimensionEvaluator 只读取明确的事实接口，并返回：

- score。
- status。
- rule_version。
- evidence_ids。
- issues。
- missing_data。

评分卡规则必须可单元测试、可版本化、可重算。升级规则时保留历史评分卡，不能覆盖旧版本结果。

硬性门槛先于总分判断。若硬性门槛失败，release_status 至少为 BLOCKED 或 NEEDS_REMEDIATION，具体状态按上游发布状态机实现。

### 5.6 第六步：实现备份恢复和恢复演练

开发流程：

1. 生成一个包含项目、事件、调研来源、Patch、Review、测试、评分卡和归档信息的完整样例项目。
2. 创建备份包。
3. 执行 manifest、数量、哈希、脱敏和 schema 校验。
4. 在临时环境中执行 validate。
5. 恢复到空环境。
6. 对比恢复前后的项目、事件、产物、TraceLink、评分卡快照和审计记录。
7. 人为构造缺失产物、版本不兼容和损坏文件，确认系统可以失败并给出明确报告。
8. 记录恢复时长和恢复点，作为发布基线。

恢复实现必须优先保证可验证性和可回滚性，不能以“脚本执行结束且没有异常”为成功标准。

### 5.7 第七步：分层测试与全链路演练

测试层级：

1. 单元测试：
   - 状态到办公室展示的映射。
   - 事件去重和重连游标。
   - 脱敏策略。
   - 评分维度和硬性门槛。
   - manifest 和 SHA-256 校验。
2. 接口测试：
   - office snapshot/events。
   - executions list/detail/timeline/artifacts。
   - scorecard。
   - backup/restore internal operations。
3. 集成测试：
   - 任务状态变化后办公室更新。
   - Agent 执行后控制台出现真实时间线。
   - 测试和 Review 结果进入评分卡。
   - 归档后只读、恢复后可查询。
4. 安全测试：
   - 不同角色访问项目、执行和评分卡。
   - 低权限用户无法查看敏感日志。
   - 备份包无凭据。
   - 前端不能构造越权项目 ID 读取数据。
5. 恢复测试：
   - 正常备份恢复。
   - 备份损坏。
   - schema 不兼容。
   - 缺失产物。
   - 重复恢复和幂等。
6. 全链路测试：
   - 从创建项目到归档、评分、备份、恢复和桌面应用启动/升级完整执行 AS-01～AS-18。

## 6. 验收标准与验收方法

### 6.1 功能验收

| 验收编号 | 验收标准 | 验收方法 | 通过条件 |
|---|---|---|---|
| ACC-10-01 | 像素办公室展示真实项目、角色、任务和状态 | 创建项目并驱动任务状态变化，观察 snapshot 和 SSE | 页面状态与后端状态、事件 ID 一致 |
| ACC-10-02 | 像素办公室不产生独立业务真相 | 对比前端展示和领域 API/事件，重连后重新拉取 | 刷新、断线、重连后状态仍一致 |
| ACC-10-03 | 点击角色、任务、项目可进入真实详情 | 分别点击办公室中的角色、任务、项目和阻塞状态 | 路由携带正确 ID，详情与来源一致 |
| ACC-10-04 | 执行控制台展示真实模型、Token、耗时、工具、命令、测试、错误、重试 | 执行一次成功任务和一次失败重试任务 | 所有字段可回溯到执行记录或事件，不出现虚构值 |
| ACC-10-05 | 执行控制台支持完整时间线和产物索引 | 查看一个包含调研、编码、测试、Review 的任务 | 时间线可按 event_id/trace_id 定位，产物可打开或说明不可用原因 |
| ACC-10-06 | 执行数据按权限和字段脱敏 | 使用不同角色访问日志、工具参数和备份 | 越权请求被拒绝，敏感信息始终不出现在响应 |
| ACC-10-07 | 评分卡按规则计算并展示证据 | 运行一个证据完整项目和一个缺证据项目 | 分数、门槛、证据 ID、缺失项和建议符合规则 |
| ACC-10-08 | 硬性门槛不能被总分掩盖 | 人为制造安全失败、测试失败或 TraceLink 缺失 | release_status 为阻塞或待整改，不得显示为可发布 |
| ACC-10-09 | 评分卡可保存、重算和回看历史版本 | 修改项目证据后重新计算 | 新旧版本均保留，规则版本和计算时间明确 |
| ACC-10-10 | 备份覆盖规定数据且不包含凭据 | 创建完整项目备份并扫描备份内容 | 数据项齐全，凭据、Token、Cookie、私钥和完整授权头不存在 |
| ACC-10-11 | 备份完整性可验证 | 修改 manifest、修改文件、删除文件后执行 verify | 校验失败并指出失败项，不把损坏包标记为有效 |
| ACC-10-12 | 恢复后项目可查询、可追溯、可评分 | 恢复到临时环境后查询项目和执行记录 | 项目、事件、产物、TraceLink、评分卡和审计记录一致 |
| ACC-10-13 | 恢复不覆盖凭据，支持重新绑定 Keychain | 恢复到无凭据环境 | 系统提示重新绑定，业务数据可恢复，明文凭据不被写入 |
| ACC-10-14 | 归档后只读且可复盘 | 归档项目后尝试修改，再查看执行和评分证据 | 修改被拒绝，历史数据可查询 |
| ACC-10-15 | 全链路验收样例可复现 | 按 AS-01～AS-18 执行验收脚本和人工步骤 | 每个用例都有实际结果和证据位置，阻塞项已处理或明确不发布 |
| ACC-10-COMMIT | 分支、验收与开发完成提交 | Task 开发、测试和文档完成后检查 `git branch --show-current`、`git log`、提交哈希和工作区状态 | Task 10 在从最新 `master` 创建的 `dev/task-10` 分支上完成；已创建完成提交，提交哈希已写入验收证据；验收和 Review 成功后才合并到 `master`，并记录合并提交哈希 |

### 6.2 AS-01～AS-18 覆盖验收

最终验收必须建立以下映射，而不是只出一份没有证据索引的“通过”结论：

| 样例 | 本任务的验收证据 |
|---|---|
| AS-01 | 项目创建后的办公室快照、项目状态和初始审计事件 |
| AS-02 | 任务拆分后的任务列表、依赖图和办公室任务投影 |
| AS-03 | 角色配置、模型配置和权限审计记录 |
| AS-04 | 真实调研来源、事实、引用和调研执行时间线 |
| AS-05 | 调研来源独立性、官方来源规则和冲突处理证据 |
| AS-06 | Agent 计划、授权范围、Action/Observation 和执行轨迹 |
| AS-07 | Patch、测试命令、测试报告、失败诊断和重试证据 |
| AS-08 | Review 结论、阻塞问题、返工任务和再次验证证据 |
| AS-09 | 缺陷、NPI、回归测试和关闭原因 |
| AS-10 | 项目状态机从初始化到完成或终止的事件时间线 |
| AS-11 | Boss 审批、等待输入、拒绝和重新提交记录 |
| AS-12 | Token、耗时、工具、命令和错误重试账本 |
| AS-13 | 像素办公室实时状态、重连快照和详情跳转 |
| AS-14 | 评分卡维度、硬性门槛和证据 ID |
| AS-15 | 归档包、版本信息、只读行为和复盘查询 |
| AS-16 | 备份 manifest、校验报告、恢复报告和数据对比报告 |
| AS-17 | 安全扫描、权限验证、凭据隔离和发布验收签字 |
| AS-18 | macOS/Windows 安装包、Electron Main/Preload、Node.js/TypeScript sidecar 启停、Docker blocked/恢复、升级保数据、视口和跨平台诊断证据 |

### 6.3 发布阻塞条件

以下任一情况存在，不能将本任务标记为通过：

- 办公室显示的状态与后端事实不一致。
- 执行控制台只显示模拟数据或无法定位原始事件。
- Token、成本、耗时或重试数据无法复核。
- 评分卡缺少证据 ID，或硬性门槛失败仍标记可发布。
- 备份中包含凭据或未经脱敏的敏感数据。
- 恢复后事件、产物、TraceLink 或评分卡无法关联。
- 低权限用户可以读取不属于其范围的项目、执行或日志。
- AS-01～AS-18 任一关键用例无实际证据。
- 存在未关闭的安全阻塞问题、数据损坏问题或不可恢复问题。

## 7. 完成定义与交接

本任务完成时必须交付：

- 开发结束时已在 `dev/task-10` 分支创建一次可识别的 Task 10 完成提交，提交哈希已记录在验收证据中，相关工作区无未提交变更；验收和 Review 成功后才允许合并到 `master`，并记录合并提交哈希。
1. 可运行的像素办公室页面及其状态投影接口。
2. 可分页查询、可追溯、可脱敏的真实执行控制台。
3. 可版本化、可重算、带证据索引的项目评分卡。
4. 可验证、可恢复、不包含凭据的备份包和恢复流程。
5. Office、Execution、Scorecard、Backup/Restore 的接口契约和示例响应。
6. 单元、接口、集成、安全、恢复和全链路测试结果。
7. AS-01～AS-18 验收记录和证据索引。
8. 发布前风险、已知限制、回滚方案和运维手册。

交接给发布负责人前，需要完成一次最终审查：

- 逐项对照 PRD AC-01～AC-27。
- 逐项对照需求矩阵 SR-* 和补充数据基线。
- 逐项对照工程概要设计 AS-01～AS-18；其中 AS-18 的桌面证据来自 DEV-11。
- 逐项对照 BIMA Agent 的执行、观测、恢复和安全要求。
- 确认不存在与上游文档冲突的状态名、接口语义、权限边界和数据口径。
