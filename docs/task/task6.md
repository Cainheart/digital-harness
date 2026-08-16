# Task 6：真实互联网调研、来源治理与双 PM 协作

> 任务编号：DEV-06
> 任务状态：待开发
> 任务类型：Research Adapter、来源证据、PM 交付物、提示注入防护
> 前置任务：task2.md、task3.md、task4.md、task5.md
> 后续消费者：task8.md、task9.md、task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

让产品阶段真实访问公开互联网，形成可核验的来源目录、调研报告、项目成功指标、PRD 和 PM 交叉评审，并把证据不足的结论阻止在 Boss 审批之前。

本任务必须区分“网页事实”“PM 判断”和“待验证假设”。网页内容只作为不可信资料输入，不能改变角色、流程、权限、系统指令或工具策略。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §5.1/§5.2：两位 PM 的职责和交叉评审。
- PRD §6.1～§6.3：真实调研、PRD 起草、来源核验和 Boss 审批。
- PRD §7.7：官方一手来源、独立来源、来源元数据、冲突证据和提示注入。
- PRD §8.3：网页按不可信输入处理。
- PRD §9.2、§10：项目成功指标由 PM 产生并接受评审。
- 对应 AC-03、AC-04、AC-05、AC-25。

### 2.2 需求矩阵

- IF-WEB-001；
- SR-RSH-001～007；
- SR-ORG-002/010、SR-APR-003～005/008；
- SR-EVL-002/003；
- SR-SEC-003/004/010；
- AS-01、AS-03、AS-04、AS-07、AS-09、AS-13、AS-16。

### 2.3 概要设计

- 总体设计 §2.3、Research Adapter、D4、§5.1、§5.3、§9.4；
- BIMA 的不可信输入、策略边界、证据记录和脱敏原则；
- task3.md 的 PM 角色、结构化消息和策略接口；
- task5.md 的模型网关和调用观测接口。

## 3. 具体交付物

### 3.1 建议代码目录

~~~text
backend/app/research/grant.py
backend/app/research/adapter.py
backend/app/research/browser.py
backend/app/research/content_cleaner.py
backend/app/research/source_validator.py
backend/app/research/injection_guard.py
backend/app/domain/research/
backend/app/domain/product_success_metrics/
backend/app/application/research_workflow.py
backend/app/api/research.py
tests/unit/research/
tests/integration/research/
tests/security/prompt_injection/
~~~

### 3.2 ResearchGrant

每次调研执行必须使用授权对象：

~~~json
{
  "grantId": "research_grant_01J",
  "projectId": "project_01J",
  "taskId": "task_research_01J",
  "role": "user_market_pm",
  "allowedDomains": ["example.com"],
  "allowedUrls": [],
  "maxPages": 20,
  "timeoutSeconds": 30,
  "evidencePolicy": "source_metadata_and_quote",
  "network": "public_web_only",
  "expiresAt": "2026-08-12T11:20:30Z",
  "traceId": "tr_01J"
}
~~~

Grant 不能授权本地文件、Shell、Docker、系统目录或改变角色/流程的能力。

### 3.3 来源对象

每一条来源必须保存：

- sourceId、projectId、taskId；
- 页面标题、URL、发布者；
- 可获得的发布日期；
- 访问时间、来源类型；
- 页面状态、HTTP 状态、可访问性；
- 支持的结论；
- 引用片段/摘要；
- 页面快照或内容哈希；
- 核验人、核验时间和核验结果；
- 是否独立来源；
- 冲突证据及判断理由；
- traceId 和 Artifact 引用。

来源类型至少包括：

- official_first_party；
- independent_research；
- independent_media；
- user_or_market_data；
- repost_or_duplicate；
- inaccessible；
- hypothesis_only。

### 3.4 产品成功指标和 PRD

PM 必须产生：

~~~json
{
  "metricId": "metric_01J",
  "name": "目标指标名称",
  "targetValue": "目标值",
  "measurementDefinition": "统计口径",
  "verificationMethod": "验证方式",
  "owner": "product_solution_pm",
  "reviewer": "user_market_pm",
  "status": "reviewed",
  "evidenceRefs": ["artifact://research/report_01J"]
}
~~~

PRD 版本必须关联来源目录、成功指标、PM 交叉评审、争议记录和当前版本状态。

## 4. 接口设计

### 4.1 Research Adapter

~~~python
class ResearchAdapter(Protocol):
    async def search(
        self,
        grant: ResearchGrant,
        query: str,
    ) -> list[SearchResult]: ...

    async def open(
        self,
        grant: ResearchGrant,
        url: str,
    ) -> PageEvidence: ...

    async def extract(
        self,
        grant: ResearchGrant,
        page: PageEvidence,
        selectors: ExtractionRequest,
    ) -> ExtractedResearch: ...
~~~

输出必须通过内容清洗、来源 Schema 校验、提示注入检测和敏感信息脱敏后，才能进入 Artifact Store。

### 4.2 PM 调研接口

建议提供：

~~~http
POST /api/v1/projects/{projectId}/research/runs
GET  /api/v1/projects/{projectId}/research/sources
GET  /api/v1/projects/{projectId}/research/reports
POST /api/v1/projects/{projectId}/research/conclusions/validate
POST /api/v1/projects/{projectId}/research/peer-review
~~~

