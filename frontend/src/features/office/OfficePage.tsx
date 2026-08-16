import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Tag,
  Typography,
} from "antd";
import { getOffice, queryKeys, type OfficeView } from "../../api/client";
import { DomainEventStream } from "../../api/sse";
import { ApiErrorCard } from "../../components/ApiErrorCard";

/** 展示真实 OfficeProjection；角色点击只导航到已有项目/任务详情入口。 */
export function OfficePage({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(true);
  const office = useQuery({
    queryKey: queryKeys.office(projectId),
    queryFn: () => getOffice(projectId),
  });

  useEffect(() => {
    const stream = new DomainEventStream();
    return stream.start(queryClient, projectId, (value) => setConnected(value));
  }, [projectId, queryClient]);

  if (office.isPending) return <PageState title="正在读取像素办公室快照" />;
  if (office.error || !office.data) {
    return <PageState title="像素办公室暂时不可用" error={office.error} />;
  }
  const view = office.data;
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">像素办公室 · 真实状态投影</Typography.Text>
          <Typography.Title level={1}>项目工作现场</Typography.Title>
          <Space wrap>
            <Tag color={connected ? "green" : "red"}>
              {connected ? "实时连接正常" : "实时连接已断开，显示最近快照"}
            </Tag>
            <Tag>阶段：{view.projectStage}</Tag>
            <Tag>快照版本：{view.snapshotVersion}</Tag>
          </Space>
        </div>
        <Space wrap>
          <Button onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}>项目看板</Button>
          <Button onClick={() => onNavigate(`/projects/${projectId}/scorecard`)}>项目评分卡</Button>
          <Button onClick={() => onNavigate(`/projects/${projectId}/executions`)}>真实执行控制台</Button>
        </Space>
      </div>
      <Alert
        type={connected ? "info" : "warning"}
        showIcon
        message={connected ? "办公室只呈现后端已提交事实" : "实时连接已断开"}
        description={
          "刷新或重连后会通过事件游标和最新快照补齐状态；页面动画不会改变业务状态。"
        }
      />
      <Row gutter={[16, 16]}>
        {view.rooms.map((room) => (
          <Col key={room.roomId} xs={24} md={12} xl={8}>
            <RoomCard room={room} onNavigate={onNavigate} projectId={projectId} />
          </Col>
        ))}
      </Row>
      <Card title="当前项目事实摘要" bordered={false}>
        <Space wrap>
          <Tag color="blue">活动任务 {view.activeTasks}</Tag>
          <Tag color={view.blockedTasks ? "red" : "default"}>阻塞任务 {view.blockedTasks}</Tag>
          <Tag color={view.pendingApprovals ? "orange" : "default"}>待审批 {view.pendingApprovals}</Tag>
          <Typography.Text type="secondary">最近事件：{view.lastEventId ?? "暂无"}</Typography.Text>
        </Space>
      </Card>
    </div>
  );
}

/** 展示一个后端投影房间，角色点击只发起导航而不修改状态。 */
function RoomCard({
  room,
  projectId,
  onNavigate,
}: {
  room: OfficeView["rooms"][number];
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card
      title={
        <Space>
          <span className={`office-room-dot office-room-${room.status.toLowerCase()}`} />
          {room.label}
        </Space>
      }
      bordered={false}
    >
      {room.occupants.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无员工进入该区域" />
      ) : (
        <div className="office-occupants">
          {room.occupants.map((occupant) => (
            <button
              className="office-occupant"
              key={occupant.workerId}
              type="button"
              onClick={() =>
                occupant.taskId
                  ? onNavigate(`/projects/${projectId}/tasks/${occupant.taskId}`)
                  : onNavigate(`/projects/${projectId}/approvals`)
              }
              aria-label={occupant.accessibilityLabel}
            >
              <span className="office-pixel-person" aria-hidden="true">
                {occupant.statusIcon}
              </span>
              <span className="office-occupant-copy">
                <strong>{occupant.displayName}</strong>
                <span>{occupant.role} · {occupant.statusLabel}</span>
                <span>{occupant.currentActivity}</span>
                {occupant.waitingFor ? <span>等待：{occupant.waitingFor}</span> : null}
              </span>
              <span
                className="office-status-bar"
                style={{ backgroundColor: occupant.statusColor }}
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/** 展示页面加载中或统一脱敏错误状态。 */
function PageState({ title, error }: { title: string; error?: unknown }) {
  return (
    <div className="page-stack">
      {error ? <ApiErrorCard error={error} /> : <Card loading title={title} />}
    </div>
  );
}
