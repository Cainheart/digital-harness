import { createApp } from "./main.js";

/** 启动只监听 127.0.0.1 的 TypeScript/Fastify sidecar。 */
async function main(): Promise<void> { const root = process.env.DIGITAL_HARNESS_PERSISTENT_ROOT ?? process.cwd(); const app = createApp({ persistentRoot: root }); if (process.argv.includes("--check")) { await app.ready(); const result = app.runtime.database.checkSchema(); console.log(JSON.stringify(result)); await app.close(); return; } const port = Number(process.env.DIGITAL_HARNESS_PORT ?? 8765); await app.listen({ host: "127.0.0.1", port }); }
void main();
