# Task 9：Boss 业务控制台、通知、审批与历史存档

> 任务编号：DEV-09
> 任务状态：待开发
> 任务类型：React 业务界面、查询投影、Boss 操作和历史存档
> 前置任务：task2.md、task4.md、task5.md、task6.md、task8.md
> 后续消费者：task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

提供面向 Boss 的主要业务界面，使不具备产品或研发背景的用户能够完成首次引导、运行准备、立项、审批、项目监督、暂停/恢复/终止、通知处理、模型配置和历史只读复盘。

本任务的页面必须展示持久化业务状态，不得使用装饰性动画或前端本地状态伪造项目进度。前端只能通过 REST Command/Query 和 SSE 与后端通信，不直连数据库、Docker、模型或工作区。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §3：Boss 用户职责和核心场景。
- PRD §6.2～§6.4：引导、立项、审批、暂停/恢复/终止。
- PRD §7.1、§7.2、§7.4、§7.6、§7.8：看板、通知、调用控制台入口、模型设置和历史存档。
- PRD §8.2：可理解性、错误、空状态和桌面视口。
- 对应 AC-01～AC-13、AC-16、AC-17、AC-19～AC-25。

### 2.2 需求矩阵

- SR-INI-001～008；
- SR-DSH-001～010；
- SR-NTF-001～007；
- SR-APR-001～008；
- SR-MDL-001～007；
- SR-ARC-001～008；
- SR-UX-001～006；
- SR-SEC-006/007/012；
- AS-01～AS-03、AS-07～AS-12、AS-14、AS-16。

### 2.3 概要设计

- 总体设计 A1～A3、A6、B1～B4、§5.1、§5.3、§7.2～§7.3、§7.8、§9.2。
- React 18、TypeScript、Vite、Ant Design、TanStack Query、React State/Zustand、REST/SSE。
- task2.md 提供读模型、事件和证据；
- task4.md 提供项目命令、审批、状态和错误；
- task5.md 提供模型设置；
- task6.md/task8.md 提供业务交付物、测试、缺陷和 PM 证据。

## 3. 具体交付物

### 3.1 建议前端目录

~~~text
frontend/src/app/router.tsx
frontend/src/app/queryClient.ts
frontend/src/api/client.ts
frontend/src/api/sse.ts
frontend/src/features/onboarding/
frontend/src/features/readiness/
frontend/src/features/project-initiation/
frontend/src/features/dashboard/
frontend/src/features/approvals/
frontend/src/features/notifications/
frontend/src/features/model-settings/
frontend/src/features/archive/
frontend/src/features/tasks/
frontend/src/features/artifacts/
frontend/src/components/status/
frontend/src/components/evidence/
frontend/src/components/next-action/
frontend/src/components/terms/
tests/frontend/unit/
tests/frontend/integration/
tests/frontend/e2e/
~~~

### 3.2 页面和路由

至少提供：

~~~text
/onboarding
/readiness
/projects/new
/projects/:projectId/dashboard
/projects/:projectId/approvals
/projects/:projectId/notifications
/projects/:projectId/tasks/:taskId
/projects/:projectId/artifacts/:artifactId
/settings/models
/archive
/archive/:projectId
~~~

### 3.3 首次引导

必须用非技术化语言说明：

- 数字公司有哪些部门和岗位；
- 项目会经历哪些阶段；
- 哪些工作自动执行；
- 哪些情况需要 Boss；
- 可能产生哪些模型调用；
- 可能发生哪些本地代码变更；
- 运行准备状态和缺失项如何处理。

首次引导不能要求 Boss 先理解 Agent、模型、工作区或代码仓库术语。

### 3.4 立项页面

立项表单必须包含：

- 项目名称；
- 业务目标；
- 目标用户；
- P0/P1/P2/P3 优先级；
- 截止时间；
- 已知约束。

不包含：

- 技术方案；
- 成员级任务拆解；
- 强制项目成功指标输入。

确认页必须展示项目摘要、预计参与部门和首个执行阶段。只有 Boss 明确确认启动后才提交真实启动命令。

### 3.5 看板

看板必须显示：

- 项目名称、目标、用户、优先级、截止时间和当前阶段；
- 各阶段状态和整体进度；
- 当前员工、任务、完成比例、开始时间和等待对象；
- 待审批、重大风险和系统异常；
- 任务总数、完成数、返工数、缺陷数、未关闭缺陷数；
- 最新交付物、事件和下一步动作；
- 模型调用次数、耗时、错误、Token 和成本摘要；
- 暂停、恢复、终止控制。

所有卡片都必须可以跳到对应任务、员工、交付物、审批、风险或事件详情。

### 3.6 通知和审批

通知类型：

- 待审批；
- 重大风险；
- 系统异常；
- 任务阻塞；
- 重要期限风险；
- 项目结项；
- 项目终止。

审批/风险页面必须按以下顺序组织：

~~~text
发生了什么
→ 为什么需要 Boss
→ 依据是什么
→ Boss 可以做什么
→ 之后会怎样
~~~

影响流程的通知在完成审批、确认或处理动作前不能因为打开而关闭。

### 3.7 历史存档

历史表显示：

- 项目名称、最终状态、优先级；
- 创建/结束时间、运行时长；
- 最终评估结果；
- 缺陷概况；
- 模型成本摘要；
- 操作入口。

重新打开只能只读查看。删除必须展示项目名称、状态、结束时间、删除范围和不可恢复提示，并完成第二次明确确认。

## 4. 接口设计

### 4.1 API 客户端边界

前端只使用：

~~~text
REST Command：写入业务命令，返回 CommandResult
REST Query：查询 ReadModel、证据和详情
SSE：接收已经提交的 DomainEvent 和读模型刷新提示
~~~