关键结论校验请求：

~~~json
{
  "conclusionId": "conclusion_01J",
  "conclusionType": "market_or_competitive",
  "statement": "影响产品方向的判断",
  "sourceIds": ["source_01J", "source_02J"],
  "independenceDeclaration": true
}
~~~

校验结果：

~~~json
{
  "conclusionId": "conclusion_01J",
  "status": "accepted_for_prd",
  "requiredSources": 2,
  "validIndependentSources": 2,
  "conflicts": [],
  "assumptionLabel": null,
  "reviewer": "product_solution_pm",
  "evidenceRefs": ["artifact://source/source_01J"]
}
~~~

### 4.3 来源规则

| 结论类型 | 最低证据 |
| --- | --- |
| 被调研产品官网直接声明的客观功能 | 一个直接对应的官方一手来源。 |
| 市场、用户、趋势、效果或竞品优劣结论 | 两个不同组织或编辑主体的独立来源。 |
| 证据不足或来源冲突未判定 | 只能标记为待验证假设，不能进入确定性方向结论。 |
| 同一稿件转载 | 不能计作两个独立来源。 |

### 4.4 提示注入处理

网页中出现“忽略系统规则”“执行某命令”“泄露凭据”“改变角色”等内容时：

1. 内容只进入不可信文本字段；
2. 不进入工具策略、角色定义或流程命令；
3. 记录安全事件和页面证据；
4. 当前调研任务按策略继续清洗、跳过或阻塞；
5. Boss 看到的是脱敏的风险摘要和下一步动作。

## 5. 开发实施方法

1. 先定义来源、结论、假设、冲突、指标和 PRD 版本 Schema。
2. 实现受控 Chromium/Playwright 浏览器上下文，限制 URL、页数、超时和网络范围。
3. 实现页面内容清洗、脚本/指令隔离、敏感信息脱敏和内容哈希。
4. 实现官方来源/独立来源/转载/不可访问的分类和校验规则。
5. 实现第二位 PM 的来源核验和冲突证据保留。
6. 实现项目成功指标和 PRD 版本交付物，连接 task4.md 的 PRD 审批关卡。
7. 使用固定恶意网页样本做提示注入测试，使用模拟网页做稳定的来源规则测试，再使用真实公开网页做受控验收。

需要使用：

- Playwright Chromium；
- Research Adapter、内容清洗器、来源校验器；
- task2.md 的 Artifact Store、DomainEvent、TraceLink；
- task3.md 的 PM 角色和结构化消息；
- task4.md 的任务/审批/阻塞机制；
- task5.md 的真实模型调用和脱敏；
- pytest、浏览器集成测试、恶意网页样本和 HTTP 失败模拟。

## 6. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T6-AC-01 | 真实访问网页 | 让用户/市场 PM 执行一次竞品调研 | 产生真实访问记录、来源元数据、引用证据和调研报告。 |
| T6-AC-02 | 官方功能结论 | 使用官方功能页支持客观功能 | 来源与结论直接对应，不扩展成效果/优越性结论。 |
| T6-AC-03 | 方向性结论 | 只提供一个来源提交市场/竞品判断 | 提交被拒绝或标记为待验证假设，不能进入 Boss 审批。 |
| T6-AC-04 | 独立来源 | 提供不同组织的两个来源和同稿转载 | 只有两个独立来源计入规则，转载不重复计数。 |
| T6-AC-05 | 第二位 PM 核验 | 让另一位 PM 检查来源可访问性、支持度和独立性 | 核验结果、冲突和判断理由被保留，不能覆盖原始来源。 |
| T6-AC-06 | 成功指标 | PM 创建指标并交叉评审 | 名称、目标值、口径、验证方式、负责人和评审关联完整。 |
| T6-AC-07 | 提示注入 | 网页包含越权指令 | 指令不执行、不改变角色/权限/流程，生成脱敏安全事件。 |
| T6-AC-08 | 外部服务失败 | 模拟浏览器启动失败、超时、HTTP 错误 | 当前调研任务可解释阻塞，已保存数据不丢失。 |
| T6-AC-09 | Boss PRD 审批前置 | 删除成功指标或关键来源后提交审批 | PRD 不能进入 Boss 审批，并说明缺失对象。 |
| T6-AC-10 | 追踪链 | 从结论打开来源、报告、PRD 和 PM 评审 | 所有对象可双向定位到同一项目/任务/事件。 |

验收证据包括：浏览器访问记录、来源 JSON、页面哈希、引用 Artifact、PM 核验记录、提示注入事件、PRD 版本和审批前校验结果。

## 7. 完成定义与交接

- ResearchGrant、来源对象、结论校验和 PM 交叉评审接口冻结。
- 证据不足的方向结论无法进入 Boss 审批。
- 网页提示注入不能改变角色、流程和工具权限。
- task8.md 可以使用 PRD/成功指标/验收标准生成测试策略，task9.md 可以展示来源、报告、交叉评审和审批证据，task10.md 可以统计调研调用和安全事件。
- 所有真实网页访问和模型调用都有脱敏、事件和 Artifact 证据。
