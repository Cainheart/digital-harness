import { accessSync, constants, existsSync } from "node:fs";
import { CheckView } from "../models.js";

/** 定义本地调研适配器的无副作用可用性探针。 */
export interface ResearchProbe {
  check(): Promise<boolean>;
}
/** 测试模式下明确返回不可用，避免误触发真实浏览器。 */
export class UnavailableResearchProbe implements ResearchProbe {
  /** 返回浏览器调研不可用。 */ async check(): Promise<boolean> {
    return false;
  }
}
/** 只检查本机浏览器可执行权限，不在 readiness 阶段访问网页。 */
export class LocalBrowserProbe implements ResearchProbe {
  constructor(private readonly executable: string) {}
  /** 确认配置路径存在且可执行。 */ async check(): Promise<boolean> {
    if (!existsSync(this.executable)) return false;
    try {
      accessSync(this.executable, constants.X_OK);
      return true;
    } catch (_error) {
      return false;
    }
  }
}
/** 将调研适配器探针转换成阻断或就绪状态。 */
export class ResearchReadinessChecker {
  readonly name = "research";
  constructor(private readonly probe: ResearchProbe) {}
  /** 检查调研能力并提供面向用户的修复动作。 */ async check(): Promise<CheckView> {
    return (await this.probe.check())
      ? { status: "ready", message: "公开资料调研适配器可启动", details: {} }
      : {
          status: "blocked",
          message: "公开资料调研适配器不可用",
          impact: "公开资料调研不可用",
          nextAction: "安装并启动支持的浏览器适配器",
          details: {},
        };
  }
}
