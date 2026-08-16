import { useCallback, useEffect, useRef, useState } from "react";
import { fetchReadiness } from "../../api/readiness";
import type { ReadinessView } from "./readiness.types";
import { ReadinessCard } from "./ReadinessCard";

/** 展示后端 readiness 事实，并将未就绪状态转换为不可执行的界面状态。 */
export function ReadinessPage() {
  // 运行准备页面只展示后端事实，并把 blocked/degraded 状态传递为不可执行。
  const [view, setView] = useState<ReadinessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSequence = useRef(0);
  const mounted = useRef(true);

  // 重新检查时清除旧错误，避免把上一次失败误认为当前状态。
  const refresh = useCallback(async () => {
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    setError(null);
    setLoading(true);

    try {
      const nextView = await fetchReadiness();
      if (mounted.current && requestSequence.current === requestId) {
        setView(nextView);
      }
    } catch (cause) {
      if (mounted.current && requestSequence.current === requestId) {
        setError(
          cause instanceof Error ? cause.message : "无法读取运行准备状态",
        );
      }
    } finally {
      if (mounted.current && requestSequence.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // 修改日期：2026-08-16
  // 修改原因：后端 blocked/degraded 或未授权时必须禁用启动，不能由 Renderer 绕过 StartupGate。
  const blocked =
    !view ||
    view.status !== "ready" ||
    !view.allowedActions.includes("create_project");

  return (
    <main>
      <header>
        <p className="eyebrow">Digital Harness</p>
        <h1>运行准备</h1>
        <p>
          启动 Digital Harness
          前，请先确认模型、调研、工作区、容器和数据保存能力。
        </p>
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
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? "检查中…" : "重新检查"}
        </button>
        <button type="button" disabled={blocked}>
          启动 Digital Harness
        </button>
      </div>
    </main>
  );
}
