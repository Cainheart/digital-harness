# Task 5 验收与 Review 证据

## 1. 交付范围与分支状态

- Task：DEV-05，模型配置、凭据保护、真实调用网关、错误归一化和调用观测。
- 开发分支：`dev_task5`。
- 分支基线：从当时最新本地 `master` 创建，基线提交为 `a2c9a95`（`merge: integrate task-4 workflow governance`）。
- 代码完成提交：`e059337`（`feat(task-5): complete model gateway`）。
- 远程操作：未 push 到 GitHub，未合并回 `master`；当前实现仅保存在本地，符合用户本次“暂存在本地”的明确要求。
- 与通用文档流程的差异：`docs/task/task5.md` 和 `docs/code-development-guidelines.md` 的通用示例使用 `dev/task-5` 并要求 push/merge；本次以用户明确指定的 `dev_task5`、不 push 和不 merge 为准，代码契约和验收内容不受影响。

## 2. 需求、矩阵与设计追踪

| 依据 | 实现位置 | 验证证据 |
| --- | --- | --- |
| PRD §7.4、§7.6、§7.7、§8.3、§8.4；AC-16、AC-17、AC-25 | `backend/src/application/model-settings.ts`、`backend/src/api/model-settings-routes.ts`、`backend/src/domain/model-config.ts` | 五领域独立配置、连接检测、凭据删除、版本冲突和幂等集成测试 |
| IF-LLM-001/002；SR-MDL-001～007 | `backend/src/gateway/model/`、`backend/src/infra/migrations/0007-model-gateway.ts` | OpenAI/DeepSeek 兼容适配器、结构化输出 Schema、超时/重试/用量和错误归一化单元测试 |
| SR-OBS-002～006、SR-EVL-008 | `backend/src/observability/model-call-recorder.ts`、`backend/src/api/execution-routes.ts` | started/finished/failed 生命周期、TraceLink、调用查询、Token/成本/重试聚合集成测试 |
| SR-SEC-002/003/006/011；AS-01、AS-02、AS-09、AS-13、AS-16、AS-17 | `backend/src/infra/keychain.ts`、`backend/src/observability/redaction.ts`、`backend/src/application/model-settings.ts` | Memory Keychain 替身、数据库/事件/API 响应脱敏扫描、凭据回显阻断和错误正文不落库测试 |
| SR-REL-003 | `backend/src/application/organization-service.ts`、`backend/src/infra/repositories/execution.ts` | Attempt 创建时复制 provider/model/configVersion/secretRef 引用；旧 Attempt 与新配置隔离测试 |
| 概要设计 §2.3、§3.2、D3、E3/E4、§9.3/§9.6 | `backend/src/gateway/model/`、`backend/src/observability/trace.ts`、`backend/src/infra/schema.ts` | TypeScript Model Adapter、CredentialAdapter 边界、TraceContext、SQLite 调用记录和迁移完整性测试 |
| BIMA §3.3、§6.4、§13～§14 | `backend/src/gateway/model/gateway.ts`、`backend/src/observability/model-call-recorder.ts` | ModelGateway 不推进业务状态；冻结配置、脱敏摘要和调用链路由控制面/执行面消费 |

## 3. 实现清单

- 新增 `model_configs` 和 `model_config_changes`，按 `product`、`development`、`npi`、`testing`、`project_management` 五个领域独立保存 provider、model、configVersion、连接状态和 Keychain `secretRef`。
- 新增 `GET/PUT /api/v1/settings/models`、连接检测和凭据删除接口；响应不包含 credential、secretRef 或供应商原始错误正文。
- 新增 OpenAI 和 DeepSeek 的 OpenAI-compatible 真实 HTTP Adapter，默认端点分别为 OpenAI Chat Completions 和 DeepSeek Chat Completions；测试通过注入 fetch 模拟供应商，不把真实密钥或真实供应商响应写入测试报告。
- 连接和模型调用均从 `CredentialAdapter` 的边界短时读取凭据；SQLite、领域事件、模型调用摘要和 API 视图只保留引用或脱敏摘要。
- 新增 `FrozenModelConfig`，在 Attempt 创建时复制领域、供应商、模型、配置版本、secretRef 引用、超时和最大重试次数；后续配置变更不会回写正在运行的 Attempt。
- 统一归一化 `CREDENTIAL_UNAVAILABLE`、`AUTHENTICATION_FAILED`、`RATE_LIMITED`、`TIMEOUT`、`PROVIDER_UNAVAILABLE`、`INVALID_STRUCTURED_OUTPUT`、`REDACTION_FAILED` 和 `UNKNOWN_PROVIDER_ERROR`。
- 新增 ModelCall recorder：原子记录 started/finished/failed，保存脱敏输入/输出摘要、耗时、超时、重试、Token、成本、错误分类、trace/span 和 Artifact 引用，并建立到 Attempt/Task/Artifact 的 TraceLink。
- 新增 `/api/v1/executions` 脱敏查询和按领域/模型聚合调用次数、耗时、错误率、Token、成本、重试和已完成调用成本。
- Schema revision 升级为 `0007_task5_model_gateway`；旧数据库可从 `0006_task4_workflow_hardening` 迁移，启动完整性检查覆盖新表、字段、索引和五个默认领域行。

