# Task 1：本地运行骨架、运行准备与持久化根目录

> 任务编号：DEV-01
> 任务状态：已实现，真实环境验收通过（2026-08-13）
> 任务类型：基础设施、应用生命周期、安全边界
> 前置任务：无
> 后续消费者：task2.md、task3.md、task4.md、task5.md、task7.md、task10.md、task11.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

建立一个可启动、可停止、可重启、默认只允许本机访问的 V1 运行骨架。系统必须在任何真实模型调用、网页访问、工作区写入和测试执行发生之前，完成运行准备检查，并将业务数据库、交付物、追踪、工作区和备份保存到可配置的持久化根目录。

本任务解决的是“系统能否安全地开始运行”和“系统重启后是否还保留事实”的问题，不实现完整业务流程，也不实现具体数字员工能力。

## 2. 上游依据与设计一致性

### 2.1 PRD 依据

- PRD §4.1：Boss 能在 Web 控制台创建并启动本地数字研发公司。
- PRD §4.3：V1 采用可安装桌面应用作为正式交付形态；本任务只提供桌面化所消费的运行时基础，不实现 Electron 打包。
- PRD §6.2：首次使用必须展示运行准备，模型、公开资料调研和本地工作区不可用时不能启动。
- PRD §6.4、§7.9、§8.3、§8.4：项目可暂停/恢复，重启不能丢失已提交数据，本机访问和凭据保护必须受控。
- 对应 AC-01、AC-02、AC-19、AC-22、AC-25。

### 2.2 需求矩阵依据

- SR-INI-003～008：运行准备、启动阻断、立项确认和真实执行起点。
- SR-SEC-001/002/006/007：本机访问、凭据保护、脱敏和高风险命令策略。
- SR-DAT-001/002/004/006：数据分类、持久化根目录、Schema 版本和 Keychain。
- SR-REL-001/003/005、SR-NFR-004/009：重启完整性、外部依赖失败、恢复时效。
- AS-02、AS-09、AS-10、AS-15、AS-16：启动前阻断、外部失败、重启恢复、备份恢复和安全基线。
- DEV-11 / `SR-DESK-002/003/006/008/009`：Electron sidecar 将消费本任务的 readiness、生命周期、Schema、Keychain 和本机访问边界。

### 2.3 设计依据

- 总体概要设计 §2.3、§3.1～§3.2、§8、§9：FastAPI 控制面、SQLite WAL、本地证据库、OS Keychain、Docker 和 127.0.0.1。
- BIMA 详细设计 §3.3、§12、§14：Python 控制进程、SQLite WAL、Artifact Store、Checkpoint、Keychain 和安全失败。

## 3. 具体交付物

### 3.1 代码交付物

建议创建或固定以下逻辑目录；如果工程初始化时目录名称不同，必须在实现记录中建立一一对应关系：

~~~text
backend/app/bootstrap/
backend/app/config/
backend/app/api/readiness.py
backend/app/infra/persistence_root.py
backend/app/infra/keychain.py
backend/app/infra/database.py
backend/app/infra/migrations/
backend/app/lifecycle/
worker/
frontend/src/features/readiness/
tests/unit/bootstrap/
tests/integration/lifecycle/
tests/security/runtime_boundary/
~~~

必须交付：

1. 应用配置对象，支持配置持久化根目录、监听地址、数据库路径、Artifact 路径、Trace 路径和工作区路径。
2. 持久化根目录初始化器，创建并校验以下目录：

   ~~~text
   <persistent-root>/
   ├── company.db
   ├── artifacts/
   ├── traces/
   ├── workspaces/
   ├── backups/
   └── manifest.json
   ~~~

3. SQLite WAL 初始化、连接池/事务基础配置和数据库版本检查。
4. Alembic migration 启动检查；当前数据库版本不兼容时禁止可写启动。
5. CredentialAdapter 接口和 OS Keychain 实现。数据库只保存 secretRef、provider、model、配置版本和连接状态。
6. ReadinessView 查询 API 和前端准备状态展示所需的响应模型。
7. 应用启动、停止、重启、Worker 租约检查和安全关闭流程。
8. 默认只监听 127.0.0.1 的配置与启动校验。
9. 不触发真实执行的启动前检查。

