# Digital Harness

Digital Harness 是一个本地运行的 AI 数字研发 Harness 工程，目标是把项目立项、任务编排、Agent 执行、验证、Review、证据记录和恢复流程组织成可追踪的本地研发闭环。

## Repository layout

- `backend/`：本地控制面和运行时基础设施
- `frontend/`：React/Vite 前端控制台
- `docs/`：PRD、需求矩阵、概要设计、详细设计和任务拆分
- `backend/tests/`：TypeScript 后端单元测试、集成测试和迁移生命周期测试

## Current implementation baseline

- 运行时统一采用 Node.js 22 + TypeScript + Fastify。
- SQLite 由 `better-sqlite3` 负责连接，Drizzle ORM 负责 TypeScript 数据访问边界；迁移日志使用 `drizzle_migrations`。
- 当前持久化 Schema 基线为 `0003_task2_integrity_trace_fix`，支持从 `0001_runtime_skeleton` 和 `0002_task2_domain_foundation` 按批准路径升级。
- 后端源码位于 `backend/src/`，构建产物输出到 `backend/dist/`，运行时实现统一为 TypeScript。
- Artifact Store、Outbox、幂等、TraceLink、持久化根目录、Keychain 适配器和 readiness/SSE 控制面已经迁移为 TypeScript。

## Development commands

```bash
cd backend
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

前端仍使用既有的 React/Vite/TypeScript 工程：

```bash
cd frontend
npm test -- --run
npm run build
```

## Project identity

仓库名称为 **Digital Harness**。设计文档中的“本地数字研发公司”是产品领域概念，不代表仓库名称。
