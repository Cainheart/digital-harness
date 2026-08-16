import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  FileArtifactStore,
  type ArtifactReference,
} from "../infra/artifacts.js";
import {
  CodingExecutionGrant,
  CodingTaskSpec,
  isCodingPathAllowed,
} from "../domain/coding/index.js";
import { PolicyDeniedError } from "../domain/errors.js";
import { WorkspaceManager } from "./workspace-manager.js";

/** FileGateway 提供只读扫描和 Patch-first 写入，不暴露任意文件系统 API。 */
export class FileGateway {
  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly artifacts: FileArtifactStore,
  ) {}

  /** 读取授权范围内的文本文件，并记录已读文件的内容摘要。 */
  async readFile(
    workspacePath: string,
    path: string,
    spec: CodingTaskSpec,
    grant: CodingExecutionGrant,
  ): Promise<{ path: string; content: string; sha256: string }> {
    this.assertAllowed(path, "read", spec, grant);
    const bytes = this.workspaces.read(workspacePath, path);
    if (bytes.length > 2 * 1024 * 1024)
      throw new PolicyDeniedError("读取文件超过 2 MiB 资源限制", {
        data: { code: "RESOURCE_LIMIT" },
      });
    return { path, content: bytes.toString("utf8"), sha256: sha256(bytes) };
  }

  /** 在已授权文本文件中搜索固定字符串；不支持正则或命令注入。 */
  async searchCode(
    workspacePath: string,
    query: string,
    spec: CodingTaskSpec,
    grant: CodingExecutionGrant,
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    if (
      !query.trim() ||
      query.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(query)
    )
      throw new PolicyDeniedError("搜索条件不安全", {
        data: { code: "PATH_DENIED" },
      });
    const root = workspacePath;
    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const path of walkTextFiles(root)) {
      const relativePath = relative(root, path).replaceAll("\\", "/");
      if (!isCodingPathAllowed(relativePath, "read", spec, grant)) continue;
      const text = readFileSync(path).toString("utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (line.includes(query))
          results.push({
            path: relativePath,
            line: index + 1,
            text: line.slice(0, 1000),
          });
        if (results.length >= 500) return results;
      }
    }
    return results;
  }

  /** 执行单文件 unified diff，校验基线 SHA 后原子写入并保存完整 diff Artifact。 */
  async applyPatch(input: {
    workspacePath: string;
    path: string;
    baseFileSha256: string;
    patch: string;
    spec: CodingTaskSpec;
    grant: CodingExecutionGrant;
  }): Promise<{ before: string; after: string; diffRef: ArtifactReference }> {
    this.assertAllowed(input.path, "write", input.spec, input.grant);
    const beforeBytes = this.workspaces.read(input.workspacePath, input.path);
    const before = sha256(beforeBytes);
    if (before !== input.baseFileSha256) {
      throw new PolicyDeniedError("Patch 基线 SHA 与当前文件不一致", {
        data: { code: "BASE_VERSION_MISMATCH", path: input.path },
      });
    }
    const diffRef = await this.artifacts.put(
      Buffer.from(input.patch),
      "text/x-diff",
      { projectId: input.grant.projectId },
    );
    const afterBytes = applyUnifiedDiff(beforeBytes, input.patch, input.path);
    const after = sha256(afterBytes);
    this.workspaces.atomicWrite(input.workspacePath, input.path, afterBytes);
    return { before, after, diffRef };
  }

  /** 将生成物保存为 Artifact；调用方必须先通过 save_evidence 工具授权。 */
  async saveEvidence(
    projectId: string,
    content: string,
    mediaType = "text/plain",
  ): Promise<ArtifactReference> {
    return this.artifacts.put(Buffer.from(content, "utf8"), mediaType, {
      projectId,
    });
  }

  private assertAllowed(
    path: string,
    mode: "read" | "write",
    spec: CodingTaskSpec,
    grant: CodingExecutionGrant,
  ): void {
    if (
      !grant.toolPolicy.includes(
        mode === "read" ? "read_file" : "apply_patch",
      ) ||
      !isCodingPathAllowed(path, mode, spec, grant)
    ) {
      throw new PolicyDeniedError(
        "文件路径或工具不在 CodingExecutionGrant 范围内",
        { data: { code: "PATH_DENIED", path } },
      );
    }
  }
}

/** 只遍历普通文件并跳过明显的二进制内容，避免搜索读取凭据或巨型产物。 */
function walkTextFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).size <= 2 * 1024 * 1024) {
        const bytes = readFileSync(path);
        if (!bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0))
          result.push(path);
      }
    }
  };
  visit(root);
  return result.sort();
}

/** 解析并应用单文件 unified diff；任一上下文不匹配都会整体失败且不写盘。 */
function applyUnifiedDiff(
  before: Buffer,
  patch: string,
  expectedPath: string,
): Buffer {
  const source = before.toString("utf8").split("\n");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (!lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ "))
    throw new PolicyDeniedError("只接受合法 unified diff", {
      data: { code: "BASE_VERSION_MISMATCH" },
    });
  const target = lines[1].slice(4).split("\t")[0];
  // 修改日期：2026-08-17
  // 修改原因：仅允许 Patch 头部精确匹配授权文件，避免使用后缀匹配误写同名目录中的其他文件。
  if (target !== expectedPath && target !== `b/${expectedPath}`) {
    throw new PolicyDeniedError("Patch 目标文件与授权路径不一致", {
      data: { code: "PATH_DENIED" },
    });
  }
  const output: string[] = [];
  let sourceCursor = 0;
  let index = 2;
  while (index < lines.length) {
    const header = lines[index];
    if (!header) {
      index += 1;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!match)
      throw new PolicyDeniedError("Patch hunk 格式无效", {
        data: { code: "BASE_VERSION_MISMATCH" },
      });
    const start = Number(match[1]) - 1;
    while (sourceCursor < start) output.push(source[sourceCursor++]);
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index++];
      if (line === "" && index === lines.length) continue;
      if (line === "\\ No newline at end of file") continue;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (source[sourceCursor] !== value)
          throw new PolicyDeniedError("Patch 上下文与当前文件不一致", {
            data: { code: "BASE_VERSION_MISMATCH" },
          });
        output.push(source[sourceCursor++]);
      } else if (marker === "-") {
        if (source[sourceCursor] !== value)
          throw new PolicyDeniedError("Patch 删除行与当前文件不一致", {
            data: { code: "BASE_VERSION_MISMATCH" },
          });
        sourceCursor += 1;
      } else if (marker === "+") output.push(value);
      else
        throw new PolicyDeniedError("Patch 行格式无效", {
          data: { code: "BASE_VERSION_MISMATCH" },
        });
    }
  }
  output.push(...source.slice(sourceCursor));
  return Buffer.from(output.join("\n"), "utf8");
}

/** 计算内容 SHA-256；仅用于基线和证据关联，不是权限凭据。 */
function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
