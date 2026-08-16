import { ContainerRuntime } from "../../infra/container-runtime.js";
import { CheckView } from "../models.js";

/** 检查 Docker Engine 是否具备受限容器执行能力。 */
export class ContainerReadinessChecker {
  readonly name = "docker";
  constructor(private readonly runtime: ContainerRuntime) {}
  /** 将容器运行时能力汇总为 readiness 状态和诊断详情。 */
  async check(): Promise<CheckView> { const capabilities = await this.runtime.capabilities(); const details = { runtime: capabilities.runtime, engineVersion: capabilities.engineVersion, apiVersion: capabilities.apiVersion, nonRootContainerSupported: capabilities.nonRootSupported, workspaceMountSupported: capabilities.workspaceMountSupported, resourceLimitsSupported: capabilities.resourceLimitsSupported, networkPolicySupported: capabilities.networkPolicySupported }; const ready = capabilities.available && capabilities.nonRootSupported && capabilities.workspaceMountSupported && capabilities.resourceLimitsSupported && capabilities.networkPolicySupported; return ready ? { status: "ready", message: capabilities.message, details } : { status: "blocked", message: capabilities.message, impact: "容器执行环境不可用", nextAction: "启动 Docker Engine 或 Docker Desktop 并检查工作区文件共享", details }; }
}
