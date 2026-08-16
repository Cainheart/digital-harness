import { describe, expect, it } from "vitest";
import { ProjectStatus, TaskStatus } from "../../src/domain/common.js";
import {
  assertProjectTransition,
  assertTaskTransition,
  PROJECT_TRANSITIONS,
  TASK_TRANSITIONS,
} from "../../src/workflow/state-machine.js";

describe("Task 4 explicit workflow state machines", () => {
  it.each([
    [ProjectStatus.PREPARING, ProjectStatus.RUNNING],
    [ProjectStatus.RUNNING, ProjectStatus.WAITING_BOSS],
    [ProjectStatus.RUNNING, ProjectStatus.PAUSED],
    [ProjectStatus.BLOCKED, ProjectStatus.RUNNING],
    [ProjectStatus.CLOSING, ProjectStatus.COMPLETED],
  ])("accepts the documented project edge %s -> %s", (from, to) => {
    expect(() =>
      assertProjectTransition(from, to, {
        gateCompleted: true,
        blockedResolved: true,
        resumeConfirmed: true,
        closingChecksPassed: true,
      }),
    ).not.toThrow();
  });

  it.each([
    [ProjectStatus.RUNNING, ProjectStatus.COMPLETED],
    [ProjectStatus.COMPLETED, ProjectStatus.RUNNING],
    [ProjectStatus.TERMINATED, ProjectStatus.RUNNING],
    [ProjectStatus.WAITING_BOSS, ProjectStatus.RUNNING],
  ])("blocks an illegal or unguarded project edge %s -> %s", (from, to) => {
    expect(() => assertProjectTransition(from, to)).toThrowError(
      /工作流门禁|人工关卡|结项检查/,
    );
  });

  it.each([
    [TaskStatus.PENDING, TaskStatus.RUNNING],
    [TaskStatus.RUNNING, TaskStatus.WAITING_REVIEW],
    [TaskStatus.WAITING_REVIEW, TaskStatus.REWORK],
    [TaskStatus.REWORK, TaskStatus.RUNNING],
  ])("accepts the documented task edge %s -> %s", (from, to) => {
    expect(() =>
      assertTaskTransition(from, to, {
        dependenciesSatisfied: true,
        evidenceComplete: true,
      }),
    ).not.toThrow();
  });

  it.each([
    [TaskStatus.COMPLETED, TaskStatus.RUNNING],
    [TaskStatus.TERMINATED, TaskStatus.RUNNING],
    [TaskStatus.PENDING, TaskStatus.COMPLETED],
  ])("blocks an illegal task edge %s -> %s", (from, to) => {
    expect(() => assertTaskTransition(from, to)).toThrowError(/工作流门禁/);
  });

  it("keeps the transition tables closed over the frozen status sets", () => {
    expect(Object.keys(PROJECT_TRANSITIONS)).toHaveLength(8);
    expect(Object.keys(TASK_TRANSITIONS)).toHaveLength(8);
    expect(PROJECT_TRANSITIONS[ProjectStatus.COMPLETED]).toEqual([]);
    expect(TASK_TRANSITIONS[TaskStatus.COMPLETED]).toEqual([]);
    expect(TASK_TRANSITIONS[TaskStatus.TERMINATED]).toEqual([]);
  });
});
