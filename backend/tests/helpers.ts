import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  ProjectStatus,
  TaskStatus,
  newObjectId,
  utcNow,
} from "../src/domain/common.js";
import { Project, Task } from "../src/domain/entities.js";
import { createApp } from "../src/main.js";

/** 为每个测试提供隔离的持久化根目录，并在测试结束后清理。 */
export function useTestRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "digital-harness-test-"));
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 构造完整的合法 Project 领域对象。 */
export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: newObjectId("project"),
    name: "测试项目",
    businessGoal: "验证 TypeScript 控制面",
    targetUsers: "工程团队",
    priority: "P1",
    deadline: null,
    constraints: {},
    stage: "立项",
    status: ProjectStatus.PREPARING,
    createdAt: utcNow(),
    endedAt: null,
    version: 1,
    readOnly: false,
    ...overrides,
  };
}
/** 构造完整的合法 Task 领域对象。 */
export function makeTask(
  projectId: string,
  overrides: Partial<Task> = {},
): Task {
  return {
    id: newObjectId("task"),
    projectId,
    title: "实现基础能力",
    ownerRole: "developer",
    specialistTag: "backend",
    assignmentReason: "Task 2 验收",
    priority: "P1",
    dependencies: ["foundation"],
    expectedDeliverables: ["source", "tests"],
    status: TaskStatus.PENDING,
    createdAt: utcNow(),
    startedAt: null,
    endedAt: null,
    version: 1,
    ...overrides,
  };
}
/** 创建已经初始化的 Fastify 测试应用。 */
export async function createTestApp(root: string) {
  const app = createApp({ persistentRoot: root, testMode: true });
  await app.ready();
  return app;
}
