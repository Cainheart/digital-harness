import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { SUPPORTED_SCHEMA_REVISION } from "../config/schema-revision.js";
import type { Database } from "../infra/database.js";
import { validateNoFollowPath } from "../infra/database.js";

/** Task 10 运维备份清单；凭据只允许以 secretRef 元数据存在于数据库中。 */
export type BackupManifest = {
  backup_id: string;
  created_at: string;
  application_version: string;
  schema_version: string;
  project_ids: string[];
  artifact_count: number;
  event_count: number;
  trace_link_count: number;
  file_checksums: Record<string, { sha256: string; size: number }>;
  redaction_policy_version: string;
  source_environment: string;
};

/** 备份校验结果；失败项必须指出相对路径或结构合同。 */
export type BackupVerification = {
  valid: boolean;
  backupId: string;
  checkedFiles: number;
  failures: string[];
  manifest: BackupManifest;
};

const BACKUP_DIRECTORIES = ["artifacts", "traces", "workspaces"] as const;
const MAX_BACKUP_FILE_SIZE = 64 * 1024 * 1024;
const REDACTION_POLICY_VERSION = "redaction-v1";

/** 创建带数据库快照、证据文件、工作区文件和哈希清单的本地备份包。 */
export class BackupService {
  /** 绑定当前控制面的数据库、持久化根和应用版本。 */
  constructor(
    private readonly database: Database,
    private readonly appVersion: string,
    private readonly persistentRoot: string,
  ) {}

  /** 创建新目录形式备份；已有非空目录默认拒绝，避免覆盖历史运维资产。 */
  create(outputPath: string, projectIds?: string[]): BackupManifest {
    const root = resolveSafePath(outputPath);
    assertNewDirectory(root);
    const selectedProjects = this.selectProjects(projectIds);
    this.assertFullRootBackup(projectIds, selectedProjects);
    this.assertOutputOutsideSourceDirectories(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "database"), { recursive: true, mode: 0o700 });
    for (const directory of BACKUP_DIRECTORIES) {
      mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    }

    const databaseSnapshot = join(root, "database", "company.db");
    this.database.connection
      .prepare("VACUUM INTO ?")
      .run(databaseSnapshot);
    const files: Record<string, { sha256: string; size: number }> = {};
    recordFile(root, databaseSnapshot, files);
    for (const directory of BACKUP_DIRECTORIES) {
      copyTree(
        join(this.persistentRoot, directory),
        join(root, directory),
        root,
        files,
      );
    }
    const manifest: BackupManifest = {
      backup_id: `backup-${randomUUID()}`,
      created_at: new Date().toISOString(),
      application_version: this.appVersion,
      schema_version: SUPPORTED_SCHEMA_REVISION,
      project_ids: selectedProjects,
      artifact_count: this.count("SELECT COUNT(*) AS count FROM artifacts"),
      event_count: this.count("SELECT COUNT(*) AS count FROM domain_events"),
      trace_link_count: this.count("SELECT COUNT(*) AS count FROM trace_links"),
      file_checksums: files,
      redaction_policy_version: REDACTION_POLICY_VERSION,
      source_environment: `${process.platform}-${process.arch}`,
    };
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      encoding: "utf8",
    });
    const verification = this.verify(root);
    if (!verification.valid) {
      throw new Error(`备份完整性校验失败：${verification.failures.join("；")}`);
    }
    return manifest;
  }

  /** 校验清单、文件数量、SHA-256、路径边界和敏感信息扫描结果。 */
  verify(backupPath: string): BackupVerification {
    const root = resolveSafePath(backupPath);
    const failures: string[] = [];
    let manifest: BackupManifest;
    try {
      manifest = parseManifest(
        JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")),
      );
    } catch (error) {
      return {
        valid: false,
        backupId: "unknown",
        checkedFiles: 0,
        failures: [error instanceof Error ? error.message : "manifest 无法读取"],
        manifest: emptyManifest(),
      };
    }
    if (manifest.schema_version !== SUPPORTED_SCHEMA_REVISION) {
      failures.push("schema_version 与当前应用不兼容");
    }
    const actualFiles = listFiles(root).filter((file) => file !== "manifest.json");
    const expectedFiles = Object.keys(manifest.file_checksums);
    if (actualFiles.length !== expectedFiles.length) {
      failures.push(`文件数量不一致，清单 ${expectedFiles.length}，实际 ${actualFiles.length}`);
    }
    for (const file of expectedFiles) {
      const expected = manifest.file_checksums[file];
      try {
        const absolute = safeJoin(root, file);
        const stat = lstatSync(absolute);
        if (!stat.isFile()) throw new Error("不是普通文件");
        const bytes = readFileChecked(absolute);
        const actual = digest(bytes);
        if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
          failures.push(`${file} SHA-256 或大小不一致`);
        }
        if (containsCredentialPattern(bytes.toString("utf8"))) {
          failures.push(`${file} 包含未脱敏敏感信息`);
        }
      } catch (error) {
        failures.push(`${file} ${error instanceof Error ? error.message : "无法校验"}`);
      }
    }
    for (const file of actualFiles) {
      if (!manifest.file_checksums[file]) failures.push(`${file} 未登记在 manifest 中`);
    }
    return {
      valid: failures.length === 0,
      backupId: manifest.backup_id,
      checkedFiles: expectedFiles.length,
      failures,
      manifest,
    };
  }

  /** 校验项目筛选值属于当前库；不允许备份未授权项目 ID。 */
  private selectProjects(projectIds?: string[]): string[] {
    const rows = this.database.connection
      .prepare("SELECT id FROM projects ORDER BY id")
      .all() as Array<{ id: string }>;
    const available = new Set(rows.map((row) => row.id));
    if (!projectIds || projectIds.length === 0) return [...available];
    for (const projectId of projectIds) {
      if (!available.has(projectId)) throw new Error(`项目不存在：${projectId}`);
    }
    return [...new Set(projectIds)].sort();
  }

  /** V1 只生成事务一致的整库包，避免 manifest 项目范围与 SQLite 实际内容不一致。 */
  private assertFullRootBackup(
    requestedProjects: string[] | undefined,
    selectedProjects: string[],
  ): void {
    if (!requestedProjects || requestedProjects.length === 0) return;
    const allProjects = this.selectProjects();
    const selected = JSON.stringify(selectedProjects);
    const available = JSON.stringify(allProjects);
    if (selected !== available) {
      throw new Error("V1 备份必须覆盖完整持久化根；暂不支持项目子集备份");
    }
  }

  /** 阻止输出目录落入待复制目录，避免备份过程递归复制自身。 */
  private assertOutputOutsideSourceDirectories(outputPath: string): void {
    for (const directory of BACKUP_DIRECTORIES) {
      const sourceRoot = resolve(this.persistentRoot, directory);
      if (isWithin(outputPath, sourceRoot)) {
        throw new Error(`备份输出目录不能位于源目录：${directory}`);
      }
    }
  }

  private count(sql: string): number {
    return (this.database.connection.prepare(sql).get() as { count: number }).count;
  }
}

