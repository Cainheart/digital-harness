# Task 5：模型配置、凭据保护与真实调用网关

> 任务编号：DEV-05
> 任务状态：待开发
> 任务类型：模型配置、外部调用、凭据、安全、观测
> 前置任务：task1.md、task2.md、task3.md
> 后续消费者：task6.md、task7.md、task9.md、task10.md
> 代码开发准则：[代码开发准则](../code-development-guidelines.md)

## 1. 任务目标

实现 V1 对 OpenAI 和 DeepSeek 的真实模型配置和调用能力，并保证五个员工领域的配置独立、配置变更可追踪、执行中的 Attempt 固化旧配置、凭据不泄露、模型失败可解释阻塞、调用数据可观测。

本任务只负责模型网关和配置，不负责 PM 结论、编码 Agent 动作、审批决定或项目状态推进。

## 2. 上游依据与设计一致性

### 2.1 PRD

- PRD §7.4：真实调用控制台的字段和脱敏要求。
- PRD §7.6：OpenAI/DeepSeek、五领域配置、运行中切换和凭据处理。
- PRD §7.7、§8.3、§8.4：真实模型、外部服务失败和数据安全。
- 对应 AC-16、AC-17、AC-25。

### 2.2 需求矩阵

- IF-LLM-001/002；
- SR-MDL-001～007；
- SR-OBS-002/003/004/005/006；
- SR-SEC-002/003/006/011；
- SR-REL-003、SR-EVL-008；
- AS-01、AS-02、AS-09、AS-13、AS-16、AS-17。

### 2.3 概要设计

- 总体设计 §2.3、§3.2、D3、E3/E4、§9.3/§9.6：LiteLLM/Adapter、Keychain、调用记录、OpenTelemetry 和脱敏。
- BIMA §3.3、§6.4、§13～§14：Model Adapter、modelConfigVersion、观测和凭据流。

## 3. 具体交付物

### 3.1 建议代码目录

~~~text
backend/app/domain/model_config/
backend/app/application/model_settings.py
backend/app/gateway/model/
backend/app/gateway/model/openai_adapter.py
backend/app/gateway/model/deepseek_adapter.py
backend/app/gateway/model/usage.py
backend/app/infra/keychain.py
backend/app/observability/redaction.py
backend/app/api/model_settings.py
tests/unit/model_gateway/
tests/integration/model_gateway/
tests/security/credentials/
~~~

### 3.2 配置模型

五个领域必须独立保存：

~~~text
product
development
npi
testing
project_management
~~~

配置对象：

~~~json
{
  "domain": "development",
  "provider": "openai",
  "modelName": "configured-model",
  "configVersion": 7,
  "secretRef": "keychain://openai/development",
  "connectionStatus": "ready",
  "updatedAt": "2026-08-12T10:20:30Z"
}
~~~

数据库不得保存 API Key；secretRef 不能通过前端、员工上下文、交付物、消息、日志、事件或历史项目还原出明文。

### 3.3 模型调用记录

每次调用保存：

- modelCallId、projectId、taskId、attemptId；
- domain、role、provider、modelName、configVersion；
- 开始/结束时间、耗时、超时、重试次数；
- 输入摘要、结构化输出摘要、错误分类；
- prompt/input token、output token、总 Token、成本；
- traceId、spanId、Artifact 引用；
- 脱敏记录和调用最终状态。

输入和输出只能保存经过摘要和脱敏的数据，不能保存完整隐藏提示词和内部思维过程。

## 4. 接口设计

### 4.1 模型设置 API

建议提供：

~~~http
GET    /api/v1/settings/models
PUT    /api/v1/settings/models/{domain}
POST   /api/v1/settings/models/{domain}/connection-test
DELETE /api/v1/settings/models/{domain}/credential
~~~

保存请求：

~~~json
{
  "provider": "deepseek",
  "modelName": "configured-model",
  "credential": "only-in-request-body",
  "expectedConfigVersion": 6,
  "idempotencyKey": "model-config-development-v7"
}
~~~

响应只能返回：

~~~json
{
  "domain": "development",
  "provider": "deepseek",
  "modelName": "configured-model",
  "configVersion": 7,
  "credentialStatus": "configured",
  "connectionStatus": "ready",
  "updatedAt": "2026-08-12T10:20:30Z"
}
~~~

不能返回 credential、secretRef 明文、原始错误响应或模型系统提示词。

### 4.2 Model Adapter

~~~typescript
class ModelAdapter(Protocol):
    async def complete(
        self,
        request: StructuredModelRequest,
        config: FrozenModelConfig,
        trace: TraceContext,
    ) -> StructuredModelResponse: ...

    async def check_connection(
        self,
        config: ModelConfig,
        trace: TraceContext,
    ) -> ConnectionCheckResult: ...
~~~

FrozenModelConfig 在 Attempt 创建时生成，包含 provider、modelName、configVersion、secretRef 引用、超时和重试策略。运行中的配置变化不能修改当前 Frozen 配置。

### 4.3 错误和阻塞

模型网关必须将错误归一为：

