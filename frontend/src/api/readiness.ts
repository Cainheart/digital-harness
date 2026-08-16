import type { ReadinessView } from "../features/readiness/readiness.types";

// 只通过控制面读取最新状态，Renderer 不直接访问 Docker、Keychain 或文件系统。
export async function fetchReadiness(): Promise<ReadinessView> {
  const response = await fetch("/api/v1/readiness");
  if (!response.ok) {
    throw new Error("运行准备检查失败");
  }
  return response.json() as Promise<ReadinessView>;
}
