import type { CredentialAdapter } from "../../infra/keychain.js";
import type { Database } from "../../infra/database.js";
import { ModelConfigRepository } from "../../infra/repositories/model-config.js";
import { CheckView } from "../models.js";

/** 检查配置的模型凭据引用是否可用，不执行模型生成。 */
export class ModelReadinessChecker {
  readonly name = "model";
  private readonly modelConfigs = new ModelConfigRepository();
  constructor(
    private readonly credentials: CredentialAdapter,
    private readonly provider: string,
    private readonly model: string,
    private readonly secretRef: string,
    private readonly database?: Database,
  ) {}
  /** 把凭据检查结果转换成脱敏 readiness 视图。 */
  async check(): Promise<CheckView> {
    if (this.database) {
      const configured = this.modelConfigs
        .list(this.database.connection)
        .filter(
          (config) =>
            config.provider !== "unconfigured" &&
            config.credentialStatus === "configured" &&
            config.secretRef !== null,
        );
      // 修改日期：2026-08-16
      // 修改原因：Task 5 配置存在时不能回退 legacy 模型配置，否则新配置全部失效时会误报 ready。
      if (configured.length > 0) {
        let firstUnavailable: (typeof configured)[number] | null = null;
        for (const config of configured) {
          const result = await this.credentials.check(config.secretRef as string);
          if (result.available) {
            return {
              status: "ready",
              message: "至少一个已配置模型可连接",
              details: { provider: config.provider, model: config.modelName },
            };
          }
          firstUnavailable ??= config;
        }
        return {
          status: "blocked",
          message: "已配置模型的凭据均不可用",
          impact: "模型调用无法启动",
          nextAction: "重新绑定模型凭据并执行连接检查",
          details: {
            provider: firstUnavailable?.provider,
            model: firstUnavailable?.modelName,
          },
        };
      }
    }
    const result = await this.credentials.check(this.secretRef);
    return result.available
      ? {
          status: "ready",
          message: "至少一个已配置模型可连接",
          details: { provider: this.provider, model: this.model },
        }
      : {
          status: "blocked",
          message: "模型凭据不可用",
          impact: "模型调用无法启动",
          nextAction: "重新绑定模型凭据并执行连接检查",
          details: { provider: this.provider, model: this.model },
        };
  }
}