### 3.2 文档和运维交付物

- 本地开发启动说明：依赖、环境变量、Docker 要求、Keychain 要求和持久化根目录配置。
- 数据目录说明：每类数据的所有者、读写方、备份边界和删除边界。
- 应用升级说明：Schema 版本检查、兼容/不兼容行为和只读阻断行为。
- 运行准备故障处理说明：模型不可用、网页调研不可用、Docker 不可用、工作区不可用时分别如何处理。

### 3.3 测试交付物

- 启动前禁止真实执行的单元测试和集成测试。
- 持久化根目录初始化、重启恢复和不兼容 Schema 的测试。
- Keychain 明文不落盘、不进日志、不进数据库、不进 API 响应的安全测试。
- 本机监听和非本机访问拒绝测试。

## 4. 接口设计

### 4.1 运行准备查询接口

沿用总体概要设计的：

~~~http
GET /api/v1/readiness
~~~

响应使用 ReadinessView，每次查询都重新检查当前环境，不把上一次成功结果永久视为有效：

~~~json
{
  "status": "ready",
  "checkedAt": "2026-08-12T10:20:30Z",
  "checks": {
    "model": {
      "status": "ready",
      "providers": ["openai", "deepseek"],
      "message": "至少一个已配置模型可连接"
    },
    "research": {
      "status": "ready",
      "browser": "chromium",
      "message": "公开资料调研适配器可启动"
    },
    "workspace": {
      "status": "ready",
      "root": "workspace://local",
      "message": "本地项目工作区可访问"
    },
    "docker": {
      "status": "ready",
      "message": "非 root 容器执行环境可用"
    },
    "persistence": {
      "status": "ready",
      "schemaRevision": "2026_08_12_001",
      "persistentRoot": "configured"
    }
  },
  "allowedActions": ["create_project"],
  "traceId": "tr_readiness_01"
}
~~~

status 至少支持 ready、blocked、degraded。检查失败时不得返回可误解为可启动的状态。

### 4.2 凭据适配接口

业务数据库只能保存引用，凭据适配器负责明文的短时读取：

~~~python
class CredentialAdapter(Protocol):
    async def save(self, provider: str, secret: str) -> str:
        """保存到 OS Keychain，仅返回 secretRef。"""

    async def read(self, secret_ref: str) -> SecretLease:
        """在外部调用边界短时读取，不允许进入业务对象或日志。"""

    async def delete(self, secret_ref: str) -> None:
        """删除 Keychain 中的凭据。"""

    async def check(self, secret_ref: str) -> CredentialCheckResult:
        """返回可用性和脱敏错误，不返回明文。"""
~~~

SecretLease 只能在 Model Adapter 或 Research Adapter 的调用边界使用，不能进入 DomainEvent、Artifact、SSE 或前端响应。

### 4.3 生命周期规则

| 场景 | 行为 |
| --- | --- |
| Schema 兼容 | 允许可写启动，生成 ApplicationStarted 事件。 |
| Schema 不兼容 | 禁止可写启动，仅返回处理提示，不修改业务数据。 |
| 启动前运行准备不完整 | UI 禁止启动数字公司，不能生成模型/网页/工作区操作。 |
| 应用正常关闭 | 停止接收新命令，等待安全边界内任务完成或保存检查点，再关闭数据库连接。 |
| Worker 心跳失效 | 由后续恢复协调器判断是安全重试、阻塞还是等待人工；本任务不直接推进业务状态。 |
| 非本机请求 | 默认拒绝，并写入安全事件。 |

### 4.4 错误模型

统一使用概要设计中的错误分类，并至少支持：

- 503 EXTERNAL_DEPENDENCY_UNAVAILABLE：模型、浏览器、Docker 或工作区依赖不可用；
- 409 WORKFLOW_GUARD_BLOCKED：业务流程未允许启动；
- 409 VERSION_CONFLICT：Schema/配置/应用版本不匹配；
- 403 POLICY_DENIED：访问来源或安全策略拒绝；
- 422 EVIDENCE_INCOMPLETE：准备检查结果无法形成完整证据。

