# Task 1 / Task 2 当前验收证据

> 验证日期：2026-08-16
> 当前分支：`dev/task-3`；本文件记录 Task 1/2 能力在当前 Task 3 分支上的基线与重构回归结果。
> 提交状态：本轮重构完成提交后更新提交哈希；当前不合并到 `master`

## 1. 验证命令

后端：

```bash
cd backend
npm run typecheck
npm test -- --run
npm run build
```

前端：

```bash
cd frontend
npm test -- --run
npm run build
```

静态检查：

```text
源码文件扩展名扫描：无旧后端脚本文件
旧运行时关键词扫描：无匹配
git diff --check：通过
```

## 2. 已验证结果

- 后端 TypeScript 类型检查通过；
- 后端 11 个测试文件、49 个测试通过；
- SQLite WAL、Schema 结构、迁移和迁移前二进制备份通过；
- `0001_runtime_skeleton → 0002_task2_domain_foundation → 0003_task2_integrity_trace_fix` 升级路径通过；
- Fastify readiness 包含 model、research、workspace、docker、persistence 五类检查；
- readiness 阻断时 StartupGate 不产生执行事件；
- Fastify 启动/关闭会写入 ApplicationStarted/ApplicationStopped；
- 非本机请求返回 403 并写入脱敏安全审计；
- Project/Task/Artifact/ArtifactVersion/Approval/Review/TestCase/TestRun/Defect/ExecutionAttempt/ModelCall/ToolCall/Notification 可写入并读取；
- Artifact v1/v2 父版本链、SHA-256 校验、verified/invalid 状态通过；
- DomainEvent 的 attemptId、rejectionReason、redactionReason、eventCategory 可以持久化并恢复；
- EventStore、Outbox、幂等、版本冲突和事务回滚通过；
- TraceLink 正向查询、反向查询、coverage、Artifact 节点和跨项目阻断通过；
- 历史项目删除、Artifact 文件删除和最小删除审计通过。

## 3. 本轮修复记录

- 修复 SQLite 迁移前备份把二进制数据库转换成 UTF-8 导致备份损坏的问题；
- 新增 `0003_task2_integrity_trace_fix` migration；
- 接入 Fastify 应用生命周期启动和关闭事件；
- 要求真实执行必须拥有明确 `projectId`；
- 补充 Artifact 完整性状态并允许只更新该状态，其他 ArtifactVersion 字段保持不可变；
- 修复 Artifact/Notification TraceLink 的领域类型和 SQLite trigger 不一致；
- 补齐 Artifact 最新版本、内容引用、上下游 TraceLink 的读取投影；
- 补齐所有 Task 2 对象的 DomainEvent 项目范围解析；
- 持久化调用事件的 attempt、拒绝原因、脱敏原因和事件分类；
- 增加运行、升级、readiness、Keychain、Docker 和故障处理说明。

## 4. 尚未执行的交付动作

在验收和 Review 结论确认前，暂不执行以下动作：

- 不切换到 `dev/task-1` 或 `dev/task-2`；
- 不合并到 `master`。

Task 1/2 不创建与当前业务分支割裂的独立提交；本轮重构统一在 `dev/task-3` 留痕。
