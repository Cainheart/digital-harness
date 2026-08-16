import { Database } from "../infra/database.js";

/** 表示一个 Worker 的心跳、状态和可恢复性判断输入。 */
export type WorkerLeaseStatus = {
  workerId: string;
  status: string;
  heartbeatAt: string;
};
/** 持久化 Worker 租约，并将超时心跳标记为 expired。 */
export class WorkerLeaseStore {
  /** 绑定租约存储和心跳过期阈值，过期任务只能进入诊断状态。 */
  constructor(
    private readonly database: Database,
    private readonly expirySeconds = 300,
  ) {}
  /** 注册或刷新 Worker 心跳租约。 */
  registerSync(workerId: string, heartbeatAt = new Date().toISOString()): void {
    this.database.saveWorkerLease(workerId, heartbeatAt, "active");
  }
  /** 读取租约并计算活动或过期状态。 */
  statusesSync(): WorkerLeaseStatus[] {
    const now = Date.now();
    return this.database.readWorkerLeases().map((lease) => {
      const current =
        now - Date.parse(lease.heartbeat_at) > this.expirySeconds * 1000
          ? "expired"
          : lease.status;
      if (current === "expired" && lease.status !== "expired")
        this.database.saveWorkerLease(
          lease.worker_id,
          lease.heartbeat_at,
          "expired",
        );
      return {
        workerId: lease.worker_id,
        status: current,
        heartbeatAt: lease.heartbeat_at,
      };
    });
  }
}