错误响应必须包含 code、message、impact、paused、dataPreserved、nextAction 和 traceId，不得包含凭据。

## 5. 开发实施方法

1. 先建立配置对象和持久化根目录初始化器，测试“空目录首次启动”和“已有数据重启”两条路径。
2. 接入 SQLite WAL 和 Alembic，先写 Schema 版本不兼容测试，再实现启动阻断。
3. 实现 Keychain 适配器，使用测试替身验证数据库、日志和响应中只有 secretRef。
4. 实现 ReadinessView，把模型、网页、Docker、工作区和持久化检查拆成独立检查器，避免一个检查器吞掉其他失败原因。
5. 加入本机监听、启动前无副作用和安全关闭逻辑。
6. 接入最小前端准备状态页面，但页面只调用 API，不直接检查 Docker、Keychain 或文件系统。
7. 完成集成测试后，提供本地运行和故障处理说明，再把接口交给 task2.md～task5.md。

需要使用：

- Python 3.12、FastAPI、Pydantic v2、SQLAlchemy 2、Alembic；
- SQLite WAL；
- OS Keychain/ keyring；
- Docker Engine 或 Docker Desktop；
- React 18、TypeScript、Vite、TanStack Query；
- pytest、HTTP 集成测试、文件系统临时目录和安全测试工具。

## 6. 验收标准与验收方法

| 验收编号 | 验收场景 | 验收方法 | 通过标准 |
| --- | --- | --- | --- |
| T1-AC-01 | 首次进入运行准备 | 启动空环境并调用 GET /api/v1/readiness | 模型、调研、工作区、Docker、持久化五类状态分别展示，缺失项有影响和处理入口。 |
| T1-AC-02 | 条件不完整时启动 | 禁用模型或 Docker 后尝试启动 | 启动被阻止，没有模型调用、网页访问、文件写入或测试命令事件。 |
| T1-AC-03 | Schema 不兼容 | 使用高版本或未知版本数据库启动 | 应用禁止可写启动，原业务数据不变，返回可执行处理说明。 |
| T1-AC-04 | 数据重启 | 写入一条已提交业务记录后停止并重启 | 数据、Schema、持久化根目录和可查询状态保持一致。 |
| T1-AC-05 | 凭据保护 | 写入测试 API Key，搜索数据库、日志、Artifact 和 API 响应 | 只有 Keychain 测试替身能读取明文；其他位置只出现掩码或 secretRef。 |
| T1-AC-06 | 本机边界 | 从非 127.0.0.1 来源发起请求 | 请求被拒绝并产生脱敏安全事件。 |
| T1-AC-07 | 应用重启不越过关卡 | 在等待 Boss 和已暂停状态重启 | 状态不自动变成运行中，不启动新任务，不产生重复执行。 |

验收证据必须包括：启动日志摘要、API 响应、数据库版本、目录清单、重启前后对象摘要、脱敏扫描结果和测试命令/退出码。

## 7. 完成定义与交接

完成本任务必须同时满足：

- GET /api/v1/readiness 可被前端和后续自动化验收调用；
- 持久化根目录、数据库版本和 Keychain 边界有自动化测试；
- 启动前无真实执行副作用；
- 重启、不兼容 Schema、本机访问和凭据保护负向测试通过；
- 向 task2.md 提供数据库连接、事务、TraceContext、Artifact Store 和应用生命周期接口；
- 所有变更、测试和运行说明均写入本任务的交付证据。

本任务不允许以“页面能打开”作为完成依据；必须有真实启动检查、持久化和安全测试结果。

桌面化边界：Task 1 的真实验收仍以“主机上的 Python/Uvicorn + React/Vite + Docker readiness”作为证据；它没有创建 Electron 工程、桌面安装包或 Python sidecar bundle。DEV-11 将在不改变本任务核心契约的前提下接入这些能力。