- CREDENTIAL_UNAVAILABLE；
- AUTHENTICATION_FAILED；
- RATE_LIMITED；
- TIMEOUT；
- PROVIDER_UNAVAILABLE；
- INVALID_STRUCTURED_OUTPUT；
- REDACTION_FAILED；
- UNKNOWN_PROVIDER_ERROR。

凭据错误、脱敏失败和结构化输出不合格必须阻塞当前任务，不得静默切换供应商或把错误伪装成模型结果。

### 4.4 用量和调用查询

内部记录接口：

~~~typescript
class ModelCallRecorder(Protocol):
    async def started(self, call: ModelCallStart) -> CallHandle: ...
    async def finished(self, handle: CallHandle, result: ModelCallResult) -> None: ...
    async def failed(self, handle: CallHandle, error: NormalizedModelError) -> None: ...
~~~

调用控制台后续通过：

~~~http
GET /api/v1/executions?projectId={id}&taskId={id}&traceId={id}
~~~

查询结果必须和业务任务、Attempt、事件和 Artifact 双向关联。

## 5. 开发实施方法

1. 先实现配置 Schema、Keychain 适配器和“明文不落盘”测试。
2. 实现 OpenAI/DeepSeek Adapter 的统一请求/响应 Schema，不让业务层依赖供应商特有字段。
3. 实现配置版本冻结：创建 Attempt 时复制 modelConfigVersion，后续修改只影响下一 Attempt。
4. 实现连接检测、更新、删除和不可用阻塞。
5. 实现调用记录器、用量/成本计算、错误归一化和脱敏。
6. 将 Model Adapter 接给 task6.md 的 Research Adapter 和 task7.md 的 NativeCodingHarness。
7. 使用模拟供应商做单元/集成测试，再用真实配置做受控连接测试；测试报告不得写入真实密钥。

需要使用：

- LiteLLM 或可替换 Model Adapter；
- OpenAI/DeepSeek 适配；
- TypeScript Promise/Worker、TypeBox；
- OS Keychain/TypeScript CredentialAdapter；
- OpenTelemetry、结构化 JSON Log；
- Vitest、供应商模拟服务、脱敏扫描和成本计算测试。

## 6. 验收标准与验收方法

| 验收编号 | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T5-AC-01 | 五领域配置 | 分别保存五个领域的 provider/model | 每个领域独立保存，同领域员工继承正确。 |
| T5-AC-02 | OpenAI/DeepSeek 连接 | 对两个供应商执行连接检测 | 成功/失败有明确状态和错误；不返回密钥。 |
| T5-AC-03 | 运行中切换 | Attempt A 启动后修改领域配置，再启动 Attempt B | A 使用旧版本，B 使用新版本，任务和交付物可追溯配置版本。 |
| T5-AC-04 | 凭据删除 | 删除领域凭据后启动任务 | 任务进入可解释阻塞，不静默切换。 |
| T5-AC-05 | 凭据泄露 | 将假 API Key 放入配置、错误、模型输出和日志路径 | UI、数据库、上下文、Artifact、消息、日志和历史都无明文。 |
| T5-AC-06 | 结构化输出错误 | 供应商返回不符合 Schema 的输出 | 调用失败并阻塞/重试，不把原始输出作为业务事实。 |
| T5-AC-07 | 供应商失败 | 模拟超时、限流和不可用 | 错误被归一化，已有业务数据保留，通知/事件可追踪。 |
| T5-AC-08 | 调用链路 | 完成一次模型调用 | 能从任务跳到模型调用，再返回任务，Token、成本、耗时和 trace 一致。 |
| T5-AC-09 | 脱敏失败 | 让脱敏器返回失败 | 调用被阻止，敏感内容不写入下游 Artifact/日志。 |
| T5-AC-10 | 成本聚合 | 执行多个领域/模型调用 | 按领域、模型、任务统计次数、耗时、错误、Token、成本和重试。 |
| T5-AC-COMMIT | 分支、验收与开发完成提交 | Task 开发、测试和文档完成后检查 `git branch --show-current`、`git log`、提交哈希和工作区状态 | Task 5 在从最新 `master` 创建的 `dev/task-5` 分支上完成；已创建完成提交，提交哈希已写入验收证据；验收和 Review 成功后才合并到 `master`，并记录合并提交哈希。 |

验收证据包括：配置版本、连接测试结果、调用记录、错误分类、脱敏扫描、Keychain 测试替身记录、成本聚合和双向跳转结果。

## 7. 完成定义与交接

- 开发结束时已在 `dev/task-5` 分支创建一次可识别的 Task 5 完成提交，提交哈希已记录在验收证据中，相关工作区无未提交变更；验收和 Review 成功后才允许合并到 `master`，并记录合并提交哈希。
- 五领域模型配置和配置版本接口冻结。
- Model Adapter 能返回结构化结果和统一错误，不直接推进业务状态。
- task6.md 可用真实模型生成调研材料，task7.md 可用真实模型生成 Plan/Action，task9.md 可查询配置状态，task10.md 可聚合调用和成本。
- 凭据、隐藏提示词、内部思维过程和未脱敏输入输出的泄露测试必须通过。
- 外部服务失败时数据保留和任务阻塞行为必须由自动化测试证明。
