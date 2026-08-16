import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  fsyncSync,
  openSync,
  closeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { InvalidArgumentError, PolicyDeniedError } from "../domain/errors.js";

/** WorkspaceManager 为每个 Attempt 分配唯一可写目录并拒绝符号链接逃逸。 */
export class WorkspaceManager {
  constructor(private readonly root: string) {
    mkdirSync(this.root, { recursive: true });
  }

  /** 创建 attempt 专属工作区；sourceRoot 只能来自受控工作区根目录。 */
  createIsolatedWorkspace(
    projectId: string,
    attemptId: string,
    sourceRoot?: string,
  ): { path: string; baselineManifest: Record<string, string> } {
    const projectPath = this.safeChild(this.root, projectId);
    const workspacePath = this.safeChild(
      projectPath,
      `${attemptId}-${randomUUID()}`,
    );
    mkdirSync(workspacePath, { recursive: true });
    if (sourceRoot) {
      const source = this.assertInsideRoot(resolve(sourceRoot));
      // 修改日期：2026-08-17
      // 修改原因：拒绝将源目录放在新工作区内部，避免递归复制和越界读取造成工作区污染。
      if (source === workspacePath || source.startsWith(`${workspacePath}/`)) {
        throw new PolicyDeniedError("源工作区不能位于目标工作区内部", {
          data: { code: "PATH_DENIED" },
        });
      }
      copyTree(source, workspacePath);
    }
    return {
      path: workspacePath,
      baselineManifest: this.manifest(workspacePath),
    };
  }

  /** 读取工作区当前文件快照；快照只保存 SHA，不把源代码写入数据库。 */
  manifest(workspacePath: string): Record<string, string> {
    const root = this.assertInsideRoot(resolve(workspacePath));
    const result: Record<string, string> = {};
    for (const file of walkFiles(root)) {
      const relativePath = relative(root, file).replaceAll("\\", "/");
      result[relativePath] = sha256(readFileSync(file));
    }
    return result;
  }

  /** 返回基线以来的全部变更，供额外变更门禁和交接包使用。 */
  changedFiles(
    workspacePath: string,
    baselineManifest: Record<string, string>,
  ): string[] {
    const current = this.manifest(workspacePath);
    const paths = new Set([
      ...Object.keys(baselineManifest),
      ...Object.keys(current),
    ]);
    return [...paths]
      .filter((path) => baselineManifest[path] !== current[path])
      .sort();
  }

  /** 为回滚和交接生成内容寻址工作区摘要。 */
  snapshotDigest(workspacePath: string): string {
    const manifest = this.manifest(workspacePath);
    return sha256(Buffer.from(JSON.stringify(manifest)));
  }

  /** 解析工作区相对路径；越界、符号链接和不存在的祖先均拒绝。 */
  resolveFile(workspacePath: string, relativePath: string): string {
    if (!isSafeRelativePath(relativePath)) {
      throw new PolicyDeniedError("工作区路径不安全", {
        data: { code: "PATH_DENIED" },
      });
    }
    const root = this.assertInsideRoot(resolve(workspacePath));
    const path = resolve(root, relativePath);
    if (!path.startsWith(`${root}/`) && path !== root) {
      throw new PolicyDeniedError("工作区路径越界", {
        data: { code: "PATH_DENIED" },
      });
    }
    this.assertNoSymlink(path, root);
    return path;
  }

  /** 原子替换文件并在成功后 fsync，失败时不覆盖已有内容。 */
  atomicWrite(
    workspacePath: string,
    relativePath: string,
    content: Buffer,
  ): void {
    const destination = this.resolveFile(workspacePath, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { mode: 0o600 });
      const descriptor = openSync(temporary, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, destination);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }

  /** 只在确认目标位于工作区后读取文件，避免 FileGateway 直接操作主机路径。 */
  read(workspacePath: string, relativePath: string): Buffer {
    const path = this.resolveFile(workspacePath, relativePath);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new InvalidArgumentError("目标文件不存在或不是普通文件");
    }
    return readFileSync(path);
  }

  /** 删除未被使用的空工作区；任务取消默认保留工作区，因此仅供明确清理流程调用。 */
  remove(workspacePath: string): void {
    const path = this.assertInsideRoot(resolve(workspacePath));
    if (path === this.root)
      throw new InvalidArgumentError("不能删除工作区根目录");
    rmSync(path, { recursive: true, force: false });
  }

  private safeChild(parent: string, child: string): string {
    if (!/^[A-Za-z0-9_:-]{1,128}$/.test(child)) {
      throw new InvalidArgumentError("工作区标识符不安全");
    }
    return join(this.assertInsideRoot(resolve(parent)), child);
  }

  private assertInsideRoot(path: string): string {
    const root = resolve(this.root);
    if (path !== root && !path.startsWith(`${root}/`)) {
      throw new PolicyDeniedError("工作区路径超出授权根目录", {
        data: { code: "PATH_DENIED" },
      });
    }
    return path;
  }

  private assertNoSymlink(path: string, root: string): void {
    let current = path;
    while (current !== root && current.startsWith(`${root}/`)) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        throw new PolicyDeniedError("工作区不允许符号链接", {
          data: { code: "PATH_DENIED" },
        });
      }
      current = dirname(current);
    }
  }
}

/** 受控文件树遍历只返回普通文件，隐藏目录和符号链接不会穿透工作区边界。 */
function walkFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  visit(root);
  return result.sort();
}

/** 复制固定工作区内容，不复制符号链接和工作区外引用。 */
function copyTree(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new PolicyDeniedError("源工作区包含不允许的符号链接", {
        data: { code: "PATH_DENIED" },
      });
    }
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else if (entry.isFile()) {
      writeFileSync(to, readFileSync(from), { mode: 0o600 });
    }
  }
}

/** 计算文件 SHA-256，用于基线冲突和工作区快照比较。 */
function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** FileGateway 共用的工作区相对路径边界。 */
function isSafeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !/[\\\0\u0000-\u001f\u007f]/.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}
