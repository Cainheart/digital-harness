# Task 6 验收与 Review 证据

## 1. 交付范围与分支状态

- Task：DEV-06，真实互联网调研、来源治理、产品成功指标、PRD、双 PM 评审和提示注入防护。
- 开发分支：`dev_task6`。
- 分支基线：从当时最新本地 `master` 创建，基线提交为 `66ec04eaa102eef2c3fda1783c7e9713c86e6b2d`（Task 5 merge）。
- 代码完成提交：`c7886de`（`feat(task-6): add research evidence governance`）。
- 远程操作：未 push 到 GitHub，未合并回 `master`；实现和测试仅保存在本地，符合用户明确要求。
- 与通用文档流程的差异：`docs/task/task6.md` 和 `docs/code-development-guidelines.md` 的通用示例使用 `dev/task-6`，并描述 push/merge；本次以用户明确指定的 `dev_task6`、不 push 和不 merge 为准。

## 2. 需求、矩阵与设计追踪

| 依据 | 实现位置 | 验证证据 |
| --- | --- | --- |
| PRD §5.1/§5.2、§6.1～§6.3、§7.7、§8.3、§9.2/§10；AC-03、AC-04、AC-05、AC-25 | `backend/src/application/research-workflow.ts`、`backend/src/api/research.ts`、`backend/src/domain/research/` | 调研主流程、来源目录、结论校验、指标、PRD 和 PM 评审集成测试 |
| IF-WEB-001；SR-RSH-001～007；SR-EVL-002/003；SR-SEC-003/004/010/011 | `backend/src/research/adapter.ts`、`browser.ts`、`content-cleaner.ts`、`injection-guard.ts`、`source-validator.ts` | Grant 白名单、页数/超时边界、公开 URL 校验、清洗脱敏、注入检测、来源规则单元测试 |
| SR-ORG-002/010、SR-APR-003～005/008 | `backend/src/domain/product-success-metrics/`、`research-workflow.ts`、`workflow-coordinator.ts` | 成功指标字段约束、双 PM 交叉评审和 Boss PRD 证据门禁集成测试 |
| 概要设计 §2.3、Research Adapter、D4、§5.1、§5.3、§9.4 | `backend/src/research/`、`backend/src/infra/schema.ts`、`backend/src/infra/repositories/research.ts` | 可替换 Browser 边界、Chromium smoke、SQLite migration、Artifact 引用和 TraceLink |
| Task 2 Artifact Store、DomainEvent/TraceLink；Task 4 工作流门禁；Task 5 脱敏/观测边界 | `backend/src/infra/artifacts.ts`、`research-workflow.ts`、`workflow-coordinator.ts`、`redactJson` | 来源快照和报告 Artifact、运行事件、安全事件、跨项目边界和审批前复核 |

## 3. 实现清单

- 新增 `ResearchGrant`：绑定项目、任务、PM 角色、公开域名/URL、最大页数、超时、证据策略、trace 和到期时间；禁止本地/私网/凭据 URL。
- 新增 Playwright Chromium Research Adapter：受控搜索、打开、提取，限制 HTTP(S)、最终重定向、公开网络和资源请求；测试注入 `ResearchBrowser` 可稳定模拟网页与失败。
- 新增页面清洗和脱敏：移除脚本/样式/注释/控制字符，限制正文长度，生成 SHA-256，保存引用/摘要/快照 Artifact 引用，不把原始网页正文写入 SQLite 或运行事件。
- 新增 Prompt Injection Guard：识别忽略系统规则、执行命令、凭据外泄和角色改变，网页内容只作为不可信文本，安全事件只保存类别、脱敏风险摘要和下一步语义。
- 新增来源目录、调研运行、调研报告、结论、来源核验、冲突证据、成功指标、PRD 版本、PM 评审和安全事件表及项目范围索引。
- 新增官方一手来源、独立研究、独立媒体、转载/重复、不可访问等来源分类；官方功能结论最低一条直接来源，方向性结论最低两个不同组织来源，证据不足降级为 `hypothesis_only`。
- 新增第二位 PM 的逐来源核验事实：保存可访问性、支持度、独立性、判断、理由和冲突引用，不覆盖原始来源，并建立 Source → Validation → Conclusion TraceLink。
- 新增项目成功指标和 PRD 版本交付物；指标被交叉评审后才为 `reviewed`，PRD 只有已接受结论、有效来源、已评审指标和另一位 PM 的通过评审才能成为 `ready_for_approval`。
- 将 Task 6 证据门禁接入 Task 4 的 PM Cross Review 和 Boss PRD approval；在 Boss 审批时重新校验引用对象，防止证据删除、状态回退或跨任务引用绕过门禁。
- 新增 `0008_task6_research` migration、启动完整性检查、项目历史删除顺序和 Task 6 TraceLink 端点类型。
- 外部浏览器启动/网络失败统一为 `EXTERNAL_DEPENDENCY_UNAVAILABLE`，运行记录变为 `blocked`，已写入的事实保留，失败的页数预留会归还以支持恢复。

