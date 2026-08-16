import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./client";

/** 管理事件游标和断线重连；事件内容只触发 Query 失效，不直接改页面状态。 */
export class DomainEventStream {
  private source: EventSource | null = null;
  private cursor: string | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;

  /** 开始订阅提交后的领域事件，重连时使用 after 游标补齐。 */
  start(
    queryClient: QueryClient,
    projectId?: string,
    onStatus?: (connected: boolean) => void,
  ): () => void {
    this.closed = false;
    const connect = () => {
      if (this.closed || typeof EventSource === "undefined") return;
      const search = new URLSearchParams();
      if (this.cursor) search.set("after", this.cursor);
      if (projectId) search.set("projectId", projectId);
      this.source = new EventSource(`/api/v1/events?${search.toString()}`);
      onStatus?.(true);
      this.source.addEventListener("domain_event", (event) => {
        const message = event as MessageEvent<string>;
        if (message.lastEventId) this.cursor = message.lastEventId;
        invalidate(queryClient, projectId);
      });
      this.source.onerror = () => {
        onStatus?.(false);
        this.source?.close();
        this.source = null;
        if (!this.closed && this.reconnectTimer === null) {
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            connect();
          }, 1_000);
        }
      };
    };
    connect();
    return () => this.stop();
  }

  /** 停止当前连接并清理重连计时器。 */
  stop(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/** 统一将领域事件映射到受影响的查询键，避免事件 payload 绕过后端规则。 */
function invalidate(queryClient: QueryClient, projectId?: string): void {
  if (projectId) {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.dashboard(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.office(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.tasks(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.artifacts(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.events(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.notifications(projectId),
    });
  } else {
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["office"] });
    void queryClient.invalidateQueries({ queryKey: ["archive"] });
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }
}