## 4. T5 验收标准证据

| 验收编号 | 结果 | 自动化证据 |
| --- | --- | --- |
| T5-AC-01 五领域配置 | 通过 | `tests/integration/model-settings.test.ts` 为五个领域分别写入配置，验证版本和领域相互独立。 |
| T5-AC-02 OpenAI/DeepSeek 连接 | 通过 | `tests/unit/model-gateway.test.ts` 覆盖两类适配器的兼容协议和鉴权；配置接口调用连接检测时缺凭据返回 `CREDENTIAL_UNAVAILABLE`/503。真实网络连接只在提供真实 Keychain 凭据的受控环境执行，本地测试不发送测试密钥到外部服务。 |
| T5-AC-03 运行中切换 | 通过 | `model-settings.test.ts` 冻结 v1 后更新到 v2，断言冻结对象仍使用旧模型和版本，新读取使用新版本；旧 Attempt 的 snapshot 字段由创建边界写入。 |
| T5-AC-04 凭据删除 | 通过 | `model-settings.test.ts` 删除 npi 凭据后断言 `credentialStatus=missing`、`connectionStatus=blocked`，连接检测返回 503，且 provider 不静默切换。 |
| T5-AC-05 凭据泄露 | 通过 | 假 Key 只进入 Memory Keychain；测试扫描 API 响应、SQLite `model_configs`、runtime events、模型调用记录和供应商失败正文，均不包含明文。 |
| T5-AC-06 结构化输出错误 | 通过 | `model-gateway.test.ts` 让供应商返回不符合 TypeBox Schema 的 JSON，断言错误码为 `INVALID_STRUCTURED_OUTPUT`，不返回原始模型内容。 |
| T5-AC-07 供应商失败 | 通过 | `model-gateway.test.ts` 覆盖 429 限流、AbortError 超时、有限重试和 401 鉴权；`model-call-observability.test.ts` 覆盖 503 供应商不可用，调用事实保留且不写入原文。 |
| T5-AC-08 调用链路 | 通过 | `model-call-observability.test.ts` 断言 model call 关联项目、任务、Attempt、trace，并建立 Attempt/Task TraceLink；`GET /api/v1/executions` 可查询同一调用。 |
| T5-AC-09 脱敏失败 | 通过 | 供应商回显凭据时适配器返回 `REDACTION_FAILED`；recorder 将该调用标记为 `finalStatus=failed`、`redactionStatus=failed`，不写入回显正文。 |
| T5-AC-10 成本聚合 | 通过 | `model-call-observability.test.ts` 使用注入费率计算整数 micro-USD，断言 Token、成本、调用次数和重试聚合结果。未知模型默认零价，生产侧可注入明确的 `PricingResolver`。 |

## 5. 测试、构建与迁移结果

在 `backend/` 目录执行：

```text
npm run typecheck
通过。

npm test -- --reporter=dot
16 个测试文件通过，85 个测试通过。

npm run build
通过。

git diff --check
通过，无空白错误。
```

新增/更新回归覆盖：

- 五领域配置独立性、连接测试、删除凭据、配置版本冲突和相同幂等键重放。
- OpenAI/DeepSeek 兼容响应、鉴权失败、限流、超时、有限重试、结构化输出校验和凭据回显阻断。
- ModelCall started/finished/failed 生命周期、脱敏失败状态、TraceLink、查询过滤和成本聚合。
- `0006_task4_workflow_hardening → 0007_task5_model_gateway` 迁移，五个默认配置行、新表、新调用字段和索引完整性。
- 既有 Task 1～4 测试回归。

