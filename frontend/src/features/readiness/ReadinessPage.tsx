import { useCallback, useEffect, useState } from "react";
import { fetchReadiness } from "../../api/readiness";
import type { ReadinessView } from "./readiness.types";
import { ReadinessCard } from "./ReadinessCard";

// 展示后端 readiness 事实，并将未就绪状态转换为不可执行的界面状态。
export function ReadinessPage() {
  // 运行准备页面只展示后端事实，并把 blocked/degraded 状态传递为不可执行。
  const [view, setView] = useState<ReadinessView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 重新检查时清除旧错误，避免把上一次失败误认为当前状态。
  const refresh = useCallback(async () => {
    setError(null);
    try {
      setView(await fetchReadiness());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取运行准备状态");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 修改说明：后端 blocked/degraded 或未授权时必须禁用启动，不能由 Renderer 绕过 StartupGate。
  const blocked = !view || view.status !== "ready" || !view.allowedActions.includes("create_project");

  return (
    <main>
      <header>
        <p className="eyebrow">Digital Harness</p>
        <h1>运行准备</h1>
        <p>启动 Digital Harness 前，请先确认模型、调研、工作区、容器和数据保存能力。</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {view && (
        <>
          <section aria-label="总体状态">
            <strong>总体状态：{view.status}</strong>
            <small>检查时间：{view.checkedAt}</small>
          </section>
          <section aria-label="准备检查">
            {Object.entries(view.checks).map(([name, check]) => (
              <ReadinessCard key={name} name={name} check={check} />
            ))}
          </section>
          <p className="trace">诊断链路：{view.traceId}</p>
        </>
      )}
      <div className="actions">
        <button type="button" onClick={() => void refresh()}>重新检查</button>
        <button type="button" disabled={blocked}>启动 Digital Harness</button>
      </div>
    </main>
  );
}