/** 读取备份清单并拒绝额外字段、错误类型和空版本。 */
export function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest 必须是对象");
  }
  const manifest = value as Record<string, unknown>;
  const requiredStrings = [
    "backup_id",
    "created_at",
    "application_version",
    "schema_version",
    "redaction_policy_version",
    "source_environment",
  ];
  for (const field of requiredStrings) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      throw new Error(`manifest.${field} 缺失或无效`);
    }
  }
  if (
    !Array.isArray(manifest.project_ids) ||
    manifest.project_ids.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error("manifest.project_ids 无效");
  }
  if (
    !manifest.file_checksums ||
    typeof manifest.file_checksums !== "object" ||
    Array.isArray(manifest.file_checksums)
  ) {
    throw new Error("manifest.file_checksums 无效");
  }
  return {
    backup_id: manifest.backup_id as string,
    created_at: manifest.created_at as string,
    application_version: manifest.application_version as string,
    schema_version: manifest.schema_version as string,
    project_ids: manifest.project_ids as string[],
    artifact_count: integerField(manifest.artifact_count, "artifact_count"),
    event_count: integerField(manifest.event_count, "event_count"),
    trace_link_count: integerField(manifest.trace_link_count, "trace_link_count"),
    file_checksums: parseChecksums(manifest.file_checksums),
    redaction_policy_version: manifest.redaction_policy_version as string,
    source_environment: manifest.source_environment as string,
  };
}

/** 将输出路径锚定到真实父目录，兼容 macOS /var 等系统级路径别名。 */
export function resolveSafePath(input: string): string {
  const absolute = resolve(input);
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new Error("path contains a symlink or special file");
  }
  const missingParts: string[] = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error("path has no safe existing parent");
    missingParts.unshift(basename(existing));
    existing = parent;
  }
  const physicalParent = realpathSync(existing);
  return join(physicalParent, ...missingParts);
}

/** 校验备份目标是新目录或空目录，且不通过符号链接覆盖既有资产。 */
function assertNewDirectory(path: string): void {
  validateNoFollowPath(path);
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || readdirSync(path).length > 0) {
      throw new Error("备份输出目录必须不存在或为空目录");
    }
  }
}

