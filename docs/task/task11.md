# Task 11：Electron 桌面应用壳层与跨平台打包

> 任务编号：DEV-11
> 任务状态：已设计，待开发
> 任务类型：桌面交付、进程生命周期、跨平台安装、安全边界
> 前置任务：DEV-01；完整业务集成依赖 DEV-02、DEV-04、DEV-07、DEV-09
> 后续消费者：DEV-10 发布验收
> 详细设计：[Electron 桌面应用详细设计](../design/electron-desktop-app-detailed-design-v1.md)
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

将 React/Vite 前端和 Python/FastAPI 控制面交付为 macOS/Windows 可安装桌面应用。用户双击启动后，Electron 负责创建窗口并管理 Python sidecar；sidecar 负责现有业务 API、readiness、持久化和后续 Agent/Worker 接入；Docker 继续作为受控代码、构建和测试执行的本地运行时。

本任务不是重新实现 Task 1 的运行骨架，也不是把前后端强行打包成 Docker 容器。Task 1 提供 readiness、StartupGate、SQLite WAL、Keychain、生命周期和本机访问基础；DEV-11 将这些能力接入桌面进程和安装升级流程。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §4.3：V1 P1 产品交付形态为 macOS/Windows 可安装桌面应用。
- PRD §8.2～§8.4：桌面可用性、本机安全、持久化、升级和恢复。
- PRD AC-27：双击启动、前后端生命周期、Docker 缺失降级、升级保数据和不越过人工关卡。

### 2.2 需求矩阵

- `IF-DESK-001`：桌面应用外部边界。
- `SR-DESK-001～012`：安装、启动、sidecar、目录、凭据、readiness、Docker 降级、升级、恢复、诊断和视口。
- `SR-DAT-001/002/004/006`：数据目录、持久化、Schema 和凭据边界。
- `SR-REL-001/002/005`、`SR-NFR-004/007/009`：重启、恢复、视口和恢复时效。
- `AS-18`：桌面应用交付闭环。

### 2.3 概要设计

- 工程概要设计 §2.5：Electron Main/Preload/Renderer 与 Python sidecar 边界。
- 工程概要设计 §3：桌面系统上下文和运行部署图。
- 工程概要设计 §8：安装目录、持久化根目录、升级、备份和恢复。
- Electron 桌面应用详细设计 §3～§9：进程、IPC、token、Docker、打包、失败和验收。

## 3. 具体交付物

### 3.1 Electron 工程

建议创建：

```text
desktop/
├── package.json
├── tsconfig.json
├── electron-builder.yml
└── src/
    ├── main.ts
    ├── preload.ts
    ├── sidecar-manager.ts
    ├── runtime-token.ts
    ├── app-info.ts
    ├── diagnostics.ts
    └── ipc/
        ├── readiness.ts
        ├── workspace.ts
        └── events.ts
```

### 3.2 sidecar 交付

修改或新增后端启动入口，使 sidecar 支持：

- `--host 127.0.0.1` 与随机端口；
- 从受控启动环境读取一次性 token 和 persistent root；
- `/health` 与 `/api/v1/readiness` 的桌面启动握手；
- token 校验和 sidecar shutdown；
- 应用版本、sidecar 版本和 Schema revision 查询；
- 保持 Task 1 的 SQLite、Keychain、readiness、StartupGate 和生命周期语义。

### 3.3 前端交付

- 生产构建资源由 Electron 加载；
- Renderer 使用 Preload 白名单，不直接使用 Node API；
- readiness、启动失败、Docker blocked、sidecar 异常和升级冲突有可理解界面；
- 后续业务页面继续复用现有 React/Vite 路由和组件边界。

### 3.4 安装包

第一阶段目标：

| 平台 | 目标架构 | 产物 |
| --- | --- | --- |
| macOS | arm64、x64 | `.app`、`.dmg` |
| Windows | x64 | 安装 `.exe`；可选 `.msi` |

Python sidecar 使用 PyInstaller 或等价方案打包；Electron 使用 electron-builder 或等价方案生成安装包。正式发布前补充 macOS notarization、Windows Authenticode 和可验证更新。

## 4. 接口与数据设计

### 4.1 启动上下文

