import { useQuery } from "@tanstack/react-query";
import { Button, Card, Descriptions, List, Space, Typography } from "antd";
import { getDashboard, getTask, queryKeys } from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";
import { StatusTag } from "../../components/StatusTag";

/** 展示任务持久化字段、负责人、依赖、预期交付物和下一步。 */
export function TaskDetailPage({
  projectId,
  taskId,
  onNavigate,
}: {
  projectId: string;
  taskId: string;
  onNavigate: (path: string) => void;
}) {
  const task = useQuery({
    queryKey: ["task", projectId, taskId],
    queryFn: () => getTask(projectId, taskId),
  });
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(projectId),
    queryFn: () => getDashboard(projectId),
  });
  if (task.isPending)
    return (
      <Card bordered={false}>
        <Typography.Title level={3}>正在读取任务</Typography.Title>
      </Card>
    );
  if (task.error || !task.data) return <ApiErrorCard error={task.error} />;
  const value = task.data;
  return (
    <div className="page-stack narrow-page">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">任务详情</Typography.Text>
          <Typography.Title level={1}>{value.title}</Typography.Title>
          <StatusTag value={value.status} />
        </div>
        <Button onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}>
          返回看板
        </Button>
      </div>
      <Card bordered={false}>
        <Descriptions column={1}>
          <Descriptions.Item label="负责人">
            {value.ownerRole}
          </Descriptions.Item>
          <Descriptions.Item label="专业标签">
            {String(value.specialistTag)}
          </Descriptions.Item>
          <Descriptions.Item label="分派理由">
            {String(value.assignmentReason)}
          </Descriptions.Item>
          <Descriptions.Item label="优先级">
            {String(value.priority)}
          </Descriptions.Item>
          <Descriptions.Item label="开始时间">
            {String(value.startedAt ?? "尚未开始")}
          </Descriptions.Item>
          <Descriptions.Item label="结束时间">
            {String(value.endedAt ?? "尚未结束")}
          </Descriptions.Item>
          <Descriptions.Item label="任务版本">
            {value.version}
          </Descriptions.Item>
        </Descriptions>
        <Space direction="vertical" className="full-width">
          <Typography.Title level={4}>前置依赖</Typography.Title>
          <List
            size="small"
            dataSource={(value.dependencies as string[]) ?? []}
            locale={{ emptyText: "无前置依赖" }}
            renderItem={(item) => <List.Item>{item}</List.Item>}
          />
          <Typography.Title level={4}>预期交付物</Typography.Title>
          <List
            size="small"
            dataSource={(value.expectedDeliverables as string[]) ?? []}
            locale={{ emptyText: "未提供预期交付物" }}
            renderItem={(item) => <List.Item>{item}</List.Item>}
          />
        </Space>
      </Card>
      {dashboard.data && (
        <Card title="下一步" bordered={false}>
          <Typography.Paragraph>
            {dashboard.data.nextAction}
          </Typography.Paragraph>
        </Card>
      )}
    </div>
  );
}
