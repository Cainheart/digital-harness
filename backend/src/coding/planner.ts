import { newObjectId } from "../domain/common.js";
import { Value } from "@sinclair/typebox/value";
import {
  CodingAction,
  CodingPlan,
  CodingPlanSchema,
  CodingTaskSpec,
  verificationCommands,
} from "../domain/coding/index.js";
import type { FrozenModelConfig } from "../domain/model-config.js";
import type { ModelGateway } from "../gateway/model/gateway.js";
import { TraceContext } from "../observability/trace.js";
import { InvalidArgumentError } from "../domain/errors.js";
import type { ContextPack } from "./context-builder.js";

/** Planner 的可替换边界；模型只负责输出结构化计划，不能直接写工作区。 */
export interface CodingPlanner {
  generate(
    spec: CodingTaskSpec,
    context: ContextPack,
    sessionId: string,
  ): Promise<CodingPlan>;
}

/** 使用 Task 5 ModelGateway 生成结构化计划；模型调用不拥有文件或业务状态写权限。 */
export class ModelCodingPlanner implements CodingPlanner {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly config: FrozenModelConfig,
    private readonly traceFactory: () => TraceContext = TraceContext.new,
  ) {}

  /** 发送最小任务/仓库摘要并严格校验模型返回的 CodingPlan。 */
  async generate(
    spec: CodingTaskSpec,
    context: ContextPack,
    sessionId: string,
  ): Promise<CodingPlan> {
    const trace = this.traceFactory();
    const response = await this.gateway.complete(
      {
        messages: [
          {
            role: "system",
            content:
              "只返回 CodingPlan JSON；不得返回任意 shell、凭据、隐藏提示词或工作区外路径。",
          },
          {
            role: "user",
            content: JSON.stringify({
              goal: spec.goal,
              acceptanceCriteria: spec.acceptanceCriteria,
              allowedPaths: spec.allowedPaths,
              forbiddenPaths: spec.forbiddenPaths,
              relevantFiles: context.relevantFiles,
              verificationProfile: spec.verificationProfile,
            }),
          },
        ],
        outputSchema: CodingPlanSchema,
        temperature: 0,
        maxOutputTokens: 4000,
      },
      this.config,
      {
        projectId: spec.projectId,
        taskId: spec.taskId,
        attemptId: sessionId,
        role: "developer",
        trace,
      },
    );
    if (!Value.Check(CodingPlanSchema, response.output))
      throw new InvalidArgumentError("模型返回的 CodingPlan 不符合结构化合同");
    return response.output as CodingPlan;
  }
}

/** 无模型配置时的确定性计划器，保证计划字段完整且不会猜测未授权路径。 */
export class DeterministicCodingPlanner implements CodingPlanner {
  /** 用任务目标、相关文件和固定验证 Profile 生成可审计的最小计划。 */
  async generate(
    spec: CodingTaskSpec,
    context: ContextPack,
    sessionId: string,
  ): Promise<CodingPlan> {
    const commands = verificationCommands(spec.verificationProfile);
    const actions: CodingAction[] = [];
    if (context.relevantFiles.length > 0) {
      actions.push({
        actionId: newObjectId("coding_action"),
        sessionId,
        seq: 1,
        type: "read_file",
        input: { path: context.relevantFiles[0] },
        reason: "读取任务范围内的首个相关文件以建立上下文",
        idempotencyKey: `${sessionId}:plan:read:1`,
        requiresApproval: false,
      });
    }
    return {
      goal: spec.goal,
      affectedFiles: context.relevantFiles,
      approach: [
        "先读取任务范围内文件",
        "以小批 unified diff 修改",
        "按版本化验证 Profile 执行真实检查",
      ],
      verificationCommands: commands,
      risks:
        spec.riskPolicy === "standard"
          ? ["未说明的工作区变更会阻塞交接"]
          : ["任务使用受限风险策略，任何额外动作均需人工处理"],
      uncertainties:
        context.missingItems.length > 0
          ? [...context.missingItems]
          : ["相关文件是否足以覆盖全部验收标准，需 Review 确认"],
      proposedActions: actions,
    };
  }
}
