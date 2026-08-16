import { useEffect, useMemo, useState } from "react";
import { Layout, Menu, Typography } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { DomainEventStream } from "../api/sse";
import { ReadinessPage } from "../features/readiness/ReadinessPage";
import { OnboardingPage } from "../features/onboarding/OnboardingPage";
import { ProjectInitiationPage } from "../features/project-initiation/ProjectInitiationPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ApprovalsPage } from "../features/approvals/ApprovalsPage";
import { NotificationsPage } from "../features/notifications/NotificationsPage";
import { ModelSettingsPage } from "../features/model-settings/ModelSettingsPage";
import { ArchivePage } from "../features/archive/ArchivePage";
import { ArchiveDetailPage } from "../features/archive/ArchiveDetailPage";
import { TaskDetailPage } from "../features/tasks/TaskDetailPage";
import { ArtifactDetailPage } from "../features/artifacts/ArtifactDetailPage";

const { Header, Sider, Content } = Layout;

/** 在桌面 Renderer 内提供业务路由和统一导航，不承载任何业务决策。 */
export function AppRouter() {
  const [path, setPath] = useState(window.location.pathname);
  const queryClient = useQueryClient();

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const projectId = useMemo(
    () => match(path, /^\/projects\/([^/]+)/)?.[1] ?? null,
    [path],
  );
  useEffect(() => {
    const stream = new DomainEventStream();
    return stream.start(queryClient, projectId ?? undefined);
  }, [projectId, queryClient]);

  const navigate = (target: string) => {
    window.history.pushState({}, "", target);
    setPath(target);
  };

  return (
    <Layout className="app-layout">
      <Sider breakpoint="lg" collapsedWidth="0" theme="light">
        <div
          className="brand-mark"
          onClick={() => navigate("/onboarding")}
          role="button"
          tabIndex={0}
        >
          <span className="brand-dot">DH</span>
          <span>Digital Harness</span>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[menuKey(path)]}
          items={[
            { key: "/onboarding", label: "首次了解" },
            { key: "/readiness", label: "运行准备" },
            { key: "/projects/new", label: "新建项目" },
            { key: "/archive", label: "历史存档" },
            { key: "/settings/models", label: "模型设置" },
          ]}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header className="topbar">
          <Typography.Text>本机单 Boss 控制台</Typography.Text>
          <Typography.Text type="secondary">
            业务状态以持久化事实为准
          </Typography.Text>
        </Header>
        <Content className="page-content">
          {renderRoute(path, navigate)}
        </Content>
      </Layout>
    </Layout>
  );
}

/** 将路径映射到业务页面；历史项目路径优先于活动项目通配路径。 */
function renderRoute(path: string, navigate: (path: string) => void) {
  if (path === "/" || path === "/onboarding")
    return <OnboardingPage onNavigate={navigate} />;
  if (path === "/readiness") return <ReadinessPage onNavigate={navigate} />;
  if (path === "/projects/new")
    return <ProjectInitiationPage onNavigate={navigate} />;
  if (path === "/settings/models") return <ModelSettingsPage />;
  if (path === "/archive") return <ArchivePage onNavigate={navigate} />;

  const archiveMatch = match(path, /^\/archive\/([^/]+)$/);
  if (archiveMatch)
    return (
      <ArchiveDetailPage projectId={archiveMatch[1]} onNavigate={navigate} />
    );
  const taskMatch = match(path, /^\/projects\/([^/]+)\/tasks\/([^/]+)$/);
  if (taskMatch)
    return (
      <TaskDetailPage
        projectId={taskMatch[1]}
        taskId={taskMatch[2]}
        onNavigate={navigate}
      />
    );
  const artifactMatch = match(
    path,
    /^\/projects\/([^/]+)\/artifacts\/([^/]+)$/,
  );
  if (artifactMatch)
    return (
      <ArtifactDetailPage
        projectId={artifactMatch[1]}
        artifactId={artifactMatch[2]}
        onNavigate={navigate}
      />
    );
  const approvalMatch = match(
    path,
    /^\/projects\/([^/]+)\/approvals(?:\/([^/]+))?$/,
  );
  if (approvalMatch)
    return (
      <ApprovalsPage
        projectId={approvalMatch[1]}
        approvalId={approvalMatch[2]}
        onNavigate={navigate}
      />
    );
  const notificationMatch = match(path, /^\/projects\/([^/]+)\/notifications$/);
  if (notificationMatch)
    return (
      <NotificationsPage
        projectId={notificationMatch[1]}
        onNavigate={navigate}
      />
    );
  const dashboardMatch = match(path, /^\/projects\/([^/]+)\/dashboard$/);
  if (dashboardMatch)
    return (
      <DashboardPage projectId={dashboardMatch[1]} onNavigate={navigate} />
    );
  return <OnboardingPage onNavigate={navigate} />;
}

function match(path: string, pattern: RegExp): string[] | null {
  return pattern.exec(path)?.slice(1) ?? null;
}

function menuKey(path: string): string {
  if (path.startsWith("/readiness")) return "/readiness";
  if (path.startsWith("/projects/new")) return "/projects/new";
  if (path.startsWith("/archive")) return "/archive";
  if (path.startsWith("/settings/models")) return "/settings/models";
  return "/onboarding";
}
