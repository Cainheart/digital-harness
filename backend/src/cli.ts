import { createApp } from "./main.js";

/** 启动只监听 127.0.0.1 的 TypeScript/Fastify sidecar。 */
async function main(): Promise<void> {
  const root = process.env.DIGITAL_HARNESS_PERSISTENT_ROOT ?? process.cwd();
  const app = createApp({ persistentRoot: root });
  try {
    const command = process.argv[2];
    if (command && command !== "--check") {
      await app.ready();
      const result = await runOpsCommand(app, command, process.argv.slice(3));
      if (result !== null) {
        console.log(JSON.stringify(result, null, 2));
        await app.close();
        return;
      }
    }
    if (process.argv.includes("--check")) {
      await app.ready();
      const result = app.runtime.database.checkSchema();
      console.log(JSON.stringify(result));
      await app.close();
      return;
    }

    await app.listen({
      host: app.runtime.settings.host,
      port: app.runtime.settings.port,
    });
  } catch (error) {
    await app.close();
    throw error;
  }
}

/** 执行受保护的本地备份/校验/恢复命令，恢复应用前必须先 validate。 */
async function runOpsCommand(
  app: Awaited<ReturnType<typeof createApp>>,
  command: string,
  args: string[],
): Promise<unknown | null> {
  if (command === "--backup-create") {
    return app.runtime.backup.create(requiredArg(args, "--output"), projectArgs(args));
  }
  if (command === "--backup-verify") {
    return app.runtime.backup.verify(requiredArg(args, "--input"));
  }
  if (command === "--restore-validate") {
    return app.runtime.restore.validate(
      requiredArg(args, "--input"),
      requiredArg(args, "--target"),
    );
  }
  if (command === "--restore-apply") {
    return app.runtime.restore.apply(
      requiredArg(args, "--input"),
      requiredArg(args, "--target"),
      requiredArg(args, "--change-ticket"),
    );
  }
  return null;
}

/** 读取命令参数并拒绝缺失值，避免把空路径传入运维服务。 */
function requiredArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} 参数不能为空`);
  return value;
}

/** 解析可重复的项目筛选参数；未提供时备份所有已存在项目。 */
function projectArgs(args: string[]): string[] | undefined {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--project") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--project 参数不能为空");
      values.push(value);
      index += 1;
    }
  }
  return values.length > 0 ? values : undefined;
}

/** 输出不含凭据和请求正文的启动错误，并返回非零进程状态。 */
void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "sidecar 启动失败";
  console.error(message);
  process.exitCode = 1;
});
