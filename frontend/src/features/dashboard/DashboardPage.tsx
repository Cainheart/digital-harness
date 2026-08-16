import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Input,
  List,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  getDashboard,
  queryKeys,
  projectCommand,
  previewTermination,
  confirmTermination,
  DashboardView,
} from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";
import { StatusTag } from "../../components/StatusTag";

/** 展示持久化项目状态、人工待办、员工、证据和模型摘要。 */
export function DashboardPage({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(projectId),
    queryFn: () => getDashboard(projectId),
  });
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminateReason, setTerminateReason] = useState("");
  const [terminationPreview, setTerminationPreview] = useState<Awaited<
    ReturnType<typeof previewTermination>
  > | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: queryKeys.dashboard(projectId),
    });
  const control = useMutation({
    mutationFn: ({
      action,
      payload,
    }: {
      action: "pause" | "resume";
      payload: Record<string, unknown>;
    }) =>
      projectCommand(
        projectId,
        action,
        dashboard.data?.project.version ?? 0,
        payload,
      ),
    onSuccess: refresh,
    onError: setActionError,
  });

  const beginTermination = async () => {
    if (!dashboard.data || !terminateReason.trim()) return;
    try {
      setActionError(null);
      const preview = await previewTermination(
        projectId,
        dashboard.data.project.version,
        terminateReason,
      );
      setTerminationPreview(preview);
    } catch (cause) {
      setActionError(cause);
    }
  };

  const confirmTerminationAction = async () => {
    if (!dashboard.data || !terminationPreview) return;
    try {
      setActionError(null);
      await confirmTermination(
        projectId,
        dashboard.data.project.version,
        terminateReason,
        terminationPreview.confirmationToken,
      );
      setTerminateOpen(false);
      setTerminationPreview(null);
      refresh();
    } catch (cause) {
      setActionError(cause);
    }
  };

  if (dashboard.isPending) return <PageState title="正在读取项目看板" />;
  if (dashboard.error || !dashboard.data)
    return <PageState title="看板暂时不可用" error={dashboard.error} />;
  const view = dashboard.data;
  const progress = view.progress.taskTotal
    ? Math.round((view.progress.taskCompleted / view.progress.taskTotal) * 100)
    : 0;
  const canPause = view.allowedActions.includes("pause");
  const canResume = view.allowedActions.includes("resume");
  const canTerminate = view.allowedActions.includes("terminate_preview");

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">项目看板</Typography.Text>
          <Typography.Title level={1}>{view.project.name}</Typography.Title>
          <Space>
            <StatusTag value={view.project.status} />
            <Tag>{view.project.priority}</Tag>
            <Typography.Text>当前阶段：{view.project.stage}</Typography.Text>
          </Space>
        </div>
        <Space wrap>
          <Button
            onClick={() => onNavigate(`/projects/${projectId}/notifications`)}
          >
            通知中心
          </Button>
          <Button
            onClick={() => onNavigate(`/projects/${projectId}/approvals`)}
          >
            审批与风险
          </Button>
          {canPause && (
            <Button onClick={() => setPauseOpen(true)}>暂停项目</Button>
          )}
          {canResume && (
            <Button
              onClick={() =>
                control.mutate({
                  action: "resume",
                  payload: { blockedResolved: true, resumeConfirmed: true },
                })
              }
              loading={control.isPending}
            >
              恢复项目
            </Button>
          )}
          {canTerminate && (
            <Button
              danger
              onClick={() => {
                setTerminateOpen(true);
                setTerminationPreview(null);
              }}
            >
              终止项目
            </Button>
          )}
        </Space>
      </div>
      {actionError ? <ApiErrorCard error={actionError} /> : null}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card title="项目摘要" bordered={false}>
            <Descriptions column={{ xs: 1, sm: 2, lg: 3 }}>
              <Descriptions.Item label="业务目标">
                {view.project.businessGoal}
              </Descriptions.Item>
              <Descriptions.Item label="目标用户">
                {view.project.targetUsers}
              </Descriptions.Item>
              <Descriptions.Item label="截止时间">
                {view.project.deadline ?? "未设置"}
              </Descriptions.Item>
              <Descriptions.Item label="下一步">
                {view.nextAction}
              </Descriptions.Item>
              <Descriptions.Item label="已知约束">
                {formatConstraints(view.project.constraints)}
              </Descriptions.Item>
              <Descriptions.Item label="项目版本">
                {view.project.version}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title="进度与模型摘要" bordered={false}>
            <Progress
              percent={progress}
              format={(value) => `任务完成 ${value}%`}
            />
            <Row gutter={8}>
              <Col span={12}>
                <Statistic title="任务总数" value={view.progress.taskTotal} />
              </Col>
              <Col span={12}>
                <Statistic title="已完成" value={view.progress.taskCompleted} />
              </Col>
              <Col span={12}>
                <Statistic title="返工" value={view.progress.taskRework} />
              </Col>
              <Col span={12}>
                <Statistic
                  title="未关闭缺陷"
                  value={view.progress.openDefects}
                />
              </Col>
            </Row>
            <Divider />
            <Typography.Text type="secondary">
              模型调用 {view.modelSummary.callCount ?? 0} 次 · 耗时{" "}
              {view.modelSummary.durationMs ?? 0} ms · 错误{" "}
              {view.modelSummary.errors ?? 0} 次 · Token{" "}
              {view.modelSummary.totalTokens ?? 0} · 成本{" "}
              {view.modelSummary.costMicros ?? 0} 微单位
            </Typography.Text>
          </Card>
        </Col>
      </Row>
      {view.pause && (
        <Alert
          type="warning"
          showIcon
          message="项目当前有暂停信息"
          description={
            <Descriptions column={1} size="small">
              <Descriptions.Item label="原因">
                {String(view.pause.reason)}
              </Descriptions.Item>
              <Descriptions.Item label="影响">
                {arrayText(view.pause.impactScope)}
              </Descriptions.Item>
              <Descriptions.Item label="等待对象">
                {String(view.pause.waitingFor)}
              </Descriptions.Item>
              <Descriptions.Item label="恢复条件">
                {String(view.pause.recoveryCondition)}
              </Descriptions.Item>
            </Descriptions>
          }
        />
      )}
      <Card title="阶段状态" bordered={false}>
        <StepsView phases={view.phases} />
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            title="Boss 待处理"
            bordered={false}
            extra={
              <Button
                type="link"
                onClick={() => onNavigate(`/projects/${projectId}/approvals`)}
              >
                查看全部
              </Button>
            }
          >
            <List
              locale={{ emptyText: "当前没有待处理审批、重大风险或系统异常" }}
              dataSource={view.notifications
                .filter((item) => item.pending)
                .slice(0, 5)}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Button
                      key="open"
                      type="link"
                      onClick={() =>
                        onNavigate(`/projects/${projectId}/notifications`)
                      }
                    >
                      查看
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <StatusTag
                          value={item.severity === "P0" ? "阻塞" : "等待人工"}
                        />
                        {notificationLabel(item.notificationType)}
                      </Space>
                    }
                    description={
                      item.reasonSummary ??
                      item.action ??
                      "需要查看关联业务对象"
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="当前员工与任务" bordered={false}>
            <Table
              size="small"
              pagination={false}
              rowKey="instanceId"
              dataSource={view.employees.slice(0, 8)}
              columns={[
                {
                  title: "员工",
                  render: (_: unknown, row: Record<string, unknown>) => (
                    <span>
                      {String(row.displayName)}
                      <br />
                      <Typography.Text type="secondary">
                        {String(row.title)}
                      </Typography.Text>
                    </span>
                  ),
                },
                {
                  title: "状态",
                  render: (_: unknown, row: Record<string, unknown>) => (
                    <StatusTag value={String(row.status)} />
                  ),
                },
                {
                  title: "当前任务",
                  render: (_: unknown, row: Record<string, unknown>) => {
                    const task = row.currentTask as Record<
                      string,
                      unknown
                    > | null;
                    return task ? (
                      <Button
                        type="link"
                        onClick={() =>
                          onNavigate(
                            `/projects/${projectId}/tasks/${String(task.id)}`,
                          )
                        }
                      >
                        {String(task.title)}
                      </Button>
                    ) : (
                      "暂无任务"
                    );
                  },
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
      <Tabs
        items={[
          {
            key: "tasks",
            label: "任务",
            children: (
              <TaskTable
                tasks={view.tasks}
                projectId={projectId}
                onNavigate={onNavigate}
              />
            ),
          },
          {
            key: "artifacts",
            label: "最新交付物",
            children: (
              <ArtifactList
                artifacts={view.latestArtifacts}
                projectId={projectId}
                onNavigate={onNavigate}
              />
            ),
          },
          {
            key: "events",
            label: "最新事件",
            children: <EventList events={view.latestEvents} />,
          },
          {
            key: "risks",
            label: "风险",
            children: (
              <RiskList
                risks={view.risks}
                projectId={projectId}
                onNavigate={onNavigate}
              />
            ),
          },
        ]}
      />
      <Modal
        title="暂停项目"
        open={pauseOpen}
        onCancel={() => setPauseOpen(false)}
        onOk={() => {
          if (!pauseReason.trim()) return;
          control.mutate({
            action: "pause",
            payload: {
              reason: pauseReason,
              impactScope: ["当前项目流程"],
              waitingFor: "Boss",
              availableActions: ["查看状态", "恢复或终止"],
              recoveryCondition: "暂停原因已处理",
            },
          });
          setPauseOpen(false);
        }}
        okText="确认暂停"
        cancelText="取消"
        confirmLoading={control.isPending}
      >
        <Typography.Paragraph>
          暂停会停止启动新的后续任务，已有数据会保留。请说明原因。
        </Typography.Paragraph>
        <Input.TextArea
          rows={4}
          value={pauseReason}
          onChange={(event) => setPauseReason(event.target.value)}
          placeholder="例如：需要重新确认项目方向"
        />
      </Modal>
      <Modal
        title="终止项目"
        open={terminateOpen}
        onCancel={() => {
          setTerminateOpen(false);
          setTerminationPreview(null);
        }}
        footer={
          terminationPreview
            ? [
                <Button key="cancel" onClick={() => setTerminateOpen(false)}>
                  取消
                </Button>,
                <Button
                  key="confirm"
                  danger
                  onClick={() => void confirmTerminationAction()}
                >
                  我已理解，确认终止
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setTerminateOpen(false)}>
                  取消
                </Button>,
                <Button
                  key="preview"
                  danger
                  onClick={() => void beginTermination()}
                  disabled={!terminateReason.trim()}
                >
                  查看终止影响
                </Button>,
              ]
        }
      >
        {!terminationPreview ? (
          <>
            <Typography.Paragraph>
              终止后项目会进入历史存档，只能查看，不能恢复为活动项目。请先填写原因。
            </Typography.Paragraph>
            <Input.TextArea
              rows={4}
              value={terminateReason}
              onChange={(event) => setTerminateReason(event.target.value)}
              placeholder="请说明终止原因"
            />
          </>
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              message="这是第二次明确确认"
              description={terminationPreview.impact}
            />
            <Typography.Paragraph>
              未完成任务：{terminationPreview.unfinishedTasks.length}{" "}
              个。确认后不会产生新的执行任务。
            </Typography.Paragraph>
          </>
        )}
      </Modal>
    </div>
  );
}

function StepsView({ phases }: { phases: DashboardView["phases"] }) {
  return (
    <div className="phase-list">
      {phases.map((phase) => (
        <div
          className={`phase-item ${phase.isCurrent ? "current" : ""}`}
          key={phase.stage}
        >
          <StatusTag value={phase.status} />
          <span>{phase.stage}</span>
        </div>
      ))}
    </div>
  );
}

function TaskTable({
  tasks,
  projectId,
  onNavigate,
}: {
  tasks: Array<Record<string, unknown>>;
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Table
      rowKey="id"
      dataSource={tasks}
      pagination={false}
      columns={[
        {
          title: "任务",
          render: (_: unknown, row: Record<string, unknown>) => (
            <Button
              type="link"
              onClick={() =>
                onNavigate(`/projects/${projectId}/tasks/${String(row.id)}`)
              }
            >
              {String(row.title)}
            </Button>
          ),
        },
        { title: "负责人", dataIndex: "ownerRole" },
        { title: "专业标签", dataIndex: "specialistTag" },
        {
          title: "状态",
          render: (_: unknown, row: Record<string, unknown>) => (
            <StatusTag value={String(row.status)} />
          ),
        },
        {
          title: "开始时间",
          dataIndex: "startedAt",
          render: (value: unknown) => (value ? String(value) : "尚未开始"),
        },
      ]}
    />
  );
}

function ArtifactList({
  artifacts,
  projectId,
  onNavigate,
}: {
  artifacts: Array<Record<string, unknown>>;
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <List
      dataSource={artifacts}
      locale={{ emptyText: "还没有交付物" }}
      renderItem={(artifact) => (
        <List.Item
          actions={[
            <Button
              key="open"
              type="link"
              onClick={() =>
                onNavigate(
                  `/projects/${projectId}/artifacts/${String(artifact.id)}`,
                )
              }
            >
              查看详情
            </Button>,
          ]}
        >
          <List.Item.Meta
            title={String(artifact.name)}
            description={`${String(artifact.artifact_type)} · ${String(artifact.status)} · 负责人 ${String(artifact.owner_role)}`}
          />
        </List.Item>
      )}
    />
  );
}

function EventList({ events }: { events: Array<Record<string, unknown>> }) {
  return (
    <List
      dataSource={events}
      locale={{ emptyText: "还没有事件" }}
      renderItem={(event) => (
        <List.Item>
          <List.Item.Meta
            title={String(event.eventType)}
            description={`${String(event.occurredAt)} · ${String(event.result)} · trace ${String(event.traceId)}`}
          />
        </List.Item>
      )}
    />
  );
}

function RiskList({
  risks,
  projectId,
  onNavigate,
}: {
  risks: Array<Record<string, unknown>>;
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <List
      dataSource={risks}
      locale={{ emptyText: "当前没有风险记录" }}
      renderItem={(risk) => (
        <List.Item
          actions={[
            risk.approvalId ? (
              <Button
                key="approval"
                type="link"
                onClick={() =>
                  onNavigate(
                    `/projects/${projectId}/approvals/${String(risk.approvalId)}`,
                  )
                }
              >
                处理审批
              </Button>
            ) : null,
          ]}
        >
          <List.Item.Meta
            title={
              <Space>
                <StatusTag value={String(risk.severity)} />
                {String(risk.reason)}
              </Space>
            }
            description={`影响：${arrayText(risk.impactScope)}；建议：${String(risk.recommendation)}`}
          />
        </List.Item>
      )}
    />
  );
}

function PageState({ title, error }: { title: string; error?: unknown }) {
  return (
    <div className="page-stack">
      <Card bordered={false}>
        <Typography.Title level={3}>{title}</Typography.Title>
        {error ? (
          <ApiErrorCard error={error} />
        ) : (
          <Typography.Paragraph type="secondary">
            数据来自项目持久化状态，请稍候。
          </Typography.Paragraph>
        )}
      </Card>
    </div>
  );
}

function formatConstraints(value: Record<string, unknown>): string {
  return typeof value.known === "string" ? value.known : "暂无";
}

function arrayText(value: unknown): string {
  return Array.isArray(value)
    ? value.map(String).join("、")
    : String(value ?? "未提供");
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
  };
  return labels[value] ?? value;
}
