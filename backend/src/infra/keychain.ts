import { randomUUID } from "node:crypto";

/** 外部调用边界的短时凭据租约；toString 不暴露明文。 */
export class SecretLease {
  constructor(readonly secret: string) {}
  /** 防止诊断或日志意外打印密钥正文。 */
  toString(): string { return "[SecretLease REDACTED]"; }
  /** 防止 console.inspect 意外打印密钥正文。 */
  [Symbol.for("nodejs.util.inspect.custom")](): string { return this.toString(); }
}
/** 不返回明文的凭据检查结果。 */
export type CredentialCheckResult = { available: boolean; message: string };
/** OS Keychain 的统一 TypeScript 适配边界。 */
export interface CredentialAdapter { save(provider: string, secret: string): Promise<string>; read(secretRef: string): Promise<SecretLease>; delete(secretRef: string): Promise<void>; check(secretRef: string): Promise<CredentialCheckResult>; }

/** 测试和本地诊断使用的内存凭据适配器；明文只存在进程内。 */
export class MemoryCredentialAdapter implements CredentialAdapter {
  private readonly values = new Map<string, { provider: string; secret: string }>();
  /** 保存凭据并只返回不可推断的引用。 */
  async save(provider: string, secret: string): Promise<string> { const ref = `memory://${provider}/${randomUUID()}`; this.values.set(ref, { provider, secret }); return ref; }
  /** 在实际调用边界读取短时租约。 */
  async read(secretRef: string): Promise<SecretLease> { const item = this.values.get(secretRef); if (!item) throw new Error("credential unavailable"); return new SecretLease(item.secret); }
  /** 删除进程内凭据。 */
  async delete(secretRef: string): Promise<void> { this.values.delete(secretRef); }
  /** 只返回是否存在且非空。 */
  async check(secretRef: string): Promise<CredentialCheckResult> { const item = this.values.get(secretRef); return item?.secret ? { available: true, message: "credential available" } : { available: false, message: "credential unavailable" }; }
  /** 清空测试替身中的全部明文。 */
  clear(): void { this.values.clear(); }
}

/** 使用系统命令访问 macOS Keychain；其他平台以明确阻断替代静默落盘。 */
export class SystemCredentialAdapter implements CredentialAdapter {
  private readonly service: string;
  /** 绑定仅供 sidecar 使用的 Keychain service 名称。 */
  constructor(service = "digital-harness") { this.service = service; }
  /** 保存到 OS Keychain 并返回 secretRef；密钥不进入 SQLite。 */
  async save(provider: string, secret: string): Promise<string> {
    const ref = `keychain://${provider}/${randomUUID()}`;
    if (process.platform !== "darwin") throw new Error("OS Keychain adapter requires a platform implementation");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("security", ["add-generic-password", "-a", ref, "-s", this.service, "-w", secret, "-U"], (error) => error ? reject(new Error("OS Keychain save failed")) : resolve()));
    return ref;
  }
  /** 从 OS Keychain 读取短时 SecretLease。 */
  async read(secretRef: string): Promise<SecretLease> { const value = await this.runSecurity(["find-generic-password", "-a", secretRef, "-s", this.service, "-w"]); return new SecretLease(value.trim()); }
  /** 从 OS Keychain 删除指定引用。 */
  async delete(secretRef: string): Promise<void> { await this.runSecurity(["delete-generic-password", "-a", secretRef, "-s", this.service]); }
  /** 只探测引用是否可读取，不返回明文。 */
  async check(secretRef: string): Promise<CredentialCheckResult> { try { await this.read(secretRef); return { available: true, message: "credential available" }; } catch { return { available: false, message: "credential unavailable" }; } }
  private async runSecurity(args: string[]): Promise<string> { if (process.platform !== "darwin") throw new Error("OS Keychain adapter requires a platform implementation"); const { execFile } = await import("node:child_process"); return new Promise((resolve, reject) => execFile("security", args, { encoding: "utf8" }, (error, stdout) => error ? reject(new Error("OS Keychain operation failed")) : resolve(stdout))); }
}
