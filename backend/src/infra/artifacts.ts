import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ArtifactIntegrityError,
  ArtifactTooLargeError,
} from "../domain/errors.js";
import { newObjectId, utcNow } from "../domain/common.js";

/** File Artifact Store 的内容寻址引用。 */
export type ArtifactReference = {
  artifactId: string;
  projectId: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  relativePath: string;
  storeRef: string;
};
/** Artifact 完整性检查结果。 */
export type ArtifactVerification = {
  valid: boolean;
  reason: string;
  actualSha256: string | null;
  actualSize: number | null;
};
/** 项目删除的文件结果。 */
export type ArtifactDeleteReport = {
  deletedPaths: string[];
  failedPaths: string[];
};

/** 以 project/sha256 内容寻址保存证据，并拒绝符号链接和越界路径。 */
export class FileArtifactStore {
  readonly root: string;
  readonly maxSizeBytes: number;

  /** 绑定 Artifact Store 根目录和单文件大小上限。 */
  constructor(root: string, maxSizeBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes <= 0)
      throw new Error("maxSizeBytes must be a positive safe integer");
    this.root = resolve(root);
    this.maxSizeBytes = maxSizeBytes;
    mkdirSync(this.root, { recursive: true });
  }
  /** 保存内容并返回 SHA-256 引用；重复内容不会覆盖既有文件。 */
  async put(
    content: Buffer | Uint8Array,
    mediaType: string,
    metadata: { projectId: string; artifactId?: string },
  ): Promise<ArtifactReference> {
    const bytes = Buffer.from(content);
    if (bytes.length > this.maxSizeBytes)
      throw new ArtifactTooLargeError(undefined, {
        data: { size: bytes.length, maxSize: this.maxSizeBytes },
      });
    const projectId = safeProject(metadata.projectId);
    if (!isMediaType(mediaType))
      throw new ArtifactIntegrityError("mediaType is invalid");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const relativePath = join(projectId, sha256.slice(0, 2), sha256);
    const destination = join(this.root, relativePath);
    this.assertSafePath(destination);
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination)) {
      writeFileSync(destination, bytes, { mode: 0o600 });
    } else {
      const existing = lstatSync(destination);
      if (!existing.isFile())
        throw new ArtifactIntegrityError("Artifact destination is not a file");
      const existingBytes = readFileSync(destination);
      const existingSha256 = createHash("sha256")
        .update(existingBytes)
        .digest("hex");
      if (existingBytes.length !== bytes.length || existingSha256 !== sha256)
        throw new ArtifactIntegrityError(
          "Existing content-addressed Artifact does not match its hash",
        );
    }
    return {
      artifactId: metadata.artifactId ?? newObjectId("artifact"),
      projectId,
      sha256,
      mediaType,
      sizeBytes: bytes.length,
      createdAt: utcNow(),
      relativePath: relativePath.replaceAll("\\", "/"),
      storeRef: `artifact://${relativePath.replaceAll("\\", "/")}`,
    };
  }
  /** 读取已校验的 Artifact 内容。 */
  async get(reference: ArtifactReference): Promise<Buffer> {
    try {
      const path = this.pathFor(reference);
      const data = readFileSync(path);
      const verification = this.verifyBytes(reference, data);
      if (!verification.valid)
        throw new ArtifactIntegrityError(undefined, {
          data: { artifactId: reference.artifactId },
        });
      return data;
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError(undefined, {
        data: { artifactId: reference.artifactId },
      });
    }
  }
  /** 校验文件存在性、路径边界、大小和 SHA-256。 */
  async verify(reference: ArtifactReference): Promise<ArtifactVerification> {
    try {
      const path = this.pathFor(reference);
      const data = readFileSync(path);
      return this.verifyBytes(reference, data);
    } catch (_error) {
      return {
        valid: false,
        reason: "artifact is missing or unsafe",
        actualSha256: null,
        actualSize: null,
      };
    }
  }
  /** 删除项目文件并报告不能安全删除的路径。 */
  async deleteForProject(projectId: string): Promise<ArtifactDeleteReport> {
    return this.deleteForProjectSync(projectId);
  }
  /** 同步删除项目证据，供数据库项目 purge 事务后的协调器使用。 */
  deleteForProjectSync(projectId: string): ArtifactDeleteReport {
    const root = join(this.root, safeProject(projectId));
    const deletedPaths: string[] = [];
    const failedPaths: string[] = [];
    if (!existsSync(root)) return { deletedPaths, failedPaths };
    try {
      this.assertSafeTree(root);
      rmSync(root, { recursive: true, force: true });
      deletedPaths.push(relative(this.root, root));
    } catch (_error) {
      failedPaths.push(relative(this.root, root));
    }
    return { deletedPaths, failedPaths };
  }
  /** 统计项目证据文件数量。 */
  projectFileCount(projectId: string): number {
    const root = join(this.root, safeProject(projectId));
    return walkRegularFiles(root).length;
  }
  private pathFor(reference: ArtifactReference): string {
    const projectId = safeProject(reference.projectId);
    if (!/^[0-9a-f]{64}$/.test(reference.sha256))
      throw new ArtifactIntegrityError();
    const expectedRelativePath = join(
      projectId,
      reference.sha256.slice(0, 2),
      reference.sha256,
    ).replaceAll("\\", "/");
    if (reference.relativePath !== expectedRelativePath)
      throw new ArtifactIntegrityError(
        "Artifact reference project scope mismatch",
      );
    const path = join(this.root, reference.relativePath);
    this.assertSafePath(path);
    return path;
  }
  /** 对已经读取的字节执行一次性大小和内容寻址校验，避免 get() 发生二次读取竞态。 */
  private verifyBytes(
    reference: ArtifactReference,
    data: Buffer,
  ): ArtifactVerification {
    const actualSha256 = createHash("sha256").update(data).digest("hex");
    const withinSizeLimit = data.length <= this.maxSizeBytes;
    const matchesReference =
      actualSha256 === reference.sha256 && data.length === reference.sizeBytes;
    return {
      valid: withinSizeLimit && matchesReference,
      reason: !withinSizeLimit
        ? "artifact exceeds configured size limit"
        : matchesReference
          ? "verified"
          : "content hash or size mismatch",
      actualSha256,
      actualSize: data.length,
    };
  }
  private assertSafePath(path: string): void {
    const absolute = resolve(path);
    const root = resolve(this.root);
    const relativePath = relative(root, absolute);
    if (
      absolute !== root &&
      (isAbsolute(relativePath) || relativePath.startsWith(".."))
    )
      throw new ArtifactIntegrityError("Artifact reference escapes store root");
    if (existsSync(root) && lstatSync(root).isSymbolicLink())
      throw new ArtifactIntegrityError("Artifact root is a symlink");
    let current = root;
    for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
      current = join(current, segment);
      if (!existsSync(current)) continue;
      const stat = lstatSync(current);
      if (stat.isSymbolicLink())
        throw new ArtifactIntegrityError("Artifact path contains a symlink");
      if (current !== absolute && !stat.isDirectory())
        throw new ArtifactIntegrityError(
          "Artifact path contains a file parent",
        );
    }
  }
  private assertSafeTree(root: string): void {
    if (lstatSync(root).isSymbolicLink())
      throw new ArtifactIntegrityError("Artifact tree contains a symlink");
    for (const entry of readdirSync(root)) {
      const path = join(root, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new ArtifactIntegrityError("Artifact tree contains a symlink");
      if (stat.isDirectory()) this.assertSafeTree(path);
      else if (!stat.isFile())
        throw new ArtifactIntegrityError(
          "Artifact tree contains a special file",
        );
    }
  }
}

function safeProject(projectId: string): string {
  if (
    !/^[A-Za-z0-9_-]+$/.test(projectId) ||
    projectId === "." ||
    projectId === ".."
  )
    throw new ArtifactIntegrityError("projectId is not a safe path segment");
  return projectId;
}
/** 检查 MIME 类型只包含可记录的类型/子类型，不允许控制字符。 */
function isMediaType(mediaType: string): boolean {
  return /^[^\/\u0000-\u001f\u007f\s]+\/[^\/\u0000-\u001f\u007f\s]+$/.test(
    mediaType,
  );
}

/** 统计普通文件并拒绝符号链接和特殊文件，避免删除/容量诊断误判。 */
function walkRegularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = lstatSync(root);
  if (stat.isSymbolicLink())
    throw new ArtifactIntegrityError("Artifact tree contains a symlink");
  if (stat.isFile()) return [root];
  if (!stat.isDirectory())
    throw new ArtifactIntegrityError("Artifact tree contains a special file");
  return readdirSync(root).flatMap((entry) =>
    walkRegularFiles(join(root, entry)),
  );
}