错误响应统一显示：

- 发生了什么；
- 是否暂停；
- 数据是否保留；
- 用户下一步；
- traceId 或可供支持人员定位的引用。

### 4.2 主要查询接口

~~~http
GET /api/v1/readiness
GET /api/v1/projects/{id}/dashboard
GET /api/v1/approvals/{id}
GET /api/v1/notifications
GET /api/v1/projects/{id}/tasks
GET /api/v1/projects/{id}/artifacts
GET /api/v1/projects/{id}/events
GET /api/v1/settings/models
GET /api/v1/archive
GET /api/v1/archive/{projectId}
~~~

### 4.3 主要写命令

~~~http
POST /api/v1/projects
POST /api/v1/projects/{id}/start
POST /api/v1/projects/{id}/pause
POST /api/v1/projects/{id}/resume
POST /api/v1/projects/{id}/terminate/preview
POST /api/v1/projects/{id}/terminate/confirm
POST /api/v1/approvals/{id}/decision
POST /api/v1/notifications/{id}/acknowledge
POST /api/v1/archive/{projectId}/delete/preview
POST /api/v1/archive/{projectId}/delete/confirm
~~~

所有写命令都携带 idempotencyKey 和 expectedVersion，页面重复点击不能产生重复对象或重复状态。

### 4.4 SSE 更新

~~~text
GET /api/v1/events?after={eventId}
Content-Type: text/event-stream
~~~

TanStack Query 收到事件后只做对应查询失效和重新读取，不直接用事件内容绕过后端状态规则。SSE 断线后使用 Last-Event-ID 或 after 游标补齐，不能把断线期间的事件当作丢失。

## 5. 开发实施方法

1. 先建立 API client、Query key、Command result、Error result 和 SSE 连接管理。
2. 先写关键页面的空状态、加载状态、错误状态、阻塞状态和已完成状态测试。
3. 实现首次引导和运行准备，验证启动前不产生真实执行。
4. 实现立项、启动预览和确认，接入 task4.md。
5. 实现看板和任务/交付物/事件详情，接入 task2.md 的读模型。
6. 实现审批/风险/通知闭环，验证通知已读不能代替业务处理。
7. 实现模型设置，接入 task5.md，并确保没有密钥渲染。
8. 实现历史存档、只读复盘和二次确认删除。
9. 使用 1280×720、1440×900 和非专业用户理解任务做 E2E。

需要使用：

- React 18、TypeScript、Vite；
- Ant Design；
- TanStack Query；
- React State 或 Zustand；
- REST、SSE；
- Playwright/Cypress 类浏览器 E2E；
- 前端单元测试和可访问性检查。

## 6. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T9-AC-01 | 首次引导 | 清空本地状态首次打开 | 组织、岗位、流程、人工介入、模型调用、代码变更和准备状态均有说明。 |
| T9-AC-02 | 立项校验 | 缺少任一必填项提交 | 提交被阻止，页面指出字段和影响；没有真实执行事件。 |
| T9-AC-03 | 启动确认 | 观察预览页后取消/确认 | 取消无真实调用；确认才创建启动事件和首个任务。 |
| T9-AC-04 | 看板一致性 | 后端改变项目状态并刷新页面 | 看板显示持久化状态，阶段、员工、任务、风险、下一步与查询结果一致。 |
| T9-AC-05 | 通知闭环 | 生成审批、重大风险、阻塞和系统异常 | 通知字段完整，未处理通知不会因打开自动关闭。 |
| T9-AC-06 | 审批 | 提交通过、空意见驳回、有效意见驳回 | 通过可推进；空意见拒绝；有效意见形成责任组长任务和响应记录。 |
| T9-AC-07 | 暂停/恢复/终止 | 点击各控制并重复点击 | 合法状态可操作，非法状态解释原因；终止需要原因和二次确认。 |
| T9-AC-08 | 模型设置 | 保存五领域模型、删除凭据、连接失败 | 配置状态可见但密钥不可见；失败任务可解释阻塞。 |
| T9-AC-09 | 历史查看 | 结项/终止后重新打开历史项目 | 只能查看，不能启动、修改、审批、暂停、恢复或终止。 |
| T9-AC-10 | 历史删除 | 第一次删除、取消、第二次确认 | 删除范围和不可恢复性明确；只保留最小删除审计。 |
| T9-AC-11 | SSE 断线 | 断开连接后产生事件再重连 | 使用游标补齐状态，不重复或遗漏已提交事件。 |
| T9-AC-12 | 桌面可用性 | 在 1280×720 和 1440×900 走主流程 | 关键控件不遮挡，业务主视图不要求横向滚动。 |
| T9-AC-13 | 非专业用户理解性 | Boss 和至少两名非研发/产品体验者完成理解任务 | 每人六项任务至少完成五项，当前阶段/待办/下一步必须完成。 |
| T9-AC-14 | 敏感信息 | 注入 Key、隐藏提示词和敏感输出 | 所有用户可见页面无明文泄露。 |

验收证据包括：浏览器录制/截图、API 请求和响应、SSE 游标、页面状态截图、理解性任务结果、错误提示和敏感信息扫描。

## 7. 完成定义与交接

- Boss 可以从首次进入走到启动、审批、暂停/恢复/终止和历史只读查看。
- 看板、通知、审批和历史数据来自持久化事实源，并能跳转到同一任务、交付物、风险、审批和事件。
- 通知到审批/确认/处理/事件/状态变化形成闭环。
- 页面在目标桌面视口可用，非专业用户能识别阶段、待办、阻塞原因和下一步。
- task10.md 可以直接复用 API client、SSE、Office/Console 入口和业务对象详情路由。
