import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodingExecutionGrant,
  CodingTaskSpec,
  isCodingPathAllowed,
} from "../domain/coding/index.js";
import { WorkspaceManager } from "../execution/workspace-manager.js";

/** 编码 Agent 每轮使用的分层上下文；不把整个仓库正文无差别交给模型。 */
export type ContextPack = {
  taskGoal: string;
  acceptanceCriteria: string[];
  repoMap: string[];
  technologyFiles: string[];
  ruleFiles: string[];
  relevantFiles: string[];
  commands: string[];
  missingItems: string[];
};

/** 按确定性扫描、规则优先和任务路径授权构建 ContextPack。 */
export class ContextBuilder {
  constructor(private readonly workspaces: WorkspaceManager) {}

  /** 只扫描工作区文件名和有限配置文件，返回缺失项而不是猜测授权。 */
  async build(
    workspacePath: string,
    spec: CodingTaskSpec,
    grant: CodingExecutionGrant,
  ): Promise<ContextPack> {
    const manifest = this.workspaces.manifest(workspacePath);
    const repoMap = Object.keys(manifest).filter((path) =>
      isCodingPathAllowed(path, "read", spec, grant),
    );
    const technologyFiles = repoMap.filter((path) =>
      /(?:package\.json|tsconfig\.json|vite\.config\.|pyproject\.toml|requirements(?:\.txt)?|Dockerfile|vitest\.config\.)/.test(
        path,
      ),
    );
    const ruleFiles = repoMap.filter((path) =>
      /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|README\.md|CONTRIBUTING\.md|\.editorconfig)$/.test(
        path,
      ),
    );
    const relevantFiles = repoMap
      .filter((path) =>
        spec.allowedPaths.some((pattern) =>
          pattern.endsWith("/**")
            ? path.startsWith(pattern.slice(0, -3))
            : path === pattern,
        ),
      )
      .slice(0, 200);
    const missingItems: string[] = [];
    if (!spec.goal.trim()) missingItems.push("goal");
    if (spec.acceptanceCriteria.length === 0)
      missingItems.push("acceptanceCriteria");
    if (spec.allowedPaths.length === 0) missingItems.push("allowedPaths");
    if (technologyFiles.length === 0)
      missingItems.push("technology profile or package configuration");
    return {
      taskGoal: spec.goal,
      acceptanceCriteria: [...spec.acceptanceCriteria],
      repoMap,
      technologyFiles,
      ruleFiles,
      relevantFiles,
      commands: readCommands(workspacePath, technologyFiles),
      missingItems,
    };
  }
}

/** 只从已授权配置文件读取命令线索；最终验证命令仍由版本化 Profile 决定。 */
function readCommands(workspacePath: string, files: string[]): string[] {
  const packageFile = files.find((path) => path.endsWith("package.json"));
  if (!packageFile) return [];
  try {
    const packageJson = JSON.parse(
      readFileSync(join(workspacePath, packageFile), "utf8"),
    ) as { scripts?: Record<string, string> };
    return Object.keys(packageJson.scripts ?? {})
      .filter((name) => /^[A-Za-z0-9:_-]+$/.test(name))
      .map((name) => `npm run ${name}`)
      .slice(0, 50);
  } catch (error) {
    // 修改日期：2026-08-17
    // 修改原因：技术栈配置损坏时必须阻塞上下文构建并保留可恢复原因，不能静默按空命令继续执行。
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("package.json 不可解析，ContextPack 构建被阻塞");
  }
}
