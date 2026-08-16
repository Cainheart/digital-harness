import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  List,
  Space,
  Tabs,
  Typography,
} from "antd";
import { getArchiveDetail, queryKeys } from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";
import { StatusTag } from "../../components/StatusTag";

/** 只读查看历史项目的看板、任务、交付物和事件，不渲染任何写操作。 */
export function ArchiveDetailPage({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const archive = useQuery({
    queryKey: queryKeys.archiveDetail(projectId),
    queryFn: () => getArchiveDetail(projectId),
  });
  if (archive.isPending)
    return (
      <Card bordered={false}>
        <Typography.Title level={3}>正在读取历史项目</Typography.Title>
      </Card>
    );
  if (archive.error || !archive.data)
    return <ApiErrorCard error={archive.error} />;
  const view = archive.data;
  const dashboard = view.dashboard as Record<string, unknown>;
  const project = dashboard.project as Record<string, unknown>;
  const tasks = (dashboard.tasks as Array<Record<string, unknown>>) ?? [];
  const artifacts =
    (dashboard.artifacts as Array<Record<string, unknown>>) ?? [];
  const events = (dashboard.events as Array<Record<string, unknown>>) ?? [];
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">历史只读复盘</Typography.Text>
          <Typography.Title level={1}>{String(view.name)}</Typography.Title>
          <Space>
            <StatusTag value={String(view.finalStatus)} />
            <Typography.Text>重新打开不会恢复运行</Typography.Text>
          </Space>
        </div>
        <Button onClick={() => onNavigate("/archive")}>返回存档</Button>
      </div>
      <Alert
        type="info"
        showIcon
        message="这是只读历史项目"
        description="此页面不提供启动、修改、审批、暂停、恢复或终止入口。"
      />
      <Card bordered={false}>
        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="业务目标">
            {String(project.businessGoal)}
          </Descriptions.Item>
          <Descriptions.Item label="目标用户">
            {String(project.targetUsers)}
          </Descriptions.Item>
          <Descriptions.Item label="优先级">
            {String(view.priority)}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {String(view.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label="结束时间">
            {String(view.endedAt ?? "未记录")}
          </Descriptions.Item>
          <Descriptions.Item label="最终评估">
            {String(view.finalEvaluation)}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Tabs
        items={[
          {
            key: "tasks",
            label: "任务",
            children: (
              <List
                dataSource={tasks}
                locale={{ emptyText: "没有任务记录" }}
                renderItem={(task) => (
                  <List.Item>
                    <List.Item.Meta
                      title={String(task.title)}
                      description={`${String(task.ownerRole)} · ${String(task.status)} · ${String(task.createdAt)}`}
                    />
                  </List.Item>
                )}
              />
            ),
          },
          {
            key: "artifacts",
            label: "交付物",
            children: (
              <List
                dataSource={artifacts}
                locale={{ emptyText: "没有交付物记录" }}
                renderItem={(artifact) => (
                  <List.Item>
                    <List.Item.Meta
                      title={String(artifact.name)}
                      description={JSON.stringify(artifact)}
                    />
                  </List.Item>
                )}
              />
            ),
          },
          {
            key: "events",
            label: "事件",
            children: (
              <List
                dataSource={events}
                locale={{ emptyText: "没有事件记录" }}
                renderItem={(event) => (
                  <List.Item>
                    <List.Item.Meta
                      title={String(event.eventType)}
                      description={`${String(event.occurredAt)} · ${String(event.result)} · ${String(event.traceId)}`}
                    />
                  </List.Item>
                )}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