```typescript
type SidecarLaunchContext = {
  executablePath: string;
  host: "127.0.0.1";
  port: number;
  token: string;
  persistentRoot: string;
  appVersion: string;
  schemaRevision: string;
};
```

`token` 只能存在于 Main 与 sidecar 的进程内存/启动环境中，不得进入 Renderer、SQLite、日志、Artifact、Trace 或诊断文件。

### 4.2 Renderer 白名单

```typescript
type DesktopRuntimeBridge = {
  getAppInfo(): Promise<AppInfo>;
  getReadiness(): Promise<ReadinessView>;
  selectWorkspace(): Promise<WorkspaceSelection | null>;
  subscribeEvents(listener: (event: RuntimeEvent) => void): () => void;
};
```

项目、任务、审批和 Agent 操作使用明确的类型化命令，不提供通用 `execute`、任意路径读写或任意 URL 请求 API。

### 4.3 数据目录

安装目录只保存应用资源；业务数据默认位于：

```text
macOS: ~/Library/Application Support/DigitalCompany/
Windows: %APPDATA%\\DigitalCompany\\
```

目录结构继续遵循 Task 1 的 `company.db`、`artifacts/`、`traces/`、`workspaces/`、`backups/` 和 `manifest.json`。Keychain/Credential Manager 只保存凭据原文，数据库和备份只保存 `secretRef`/元数据。

## 5. 开发步骤与测试方法

实现时按 TDD 分阶段：

1. 先写 Main/sidecar 启动握手、随机端口和 token 不落盘测试；
2. 再写 Preload 白名单和 Renderer 无 Node 权限测试；
3. 接入 React/Vite production build，并验证窗口加载和 readiness 展示；
4. 写 sidecar 正常关闭、超时、崩溃重启和版本信息测试；
5. 写 Docker blocked/恢复和不执行真实任务的集成测试；
6. 写升级前后数据/Schema/Keychain 边界测试；
7. 在 macOS arm64、macOS x64 和 Windows x64 分别构建并安装；
8. 执行 AS-18 全部场景并保存安装包哈希、版本、日志摘要、截图和 API/数据库证据。

## 6. 验收标准

| 编号 | 验收场景 | 通过标准 |
| --- | --- | --- |
| T11-AC-01 | macOS 安装 | arm64 和 x64 安装包可安装、打开和卸载；用户数据不因卸载默认删除 |
| T11-AC-02 | Windows 安装 | x64 安装包可安装、打开和卸载；用户数据目录独立 |
| T11-AC-03 | 双击启动 | Electron 窗口出现，sidecar 自动启动，readiness 可查询；无需手动启动 Python/Node/浏览器 |
| T11-AC-04 | sidecar 生命周期 | 正常退出保存状态；端口/token/退出码异常有诊断；超时不伪造成功 |
| T11-AC-05 | Preload 安全 | Renderer 无 Node、任意命令、任意路径和任意 URL 能力；只有白名单 API |
| T11-AC-06 | Docker 缺失 | Docker 停止时可查看数据但阻断容器执行；Docker 恢复并重新 readiness 后恢复受影响动作 |
| T11-AC-07 | 升级保数据 | 兼容升级保留项目、任务、审批、事件、Artifact、TraceLink 和 Schema；不兼容版本只读/阻断且旧库不变 |
| T11-AC-08 | 不越过关卡 | 运行中、等待 Boss、已暂停、已阻塞状态重启后不自动推进、不生成重复执行 |
| T11-AC-09 | 跨平台凭据 | macOS Keychain/Windows Credential Manager 中保存明文；Renderer、数据库、日志和包内无明文 |
| T11-AC-10 | 视口与诊断 | 1280×720、1440×900 可完成关键动作；诊断显示版本/平台/架构/traceId 且已脱敏 |

## 7. 完成定义

- `T11-AC-01～10` 全部有自动化或跨平台实机证据；
- `SR-DESK-001～012` 均有实现位置、测试用例和证据链接；
- 安装目录与用户数据目录分离；
- sidecar token、Keychain、Docker、Schema 和本机监听安全边界通过扫描；
- macOS/Windows 安装包哈希和构建环境已登记；
- 未签名本地包只能标记为开发验收包，正式发布包必须完成签名/公证/可信更新评审；
- 任务完成不改变 Task 1 的历史验收范围，只消费其运行时接口。
