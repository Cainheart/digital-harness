import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Empty, List, Space, Tag, Typography } from "antd";
import {
  acknowledgeNotification,
  getNotifications,
  queryKeys,
} from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";
import { StatusTag } from "../../components/StatusTag";

/** 站内通知默认是完整事实源；打开详情不会自动变更通知处理状态。 */
export function NotificationsPage({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const notifications = useQuery({
    queryKey: queryKeys.notifications(projectId),
    queryFn: () => getNotifications(projectId),
  });
  const acknowledge = useMutation({
    mutationFn: (item: { id: string; version: number }) =>
      acknowledgeNotification(item.id, item.version),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.notifications(projectId),
      }),
  });
  if (notifications.isPending)
    return (
      <Card bordered={false}>
        <Typography.Title level={3}>正在读取通知</Typography.Title>
      </Card>
    );
  if (notifications.error || !notifications.data)
    return <ApiErrorCard error={notifications.error} />;
  return (
    <div className="page-stack narrow-page">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">项目通知</Typography.Text>
          <Typography.Title level={1}>通知中心</Typography.Title>
        </div>
        <Button onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}>
          返回看板
        </Button>
      </div>
      <Card bordered={false}>
        <List
          locale={{ emptyText: <Empty description="当前没有站内通知" /> }}
          dataSource={notifications.data.items}
          renderItem={(item) => (
            <List.Item
              actions={[
                item.pending &&
                item.notificationType === "approval_required" ? (
                  <Button
                    key="approval"
                    type="primary"
                    onClick={() =>
                      onNavigate(
                        `/projects/${projectId}/approvals/${item.subjectId}`,
                      )
                    }
                  >
                    去审批
                  </Button>
                ) : item.pending ? (
                  <Button
                    key="read"
                    onClick={() =>
                      acknowledge.mutate({ id: item.id, version: item.version })
                    }
                    loading={acknowledge.isPending}
                  >
                    标记已阅
                  </Button>
                ) : (
                  <Tag key="done" color="green">
                    已处理
                  </Tag>
                ),
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <StatusTag
                      value={
                        item.severity === "P0"
                          ? "阻塞"
                          : item.pending
                            ? "等待人工"
                            : "已完成"
                      }
                    />
                    {notificationLabel(item.notificationType)}
                    {item.pending && <Tag color="orange">待闭环</Tag>}
                  </Space>
                }
                description={
                  <span>
                    {item.reasonSummary ??
                      item.action ??
                      "关联业务状态发生变化"}
                    <br />
                    发生时间：{item.createdAt} · trace：{item.traceId}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
}

function notificationLabel(value: string): string {
  const labels: Record<string, string> = {
    approval_required: "待审批",
    major_risk: "重大风险",
    system_error: "系统异常",
    task_blocked: "任务阻塞",
    deadline_risk: "期限风险",
    project_completed: "项目结项",
    project_terminated: "项目终止",
    project_paused: "项目暂停",
  };
  return labels[value] ?? value;
}
