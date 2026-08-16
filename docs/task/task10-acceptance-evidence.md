# Task 10 验收证据与 Review 记录

## 任务范围

- 任务：DEV-10
- 开发分支：`dev_task10`
- 基线：最新本地 `master`
- 远端状态：未 push；本记录和代码只保存在本地分支
- 依据：`docs/task/task10.md`、需求矩阵、概要设计、BIMA Agent 详细设计、代码开发准则
- 应用 Schema：`0012_task10_observability_ops`

## 交付内容

| 能力 | 实现位置 | 验收要点 |
|---|---|---|
| 像素办公室真实投影 | `backend/src/application/office-projection.ts`、`backend/src/api/office-routes.ts`、`frontend/src/features/office/` | 房间和员工来自组织、任务、Coding 会话和领域事件；状态映射包含文字、图标、颜色和可访问性标签；前端只刷新查询投影。 |
| 办公室实时更新 | `frontend/src/api/sse.ts`、`backend/src/api/events.ts`、`backend/src/api/office-routes.ts` | 通过 SSE、Last-Event-ID/after 游标和重新读取快照补齐；断线时保留最近快照并显示断开状态。 |
| 真实执行控制台 | `backend/src/application/execution-query-service.ts`、`backend/src/api/execution-routes.ts`、`frontend/src/features/executions/` | 查询真实 `execution_attempts`、model/tool calls、Token、成本、命令事件、测试、错误、重试、时间线和产物索引；摘要统一脱敏，不返回 secretRef 和宿主机绝对路径。 |
| 评分卡 | `backend/src/application/scorecard-service.ts`、`backend/src/api/scorecard-routes.ts`、`frontend/src/features/scorecard/` | 七个维度、九条硬门槛、规则版本、证据 ID、缺失数据、整改建议和数据版本均由后端计算；`DATA_INSUFFICIENT` 的总分持久化为 `NULL`。 |
| Schema migration | `backend/src/infra/migrations/0012-observability-ops.ts`、`backend/src/infra/schema.ts` | 新增不可变评分卡快照表、项目/版本索引，并接入 0011 → 0012 的升级路径和 Schema 完整性检查。 |
| 备份与恢复 | `backend/src/ops/backup.ts`、`backend/src/ops/restore.ts`、`scripts/`、`backend/src/cli.ts` | 覆盖 SQLite 快照、artifacts、traces、workspaces；manifest 包含要求字段和 SHA-256；拒绝符号链接、特殊文件、路径穿越、敏感信息和非空恢复目标；恢复只保留 secretRef 重新绑定动作。 |

## 需求与验收追踪

- SR-PXO-001～007：OfficeProjection、办公室房间布局、真实角色/任务导航、状态展示和 SSE 投影刷新。
- SR-OBS-001～006：执行尝试分页、模型调用、Token/成本、工具调用、命令/测试/错误/重试、时间线和产物索引。
- SR-EVL-001～010：七维评分卡、九条硬门槛、证据 ID、规则版本、数据不足状态和后端唯一计算来源。
- SR-DAT-001～007：SQLite Schema 0012、事件与 TraceLink、产物索引、manifest、SHA-256、恢复一致性检查。
- SR-SEC-001～011：本机访问边界、Boss/system 运维 actor、参数校验、日志/响应脱敏、secretRef 不落出、路径安全检查。
- SR-REL-001～005：迁移前备份、只读失败、空目标恢复、changeTicket、重复/覆盖保护和恢复报告。
- AC-12～AC-16、AC-19～AC-26：项目与阶段可见、闭环可追溯、真实执行观测、归档/恢复、评分、安全和授权边界。
- AS-01～AS-17：由本地后端全量测试和 Task 10 专项测试覆盖；AS-18 的 Electron/sidecar 安装升级证据仍由 DEV-11 提供，本任务不伪造桌面验收结果。

## 自动化验证

在项目根目录执行：

```text
cd backend && npm run typecheck
cd backend && npm test
cd frontend && npm run build
git diff --check
```

结果：

- Backend typecheck：通过。
- Backend tests：22 个测试文件、111 个测试全部通过。
- Task 10 专项测试：`backend/tests/integration/task10-observability-ops.test.ts`，4 个测试全部通过。
- Frontend production build：通过；Vite 仅报告既有的大 bundle warning，不影响构建结果。
- Diff whitespace check：通过。

## Review 结论

1. 已搜索并复用既有 `ConsoleQueryService`、`SqliteModelCallRecorder`、EventStore、ArtifactStore、TraceLink、LocalAccess 和统一错误合同；Task 10 新增模块只负责聚合投影、评分和运维边界，不复制旧写入逻辑。
2. 已修正并回归验证四个审查问题：SQLite 真实 Token 字段汇总、评分卡数据不足不能伪造成 0 分、备份项目筛选不能与整库内容不一致、macOS `/var` 路径别名不能导致安全路径误判。
3. 已验证失败边界：非 Boss 不能重算评分卡；备份 manifest、哈希、大小、路径和敏感信息均校验；恢复不会覆盖非空目标；不存在的执行时间线返回稳定 NotFound；跨项目办公室游标不会跳过或读取其他项目事件。
4. 旧的 `/api/v1/executions` 模型调用查询保持兼容；Task 10 执行尝试分页使用 `/api/v1/executions/runs`，详情、时间线和产物使用对应的动态路由，避免破坏 Task 9 既有合同。
5. 没有将 API Key、Cookie、授权 Header、模型密钥、Prompt 原文或内部推理写入新增前端、manifest、测试 fixture 或验收证据。

## 本地提交状态

本文件用于记录完成提交后的本地 commit；提交前不执行 push。最终 commit hash 在本地提交完成后补写。
