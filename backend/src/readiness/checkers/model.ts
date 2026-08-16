import { CredentialAdapter } from "../../infra/keychain.js";
import { CheckView } from "../models.js";

/** 检查配置的模型凭据引用是否可用，不执行模型生成。 */
export class ModelReadinessChecker {
  readonly name = "model";
  constructor(
    private readonly credentials: CredentialAdapter,
    private readonly provider: string,
    private readonly model: string,
    private readonly secretRef: string,
  ) {}
  /** 把凭据检查结果转换成脱敏 readiness 视图。 */
  async check(): Promise<CheckView> {
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
