import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReadinessPage } from "./ReadinessPage";

const readyCheck = {
  status: "ready" as const,
  message: "可用",
  impact: null,
  nextAction: null,
  details: {},
};

const blockedCheck = {
  status: "blocked" as const,
  message: "浏览器不可用",
  impact: "公开资料调研不可用",
  nextAction: "安装 Chromium",
  details: {},
};

vi.mock("../../api/readiness", () => ({
  fetchReadiness: vi.fn(async () => ({
    status: "blocked",
    checkedAt: "2026-08-12T10:20:30Z",
    checks: {
      model: readyCheck,
      research: blockedCheck,
      workspace: readyCheck,
      docker: readyCheck,
      persistence: readyCheck,
    },
    allowedActions: [],
    traceId: "tr_frontend_test",
  })),
}));

describe("ReadinessPage", () => {
  it("renders all five checks and their impact/next action", async () => {
    render(<ReadinessPage />);

    expect(await screen.findByText("模型服务")).toBeInTheDocument();
    expect(screen.getByText("浏览器不可用")).toBeInTheDocument();
    expect(screen.getByText(/安装 Chromium/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
  });

  it("does not expose an enabled real-execution action when readiness is blocked", async () => {
    render(<ReadinessPage />);

    expect(await screen.findByRole("button", { name: "启动 Digital Harness" })).toBeDisabled();
  });
});
