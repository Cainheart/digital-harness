import { Database } from "../infra/database.js";
import { WorkerLeaseStatus, WorkerLeaseStore } from "./worker-lease.js";

/** 管理应用停止标记、运行状态持久化和 Worker 租约查询。 */
export class ApplicationLifecycle {
  closing = false;
  /** 绑定数据库和 Worker 租约存储，统一管理进程生命周期事实。 */
  constructor(
    private readonly database: Database,
    private readonly leases: WorkerLeaseStore,
  ) {}
  /** 开始本地生命周期；缺少数据库时完成基础初始化并记录启动事实。 */
  startSync(): void {
    this.closing = false;
    if (this.database.currentRevision() === null) this.database.initialize();
    this.database.appendEvent(
      "ApplicationStarted",
      "tr_lifecycle",
      JSON.stringify({ result: "started" }),
    );
  }
  /** 标记应用关闭，并记录已提交的停止事件。 */
  stopSync(): void {
    if (this.closing) return;
    this.closing = true;
    this.database.appendEvent(
      "ApplicationStopped",
      "tr_lifecycle",
      JSON.stringify({ result: "stopped" }),
    );
  }
  /** 保存运行状态及原因，供重启恢复和审计读取。 */
  recordRuntimeStateSync(status: string, reason: string): void {
    this.database.writeRuntimeState(status, reason);
    this.database.appendEvent(
      "RuntimeStateChanged",
      "tr_lifecycle",
      JSON.stringify({ result: "committed" }),
    );
  }
  /** 读取当前持久化运行状态。 */
  currentStateSync(): string | null {
    return this.database.readRuntimeState()?.status ?? null;
  }
  /** 查询 Worker 租约并标记过期租约。 */
  checkWorkerLeasesSync(): WorkerLeaseStatus[] {
    return this.leases.statusesSync();
  }
}
