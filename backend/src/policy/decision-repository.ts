import BetterSqlite3 from "better-sqlite3";
import { PolicyDecision } from "./types.js";
import { jsonText } from "../infra/repositories/common.js";

/** 把 Policy Gate 结果保存为可按项目、任务和岗位版本查询的审计记录。 */
export class PolicyDecisionRepository {
  /** 写入一条不可覆盖的策略判断。 */
  save(
    connection: BetterSqlite3.Database,
    decision: PolicyDecision,
    context: {
      projectId?: string | null;
      taskId?: string | null;
      attemptId?: string | null;
    } = {},
  ): void {
    connection
      .prepare(
        "INSERT INTO policy_decisions (decision_id,project_id,task_id,attempt_id,role_id,role_version,action_kind,object_type,object_id,tool_name,decision,reason,risk_level,trace_id,action_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        decision.decisionId,
        context.projectId ?? null,
        context.taskId ?? null,
        context.attemptId ?? null,
        decision.roleId,
        decision.roleVersion,
        decision.action.kind,
        decision.action.objectType ?? null,
        decision.action.objectId ?? null,
        decision.action.toolName ?? null,
        decision.decision,
        decision.reason,
        decision.riskLevel,
        decision.traceId,
        jsonText(decision.action),
        decision.createdAt,
      );
  }
}
