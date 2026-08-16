# 代码开发准则

> 适用范围：`backend/`、`frontend/` 以及 `docs/task/` 中所有任务的代码开发、代码修改和代码评审。
> 当前生效版本：V1

## 1. 目的

本准则用于保证代码的职责、边界和变更原因能够被后续开发者快速理解，并让代码实现与 PRD、需求矩阵、概要设计和 Task 验收标准保持可追踪。

## 2. TypeScript 优先的实现语言规范

本项目主要使用 TypeScript 开发。项目级目标是让 TypeScript 占生产源代码的 95% 以上，在工程成熟和依赖稳定后尽量达到 98% 以上。新建或重写代码时，只要 TypeScript 能够满足功能、平台、性能和安全要求，就必须使用 TypeScript；适用范围包括前端、Electron Main/Preload/Renderer、共享类型与接口、应用编排、工具、开发脚本和测试。

只有在 TypeScript 无法满足要求，或平台/运行时强制要求、必须依赖成熟且暂无等价替代的其他语言生态、原生库或性能能力时，才允许使用其他语言。不得因为个人熟悉度、短期编码便利或缺少类型建模而选择其他语言。每个非 TypeScript 实现都必须在对应的详细设计或 Task 中说明选择原因、职责边界、接口契约以及后续替换或收敛策略，并限制其向相邻模块扩散。

当前 V1 的后端控制面、流程编排、执行面和桌面 sidecar 均统一采用 Node.js/TypeScript 方案，包括 Fastify、TypeBox、LangGraph.js、TypeScript Worker、Drizzle ORM 和 TypeScript Model Adapter。`frontend/`、Electron、共享协议、工程工具和测试代码同样必须保持 TypeScript 优先；如果后续出现非 TypeScript 的实现候选，仍须按本节的必要性、边界和收敛要求单独评审。

## 3. 必须遵守的注释规则

### 3.1 新建或重写代码

新建或重写代码时，必须对对应的函数、方法、类、接口、类型和常量定义添加简洁明了的注释说明。

注释至少说明以下信息中的必要部分：

- 代码负责什么职责；
- 输入、输出或关键约束是什么；
- 为什么存在特殊的安全、持久化、生命周期或兼容性处理。

推荐使用语言原生的文档注释形式：

```typescript
/** 检查数据库版本，拒绝不兼容版本的可写启动。 */
export function checkSchema(...): SchemaCheckResult {
  ...
}
```

```typescript
// 从控制面读取最新 readiness，页面不直接访问 Docker 或文件系统。
export async function fetchReadiness(): Promise<ReadinessView> {
  ...
}
```

常量也必须说明其业务含义、取值边界或被哪些策略消费。例如 Schema revision、默认本机地址、超时时间、状态映射表等不能只留下没有解释的字面量。

### 3.2 修复 Bug 或处理其他问题

后续如果因为 Bug、需求变更、兼容性问题、安全问题、性能问题或运行环境问题修改代码，必须在实际修改位置附近添加“修改说明”备注。每一处问题修复或问题处理都必须同时写明实际修改日期和修改原因，不能只在提交信息、Issue 或任务总结中补充，避免代码脱离上下文后无法追溯。

备注必须使用具体日期，日期格式统一为 `YYYY-MM-DD`，不得写“今天”“最近”或其他不明确的时间表达；同时必须解释为什么需要修改，不要只重复代码做了什么。如果同一处代码再次因为新的问题被修改，应更新日期和原因，保留仍然有效的历史背景。推荐格式：

```typescript
// 修改日期：2026-08-16
// 修改原因：Docker Desktop 在 macOS 上可能不把 CLI 放入 PATH，
// 因此保留应用安装目录回退路径，避免 readiness 错误判定 Engine 不可用。
const dockerCliPath = resolveDockerCliPathWithFallback();
```

```typescript
// 修改日期：2026-08-16
// 修改原因：后端 blocked 时必须保持启动按钮禁用，避免前端绕过 StartupGate 发起真实执行。
const blocked = ...;
```

