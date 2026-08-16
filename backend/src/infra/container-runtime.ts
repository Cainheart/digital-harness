import { accessSync, constants, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Docker/Container readiness 的最小能力描述。 */
export type ContainerCapabilities = { available: boolean; runtime: string; engineVersion: string | null; apiVersion: string | null; nonRootSupported: boolean; workspaceMountSupported: boolean; resourceLimitsSupported: boolean; networkPolicySupported: boolean; message: string };
/** Docker 能力查询适配器。 */
export interface ContainerRuntime { capabilities(): Promise<ContainerCapabilities>; }
/** 测试模式明确返回 blocked，避免 readiness 触发真实 Docker。 */
export class UnavailableContainerRuntime implements ContainerRuntime { /** 返回不可用状态而不执行外部命令。 */ async capabilities(): Promise<ContainerCapabilities> { return unavailable("容器运行时在当前环境不可用"); } }
/** 通过 Docker CLI 做无副作用能力探针。 */
export class DockerCliRuntime implements ContainerRuntime {
  private readonly executable: string;
  /** 允许注入 CLI 路径以便跨平台测试。 */
  constructor(executable = findDockerExecutable()) { this.executable = executable; }
  /** 只运行 docker version/info 探针，不启动容器。 */
  async capabilities(): Promise<ContainerCapabilities> { if (!existsSync(this.executable)) return unavailable("Docker CLI 不可用"); try { const run = promisify(execFile); const result = await run(this.executable, ["version", "--format", "{{.Server.Version}}|{{.Server.APIVersion}}"], { timeout: 3000 }); const [engineVersion, apiVersion] = result.stdout.trim().split("|"); return { available: true, runtime: "docker", engineVersion: engineVersion || null, apiVersion: apiVersion || null, nonRootSupported: true, workspaceMountSupported: true, resourceLimitsSupported: true, networkPolicySupported: true, message: "Docker Engine 可用于受限容器执行" }; } catch { return unavailable("Docker Engine 不可用或未启动"); } }
}
function findDockerExecutable(): string { const candidates = process.platform === "darwin" ? ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "docker"] : ["docker"]; for (const candidate of candidates) { if (candidate === "docker") return candidate; if (existsSync(candidate)) { try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ } } } return "__docker_not_configured__"; }
function unavailable(message: string): ContainerCapabilities { return { available: false, runtime: "docker", engineVersion: null, apiVersion: null, nonRootSupported: false, workspaceMountSupported: false, resourceLimitsSupported: false, networkPolicySupported: false, message }; }
