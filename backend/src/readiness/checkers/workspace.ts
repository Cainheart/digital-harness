import { accessSync, constants, existsSync, statSync } from "node:fs";
import { CheckView } from "../models.js";

/** 检查本地项目工作区是否存在且同时可读写。 */
export class WorkspaceReadinessChecker {
  readonly name = "workspace";
  constructor(private readonly workspace: string) {}
  /** 执行无业务副作用的工作区权限检查。 */
  async check(): Promise<CheckView> {
    try {
      if (
        !existsSync(this.workspace) ||
        !statSync(this.workspace).isDirectory()
      )
        throw new Error();
      accessSync(this.workspace, constants.R_OK | constants.W_OK);
      return {
        status: "ready",
        message: "本地项目工作区可访问",
        details: { root: "workspace://local" },
      };
    } catch (_error) {
      return {
        status: "blocked",
        message: "本地项目工作区不可访问",
        impact: "本地项目工作区不可访问",
        nextAction: "检查工作区路径并授予应用访问权限",
        details: {},
      };
    }
  }
}