如果修改涉及明确的 PRD、需求矩阵、验收标准或缺陷编号，应在备注中同时写出对应编号；如果没有编号，至少写清楚触发条件和要保护的行为。上面的 `2026-08-16` 仅用于展示格式，实际代码备注必须替换为该次真实修改发生的日期。

### 3.3 注释质量要求

- 注释要短、准确、与代码保持同步。
- 不为显而易见的语法重复写无价值注释。
- 不把实现细节写成与实际行为不一致的承诺。
- 不在注释中写入 API Key、Cookie、Token、个人隐私或其他敏感信息。
- 代码重构后必须同步更新原注释；失效注释应删除。
- 关键安全边界、持久化边界、进程边界和人工审批边界必须优先保留注释。

## 4. 对各 Task 的执行要求

`docs/task/task1.md` 至 `docs/task/task11.md` 的代码开发都必须遵循本准则：

1. 开发前先确认修改对应的 Task、PRD 条款、需求矩阵需求和验收标准。
2. 新建或重写函数、方法、类、接口、类型和常量时，先写清职责注释，再提交实现。
3. 修复问题时，在实际修改位置附近添加包含实际修改日期（`YYYY-MM-DD`）和明确修改原因的“修改说明”备注，并在任务验收证据中记录触发条件和验证结果。
4. 注释变更不得替代自动化测试；行为变化仍然必须补充或更新测试。
5. 代码评审时检查“新增代码有职责注释”和“问题修复有包含修改日期与修改原因的备注”两项。
6. 开始开发一个 Task 前，必须基于最新的 `master` 创建该 Task 的独立分支，统一命名为 `dev/task-N`，例如 Task 1 使用 `dev/task-1`；禁止直接在 `master` 上开发 Task。
7. 该 Task 的代码、测试、文档修改和完成提交都必须发生在对应的 `dev/task-N` 分支上，并将分支推送到远程仓库供验收和 Review。
8. 只有当该分支的 Task 验收通过且 Review 成功后，才允许将其合并到 `master`；验收或 Review 未通过时不得合并，修复必须继续提交到同一个 `dev/task-N` 分支。
9. 合并到 `master` 后，必须在 Task 交付证据中记录分支名、完成提交哈希、Review 结果和合并提交哈希；`master` 只接受已验收、已 Review 的 Task 合并。

标准分支流程如下，`N` 替换为当前 Task 编号：

```bash
git switch master
git pull --ff-only origin master
git switch -c dev/task-N

# 在 dev/task-N 上开发、测试并提交
git add <task-files>
git commit -m "feat(task-N): complete task implementation"
git push -u origin dev/task-N

# 验收和 Review 成功后，才允许合并到 master
git switch master
git pull --ff-only origin master
git merge --no-ff dev/task-N
git push origin master
```

Task 1 的既有实现已按本准则补充基础注释。后续 DEV-02～DEV-11 的实现、重构和问题修复均以本文件为强制开发约束。

## 5. 提交前检查清单

- [ ] 新增或重写代码默认使用 TypeScript；非 TypeScript 实现有明确的必要性说明、边界和后续策略。
- [ ] TypeScript 优先原则没有因个人熟悉度或短期编码便利被绕过。
- [ ] 每个 Bug 或问题修复点附近都有“修改说明”备注，且备注注明实际修改日期（`YYYY-MM-DD`）和明确的修改原因。
- [ ] 新增或重写的函数、方法、类、接口、类型和常量都有简洁注释。
- [ ] 注释没有泄露敏感信息，且没有与实际行为冲突。
- [ ] 相关测试已新增或更新，并且测试失败原因和通过结果可解释。
- [ ] 变更已对齐对应 Task、PRD、需求矩阵和验收标准。
- [ ] 当前 Task 的开发发生在从最新 `master` 创建的 `dev/task-N` 分支上，没有直接在 `master` 开发。
- [ ] Task 完成提交、验收结果、Review 结果和合并到 `master` 的记录均已留存。
- [ ] 只有验收和 Review 成功后的 Task 分支才被合并到 `master`。
- [ ] 文档、注释、测试和实现没有互相矛盾。
