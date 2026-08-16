# Task 8 验收与 Review 证据

## 1. 交付范围

- 任务：DEV-08，开发 Review、测试执行、缺陷流转与 NPI 回归。
- 本地分支：`dev_task8`。
- 分支基线：从当时最新本地 `master` 创建；未 push 到 GitHub，未合并回 `master`。
- 完成提交：`55ac831`（`feat(task8): implement quality flow`）。
- Schema revision：`0010_task8_quality_flow`。

说明：`task8.md` 中的通用示例使用 `dev/task-8`，本次按用户明确指定的本地分支名 `dev_task8` 执行；未进行远端写入。

## 2. 实现与设计对照

| 需求范围 | 实现位置 | 关键保证 |
| --- | --- | --- |
| 需求拆解与任务规格 | `backend/src/application/quality-flow.ts`、`backend/src/domain/quality/index.ts` | 仅已批准 PRD 可拆解；至少 3 个任务、3 个专业标签；每个任务保存负责人、依赖、交付物、验收关联、工作区边界和 VerificationProfile。 |
| Handoff 与 Review | `backend/src/api/coding.ts`、`backend/src/application/quality-flow.ts` | 复用 Task 7 Harness；Review 前检查 diff、变更文件、验证运行、命令、trace、验收标准、风险/失败字段和回滚快照；只允许开发代表；支持 approved/changes_requested/blocked。 |
| 测试策略、用例和执行 | `backend/src/api/quality.ts`、`backend/src/infra/repositories/quality.ts` | 测试策略先于用例；所有拆解任务必须有 approved Review；用例覆盖已批准验收标准；TestRun 保存基线、命令、环境、时间、退出码、实际结果、执行角色和证据引用。 |
| 缺陷、NPI、修复和回归 | `backend/src/application/quality-flow.ts` | failed TestRun 同事务自动建 Defect；NPI 只能分析和提交修复；修复进入 awaiting_regression；只有测试角色提交带证据的 passed 回归才能关闭缺陷。 |
| 追踪和项目隔离 | `backend/src/infra/schema.ts`、`backend/src/infra/repositories/trace.ts` | 增加质量表的项目索引、复合外键父键和 TraceLink trigger；验收标准→任务→用例→TestRun→Defect→NPI/Fix/Regression 全链路落库。 |
| 持久化迁移 | `backend/src/infra/migrations/0010-quality-flow.ts`、`backend/src/infra/database.ts` | 支持空库、历史 `0009_task7_coding` 到 `0010` 的备份迁移，并在启动时验证表、字段、索引和 trigger。 |

## 3. 验收标准映射

| 验收项 | 证据 |
| --- | --- |
| T8-AC-01 | 集成测试通过：API 需求拆解生成 3 个不同专业任务，并持久化质量规格。 |
| T8-AC-02 | 集成测试验证缺少 Handoff 代码/自测字段时抛出证据不完整错误，任务不被 Review 流转。 |
| T8-AC-03 | 完整 Handoff 由开发代表 Review；approved 记录生成质量 Review 基线。 |
| T8-AC-04 | 集成测试验证一个任务进入返工，第三个任务保持 `待处理`，未重置其他任务。 |
| T8-AC-05 | 测试策略必须先创建；测试用例覆盖策略中的全部验收标准并记录测试类型、负责人。 |
| T8-AC-06 | 未 approved 的 Review 被 `runTest` 拒绝；跨任务 Review 基线也被拒绝。 |
| T8-AC-07 | 通过/失败 TestRun 均保存命令、环境、起止时间、退出码、实际结果、证据引用、角色和 trace。 |
| T8-AC-08 | failed TestRun 同事务自动生成 P1 Defect，并通过 TraceLink 关联来源 TestRun。 |
| T8-AC-09 | NPI 修复只能进入待回归；NPI 角色不能提交回归结果；测试角色带证据通过后才关闭。 |
| T8-AC-10 | 首次回归失败后缺陷回到 `open`，第二次修复和真实回归通过后关闭。 |
| T8-AC-11 | 未关闭 P0/P1 缺陷使测试报告 `releaseAllowed=false`；关闭后才允许放行。 |
| T8-AC-12 | 集成测试检查任务、用例、TestRun、Defect、NPI、Fix、RegressionRequest、RegressionResult 的 TraceLink 目标均存在。 |
| T8-AC-COMMIT | 当前分支为 `dev_task8`，完成提交为 `55ac831`；无远端 push、无 master 合并。 |

## 4. 实际验证记录

在 `backend` 目录执行：

```text
npm run build
通过，TypeScript production build 完成。

npm test
通过：20 个 test files，103 个 tests 全部通过。

npm run db:check
通过：writable=true，revision=0010_task8_quality_flow，code=null。

git diff --check
通过，无空白错误。
```

## 5. Review 结论

本地代码 Review 结果：通过。未发现 P0/P1 偏移或未关闭的 Task 8 功能缺陷。

审查期间发现并修复的实现问题：

1. 旧 `defects` 表缺少 `(project_id,id)` 唯一父键，新增质量表复合外键在项目删除时会触发 SQLite foreign key mismatch；已加入兼容唯一索引和启动完整性检查。
2. 历史 `0009_task7_coding` 数据库原先没有明确的 `0010` 分支；已补充迁移前备份和质量迁移路径。
3. 测试基线曾只验证 Review approved，已增加同项目同任务校验，阻止跨任务基线绕过门禁。
4. 历史失败 TestRun 不能永久阻断已完成回归的放行；报告改按每个用例的最新 TestRun 判断当前结果，同时保留全部历史失败统计。
5. 质量对象追踪链已纳入 TraceLink trigger 和项目范围校验，并覆盖 Review、NPI、Fix、RegressionRequest、RegressionResult。

工作区在验收证据提交后应保持 clean；本分支只保存在本地，等待后续人工决定是否合并。