## 4. Task 6 验收标准证据

| 验收编号 | 结果 | 自动化/现场证据 |
| --- | --- | --- |
| T6-AC-01 真实访问网页 | 通过 | Playwright Chromium smoke 访问 `https://www.example.com/`，HTTP 200、页面标题和正文提取成功；模拟 Browser 集成测试覆盖运行、来源元数据、快照引用和报告。 |
| T6-AC-02 官方功能结论 | 通过 | `tests/unit/research.test.ts` 验证一个直接对应的 `official_first_party` 来源可接受为 `accepted_for_prd`，规则不扩展为效果/优越性结论。 |
| T6-AC-03 方向性结论证据不足 | 通过 | 来源规则单元测试验证只有一个有效独立来源，或只有一个来源加转载时，结论为 `hypothesis_only` 且标记 `待验证假设`。 |
| T6-AC-04 独立来源和转载 | 通过 | 来源规则过滤 `repost_or_duplicate`，不把同稿转载计为独立来源；集成主流程使用两个不同发布主体完成方向性结论。 |
| T6-AC-05 第二位 PM 核验 | 通过 | `research_source_validations` 保存逐来源可访问性、支持度、独立性和理由；集成测试断言两条核验记录存在，并建立 Validation/Conclusion TraceLink。 |
| T6-AC-06 成功指标 | 通过 | 集成测试创建名称、目标值、统计口径、验证方式、负责人/评审人，随后由第二位 PM 评审并更新为 `reviewed`。 |
| T6-AC-07 提示注入 | 通过 | 恶意网页样本包含忽略系统指令和执行命令文本；正文未执行，API Key 被脱敏，安全事件保存固定类别和风险摘要。 |
| T6-AC-08 外部服务失败 | 通过 | `UnavailableResearchBrowser` 集成测试返回 `EXTERNAL_DEPENDENCY_UNAVAILABLE`/503，运行状态为 `blocked`，数据保留且页数预留归还。 |
| T6-AC-09 Boss PRD 审批前置 | 通过 | Task 6 已启动但缺少可审批 PRD 时，`pm_review_completed` 返回 `EVIDENCE_INCOMPLETE`；门禁最终重新校验来源、结论、指标和评审引用。 |
| T6-AC-10 追踪链 | 通过 | 集成测试查询 `trace_links`，验证 Run → Source、Source → Conclusion、Report → Conclusion、Source → Validation 和对象 → PRD/评审的项目范围链路。 |
| T6-AC-COMMIT | 通过 | 当前分支 `dev_task6`；代码完成提交 `c7886de`；未 push、未 merge；代码提交后全量验证通过。 |

## 5. 测试、构建、真实浏览器与迁移结果

在 `backend/` 目录执行：

```text
npm run typecheck
通过。

npm run build
通过。

npm test -- --run
18 个测试文件通过，92 个测试通过。

git diff --check
通过，无空白错误。
```

真实 Chromium smoke 结果：

```text
URL: https://www.example.com/
HTTP status: 200
accessible: true
title: Example Domain
正文提取: 成功
```

新增/更新回归覆盖：

