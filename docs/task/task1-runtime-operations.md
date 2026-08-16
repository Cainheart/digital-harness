# Task 1：本地运行、升级和故障处理说明

本文档是 Task 1 的本地运行补充说明，适用于当前 Node.js/TypeScript sidecar 实现。

## 1. 依赖和启动

要求：

- Node.js 22 LTS 或兼容的现代 Node.js 运行时；
- npm；
- macOS 使用系统 Keychain 时需要 `security` 命令；
- 需要真实隔离执行时安装并启动 Docker Engine 或 Docker Desktop；
- 需要公开资料调研时配置可执行的 Chromium/Chrome 浏览器。

启动后端：

```bash
cd backend
npm install
npm run typecheck
npm test -- --run
npm run build
npm run dev
```

后端默认只监听 `127.0.0.1:8765`。启动准备检查：

```bash
cd backend
npm run db:check
```

## 2. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DIGITAL_HARNESS_PERSISTENT_ROOT` | 当前工作目录 | 持久化根目录；生产环境应显式配置到用户数据目录 |
| `DIGITAL_HARNESS_HOST` | `127.0.0.1` | 只允许回环地址，配置其他地址会被拒绝 |
| `DIGITAL_HARNESS_PORT` | `8765` | Fastify sidecar 端口 |
| `DIGITAL_HARNESS_APP_VERSION` | `0.1.0` | 写入 manifest 的应用版本 |
| `DIGITAL_HARNESS_CURRENT_SCHEMA_REVISION` | 当前支持版本 | 当前为 `0004_task3_organization_policy` |
| `DIGITAL_HARNESS_MODEL_PROVIDER` | `unconfigured` | readiness 展示用的模型提供商 |
| `DIGITAL_HARNESS_MODEL_NAME` | `unconfigured` | readiness 展示用的模型名称 |
| `DIGITAL_HARNESS_MODEL_SECRET_REF` | `keychain://unconfigured` | OS Keychain 引用，不是 API Key 明文 |
| `DIGITAL_HARNESS_ALLOW_REAL_EXECUTION` | `false` | 未显式开启时 StartupGate 永远阻断真实执行 |

应用不会把 API Key 明文写入 SQLite、manifest、DomainEvent、Outbox、SSE 或日志。SQLite 只保存 provider、model、secretRef、配置版本和连接状态。

## 3. 持久化目录

```text
<persistent-root>/
├── company.db
├── company.db-wal
├── company.db-shm
├── artifacts/
├── traces/
├── workspaces/
├── backups/
└── manifest.json
```

`company.db` 使用 SQLite WAL。持久化根目录、数据库文件、WAL/SHM 文件和数据子目录都会进行符号链接及特殊文件检查。

迁移前备份中的 SQLite 文件必须与迁移前原文件逐字节一致；敏感信息保护依赖数据库只保存 `secretRef` 的契约，不能通过把 SQLite 二进制转换为 UTF-8 文本的方式脱敏。

## 4. Readiness 和启动门禁

```http
GET /api/v1/readiness
```

每次请求都会重新检查：

- model：模型凭据引用是否可用；
- research：本地浏览器适配器是否可用；
- workspace：工作区是否存在且可读写；
- docker：Docker Engine/API、非 root、挂载、资源和网络策略能力；
- persistence：Schema revision、SQLite WAL 和结构完整性。

只要任一检查为 `blocked`，总体状态就是 `blocked`，`allowedActions` 为空。真实执行还必须同时满足：

- readiness 为 `ready`；
- `DIGITAL_HARNESS_ALLOW_REAL_EXECUTION=true`；
- 调用方提供明确的 `projectId`。

readiness 本身不启动模型、浏览器、Docker 容器、测试命令或工作区写入。

## 5. Schema 升级和阻断

当前支持版本：

```text
0004_task3_organization_policy
```

升级路径：

```text
0001_runtime_skeleton
  → 0002_task2_domain_foundation
  → 0003_task2_integrity_trace_fix
  → 0004_task3_organization_policy
```

如果发现未知版本、缺失表、缺失索引、缺失 immutable trigger 或缺失完整性字段，应用保持只读阻断，不覆盖业务数据，并返回 `VERSION_CONFLICT` 或 `SCHEMA_INTEGRITY_CONFLICT`。

## 6. 常见故障处理

| 故障 | 状态 | 处理方式 |
| --- | --- | --- |
| 模型凭据不可用 | `blocked` | 检查 OS Keychain 引用并重新绑定凭据 |
| 浏览器不可用 | `blocked` | 安装支持的 Chrome/Chromium 并重新检查 readiness |
| Docker 不可用 | `blocked` | 启动 Docker Engine/Desktop，检查工作区文件共享和资源限制 |
| 工作区不可读写 | `blocked` | 检查路径、权限和特殊文件 |
| Schema 版本未知 | `blocked` | 先备份持久化根目录，再沿批准 migration 路径升级 |
| SQLite WAL/结构损坏 | `blocked` | 保留原文件，检查锁、磁盘和完整 Schema 后恢复 |
| Artifact SHA-256 不一致 | `invalid` | 不继续使用该版本，保留完整性失败状态并重新生成证据版本 |
| 非本机请求 | HTTP 403 | 从运行 sidecar 的本机访问；拒绝事件会写入脱敏安全审计 |

任何 readiness 阻断都不会自动把项目改成运行中，也不会创建新的执行尝试。

## 7. 验证命令

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
