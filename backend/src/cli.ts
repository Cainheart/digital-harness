import { createApp } from "./main.js";

/** 启动只监听 127.0.0.1 的 TypeScript/Fastify sidecar。 */
async function main(): Promise<void> {
  const root = process.env.DIGITAL_HARNESS_PERSISTENT_ROOT ?? process.cwd();
  const app = createApp({ persistentRoot: root });
  try {
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

/** 输出不含凭据和请求正文的启动错误，并返回非零进程状态。 */
void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "sidecar 启动失败";
  console.error(message);
  process.exitCode = 1;
});