## 6. Code Review 记录

### 6.1 审查清单

- [x] 已对照 Task 5 PRD 条款、需求矩阵、概要设计、BIMA 设计和 T5-AC-01～10 建立追踪关系。
- [x] 配置 API、领域对象、Keychain 引用、Schema 字段、唯一约束、索引、迁移和幂等路径一致。
- [x] Attempt 使用配置快照；配置变更不会修改正在运行的 Attempt；调用记录保留 configVersion、trace/span 和关联对象。
- [x] 凭据没有进入 UI/API 视图、上下文摘要、模型调用记录、领域事件、错误载荷或测试报告；供应商原始响应不落库。
- [x] 适配器不静默切换供应商；凭据缺失、结构化输出错误、脱敏失败和外部服务失败均返回固定错误码。
- [x] 已覆盖主流程、拒绝路径、空值/错误类型、并发版本、幂等重放、重试/超时、跨边界和旧库迁移。
- [x] 新增文件按业务职责使用 kebab-case，没有使用 `taskN.ts` 命名；新增函数、类型和常量均有职责注释。
- [x] 复用既有 `CredentialAdapter`、`TraceContext`、事件存储、数据库事务和 `ExecutionRepository` 边界，没有另起平行凭据或项目状态系统。
- [x] 已清理未使用导入和变量；新文件无超过 140 字符的长行，`git diff --check` 通过。
- [x] 修复问题的位置已按代码规范补充 `2026-08-16` 修改日期和原因注释。

### 6.2 Review findings 与处理结果

| 严重级别 | 触发条件/定位 | 实际问题 | 处理与回归 |
| --- | --- | --- | --- |
| P1 | 配置更新使用相同幂等键重放；`model-settings.ts` | 先做 expectedVersion 检查会让合法重放被旧版本冲突拦截，破坏幂等语义。 | 改为先查幂等变更，再校验版本；同键重放集成测试通过。 |
| P1 | `openai-compatible-adapter.ts` 供应商返回正文和结构化输出边界 | 供应商响应可能包含凭据或不符合统一 Schema，不能把原文交给业务层。 | 在外部边界扫描凭据回显、只解析结构化 JSON、统一映射错误；回显和非法 Schema 测试通过。 |
| P2 | `ModelReadinessChecker` 同时存在新 `model_configs` 与旧 legacy 配置 | 已有 Task 5 配置全部不可用时若继续回退旧配置，可能错误报告 ready。 | 有新配置行时只根据新配置判断；全部不可用明确返回 blocked；类型检查和全量测试通过。 |
| P2 | Adapter 直接接收非法 timeout/maxAttempts 或空 SecretLease | 非法边界参数可能导致无调用、无限重试或空凭据请求。 | 对凭据租约、超时和重试次数增加有限边界；新增限流/超时/重试测试通过。 |
| P2 | `0006 → 0007` 旧库路径 | 若只验证当前数据库，历史 Task 4 数据库可能缺少模型表和字段。 | 增加显式 migration 分支、表/字段/索引 readiness 合同和迁移生命周期回归。 |
| P2 | recorder 记录 `REDACTION_FAILED` | 脱敏失败若沿用普通错误摘要的 passed 状态，会掩盖安全失败。 | 安全错误写入 `redactionStatus=failed`，并增加 recorder 集成回归。 |

上述 findings 均已关闭；没有开放的 P0/P1 finding。保留的低风险运行注意事项是：真实供应商连接需要部署环境提供可用 OS Keychain 凭据；默认价格解析器为零价，生产部署应注入经过确认的供应商费率表。这两项不会影响本地安全边界和自动化验收。

## 7. 完成状态

- 验收状态：通过本地自动化测试、类型检查、构建、迁移回归和脱敏扫描。
- Review 状态：通过；无开放 P0/P1 finding。
- 本地提交：`e059337`，Task 5 核心代码和测试已提交；本验收文档随后单独提交并保持在同一 `dev_task5` 分支。
- 合并状态：未合并到 `master`，符合用户要求；没有 push 到 GitHub。
- 后续交接：Task 6/7 可通过 `ModelGateway` 注入具体执行上下文；Task 9/10 可通过模型设置和 `/api/v1/executions` 查询接口消费配置与调用观测数据。
