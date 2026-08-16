import type { CheckView } from "./readiness.types";

// 后端使用稳定的检查键，页面在这里映射为面向 Boss 的中文名称。
const labels: Record<string, string> = {
  model: "模型服务",
  research: "公开资料调研",
  workspace: "本地项目工作区",
  docker: "容器执行环境",
  persistence: "持久化与数据库",
};

/** 将机器状态翻译为 Boss 可直接理解的展示文本。 */
const statusLabels: Record<CheckView["status"], string> = {
  ready: "可用",
  blocked: "不可用",
  degraded: "受限",
};

/** 只渲染后端提供的状态、影响和下一步，不推断或伪造依赖状态。 */
export function ReadinessCard({
  name,
  check,
}: {
  name: string;
  check: CheckView;
}) {
  const label = labels[name] ?? name;

  return (
    <article className={`readiness-card ${check.status}`}>
      <div className="card-heading">
        <h2>{label}</h2>
        <span aria-label={`状态：${statusLabels[check.status]}`}>
          {statusLabels[check.status]}
        </span>
      </div>
      <p>{check.message}</p>
      {check.impact && <p className="impact">影响：{check.impact}</p>}
      {check.nextAction && (
        <p className="next-action">下一步：{check.nextAction}</p>
      )}
    </article>
  );
}