- ResearchGrant 的公开域名、精确 URL、到期、页数、超时、重定向、localhost/私网/保留地址和跨项目边界。
- 页面脚本/样式清洗、正文长度、SHA-256、邮箱/手机号/API Key 脱敏和固定提示注入类别。
- 官方一手来源、方向性结论最低证据、独立组织、转载去重、假设降级和冲突记录。
- 来源逐条 PM 核验、成功指标评审、PRD 版本、双 PM 角色隔离、TraceLink 和 Boss 审批门禁。
- Chromium 不可用、浏览器失败、运行阻塞、数据保留和页数预留归还。
- `0007_task5_model_gateway → 0008_task6_research` 以及已有 Task 1～5 全量回归。

## 6. Code Review 记录

### 6.1 审查清单

- [x] 已对照 `docs/task/task6.md`、PRD、需求矩阵、概要设计和 `docs/code-development-guidelines.md` 建立实现与测试追踪。
- [x] 新增对象均按项目/任务范围校验；Grant 不能扩展角色、工具、流程、文件、Shell、Docker 或私网访问能力。
- [x] 网页只经过 Research Adapter、清洗器、注入检测和脱敏后进入 Artifact 引用；运行事件不保存网页原文或风险原文。
- [x] 方向性结论不接受单一有效来源；转载不重复计数；证据不足明确标记为待验证假设。
- [x] 第二位 PM 的核验是追加事实，原始来源仍保留；冲突证据保留双方引用和判断状态。
- [x] Boss 审批在进入关卡和决定审批两个时点都执行 Task 6 证据门禁；最终门禁重新校验对象存在性、项目/任务、状态、来源核验和评审关联。
- [x] 外部服务失败有稳定错误码、trace、阻塞状态和数据保留语义；失败的页数预留可归还。
- [x] 已复用既有 Database、Artifact Store、runtime event、TraceRepository、项目/任务和工作流边界，没有新建平行状态系统。
- [x] 新文件使用业务职责命名；新增类型、常量、类和关键边界函数均有职责注释；`git diff --check` 通过。
- [x] 已检查跨项目/跨任务引用、过期 Grant、页数并发边界、错误归一化、历史迁移和旧 Task 4 测试兼容。

### 6.2 Review findings 与处理结果

| 严重级别 | 发现 | 处理 |
| --- | --- | --- |
| P1 | 初始 TraceLink 生成逻辑会把 `research_source` 错误替换成不存在的 `research_target`。 | 改为独立生成 source/target 检查，并加入研究对象端点类型；迁移和全量测试通过。 |
| P1 | 初始 PM 评审只保存摘要，没有逐来源核验事实。 | 新增 `research_source_validations`、冲突引用、Source/Validation/Conclusion TraceLink 和 PRD ready 门禁；集成测试断言记录数量。 |
| P1 | 仅检查 PRD 的 `ready_for_approval` 状态可能让删除/回退后的引用绕过 Boss 审批。 | 审批时重新读取并校验来源、结论、指标、评审、任务范围、来源核验和指标评审关联。 |
| P2 | 外部浏览器在 reserve 后失败会消耗最后一页，阻塞后无法恢复。 | 新增原子 `releasePage`，浏览器失败后归还页数并恢复 Grant active 状态。 |
| P2 | 受控浏览器只检查主 URL，页面资源可能请求本地/私网地址。 | 增加 Playwright request route，对所有资源请求执行 public URL 校验并拦截本地/私网/非 HTTP(S) 请求。 |

以上 findings 均已关闭；没有开放的 P0/P1 finding。

## 7. 完成状态

- 验收状态：通过本地全量自动化测试、类型检查、构建、迁移回归、脱敏/注入测试和真实 Chromium smoke。
- Review 状态：通过；无开放 P0/P1 finding。
- 本地代码提交：`c7886de`；本验收文档在代码提交之后另行提交并保持在同一 `dev_task6` 分支。
- 合并状态：未合并到 `master`，符合用户要求；没有 push 到 GitHub。
- 后续交接：Task 8 可消费 PRD/成功指标/验收证据，Task 9 可展示来源/报告/评审/审批证据，Task 10 可统计调研运行和安全事件。
