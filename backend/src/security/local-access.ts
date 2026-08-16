import { isIP } from "node:net";
import { RuntimeBoundaryError } from "../api/errors.js";

/** 返回 Fastify 请求的可信来源地址；测试模式允许专用头注入地址。 */
export function trustedClientHost(request: { ip: string; headers: Record<string, string | string[] | undefined> }, testMode: boolean): string { if (testMode) { const injected = request.headers["x-test-remote-address"]; return typeof injected === "string" ? injected : "127.0.0.1"; } return request.ip; }
/** 拒绝非回环地址请求，保证控制面默认只服务本机。 */
export function assertLocalRequest(request: { ip: string; headers: Record<string, string | string[] | undefined> }, testMode: boolean, traceId: string): void { const host = trustedClientHost(request, testMode); const loopback = isIP(host) === 4 ? host === "127.0.0.1" || host.startsWith("127.") : host === "::1" || host.toLowerCase().startsWith("fe80::1"); if (!loopback) throw new RuntimeBoundaryError({ code: "POLICY_DENIED", message: "仅允许本机访问控制面", impact: "当前请求未执行任何业务操作", dataPreserved: true, nextAction: "从运行产品的本机访问，或检查监听地址配置", traceId, statusCode: 403 }); }