/** 复制允许的持久化目录，并逐文件执行大小、类型和敏感信息检查。 */
function copyTree(
  source: string,
  destination: string,
  backupRoot: string,
  files: Record<string, { sha256: string; size: number }>,
): void {
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`备份源目录不安全：${source}`);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source)) {
    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    const entryStat = lstatSync(sourcePath);
    if (entryStat.isSymbolicLink()) throw new Error(`备份源包含符号链接：${sourcePath}`);
    if (entryStat.isDirectory()) {
      copyTree(sourcePath, destinationPath, backupRoot, files);
      continue;
    }
    if (!entryStat.isFile()) throw new Error(`备份源包含特殊文件：${sourcePath}`);
    const bytes = readFileChecked(sourcePath);
    if (bytes.length > MAX_BACKUP_FILE_SIZE) throw new Error(`备份文件超过大小限制：${sourcePath}`);
    if (containsCredentialPattern(bytes.toString("utf8"))) {
      throw new Error(`备份源包含未脱敏敏感信息：${sourcePath}`);
    }
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    writeFileSync(destinationPath, bytes, { mode: 0o600 });
    recordFile(backupRoot, destinationPath, files);
  }
}

/** 记录文件相对路径、大小和 SHA-256，供创建后立即自校验。 */
function recordFile(
  root: string,
  path: string,
  files: Record<string, { sha256: string; size: number }>,
): void {
  const bytes = readFileChecked(path);
  if (bytes.length > MAX_BACKUP_FILE_SIZE) throw new Error(`备份文件超过大小限制：${path}`);
  const relativePath = relative(root, path).replaceAll("\\", "/");
  files[relativePath] = digest(bytes);
}

/** 读取普通文件并限制最大大小，拒绝目录、设备文件和其他特殊节点。 */
function readFileChecked(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_BACKUP_FILE_SIZE) throw new Error("文件不可安全读取");
  return readFileSync(path);
}

/** 将 manifest 相对路径安全拼接到备份根，阻止路径穿越和符号链接。 */
function safeJoin(root: string, relativePath: string): string {
  const unsafePart = relativePath
    .split("/")
    .some((part) => !part || part === "." || part === "..");
  if (!relativePath || relativePath.includes("\\") || unsafePart) {
    throw new Error("manifest 路径不是安全相对路径");
  }
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error("manifest 路径越界");
  validateNoFollowPath(absolute);
  return absolute;
}

/** 递归列出备份中的普通文件，并拒绝未登记的符号链接节点。 */
function listFiles(root: string, current = ""): string[] {
  const directory = join(root, current);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const relativePath = current ? join(current, entry) : entry;
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`备份目录包含符号链接：${relativePath}`);
    return stat.isDirectory() ? listFiles(root, relativePath) : [relativePath.replaceAll("\\", "/")];
  });
}

/** 计算备份清单使用的 SHA-256 和字节长度。 */
function digest(bytes: Buffer): { sha256: string; size: number } {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

/** 扫描导出文本中的常见凭据形态，SQLite 二进制也会作为字节字符串检查。 */
function containsCredentialPattern(value: string): boolean {
  const credentialPattern = new RegExp(
    [
      "Bearer\\s+[A-Za-z0-9._~+/=-]+",
      "\\bsk-[A-Za-z0-9][A-Za-z0-9_-]*\\b",
      "(?:api[_ -]?key|password|secret|authorization)\\s*[:=]\\s*[^\\s,}\\]]+",
    ].join("|"),
    "i",
  );
  return credentialPattern.test(value);
}

/** 校验 manifest 中每个文件的相对路径、哈希格式和大小边界。 */
/** 解析并校验 manifest 的每个文件哈希对象，拒绝静默过滤坏字段。 */
function parseChecksums(value: object): BackupManifest["file_checksums"] {
  const checksums: BackupManifest["file_checksums"] = {};
  for (const [path, checksum] of Object.entries(value)) {
    if (!checksum || typeof checksum !== "object" || Array.isArray(checksum)) {
      throw new Error(`manifest.file_checksums.${path} 无效`);
    }
    const item = checksum as Record<string, unknown>;
    if (
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) < 0
    ) {
      throw new Error(`manifest.file_checksums.${path} 无效`);
    }
    checksums[path] = { sha256: item.sha256, size: Number(item.size) };
  }
  return checksums;
}

/** 判断候选目录是否位于指定源目录内，比较时保留路径分隔符边界。 */
/** 判断候选路径是否位于父目录内，比较时保留分隔符边界。 */
function isWithin(candidate: string, parent: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedParent = resolve(parent);
  return (
    resolvedCandidate === resolvedParent ||
    resolvedCandidate.startsWith(`${resolvedParent}${sep}`)
  );
}

/** 读取清单中的非负安全整数。 */
function integerField(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`manifest.${field} 无效`);
  return Number(value);
}

/** 生成 manifest 解析失败时的脱敏空结果。 */
function emptyManifest(): BackupManifest {
  return {
    backup_id: "unknown",
    created_at: "",
    application_version: "",
    schema_version: "",
    project_ids: [],
    artifact_count: 0,
    event_count: 0,
    trace_link_count: 0,
    file_checksums: {},
    redaction_policy_version: REDACTION_POLICY_VERSION,
    source_environment: "",
  };
}
