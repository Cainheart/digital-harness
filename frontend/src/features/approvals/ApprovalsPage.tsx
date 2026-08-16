import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  List,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  decideApproval,
  getApproval,
  getDashboard,
  queryKeys,
  ApprovalView,
} from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";
import { StatusTag } from "../../components/StatusTag";

/** 按“发生了什么→为什么→依据→可做什么→之后怎样”组织审批信息。 */
export function ApprovalsPage({
  projectId,
  approvalId,
  onNavigate,
}: {
  projectId: string;
  approvalId?: string;
  onNavigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(projectId),
    queryFn: () => getDashboard(projectId),
  });
  const selected = useQuery({
    queryKey: ["approval", approvalId ?? "none"],
    queryFn: () => getApproval(approvalId as string),
    enabled: Boolean(approvalId),
  });
  const [opinion, setOpinion] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  const decision = useMutation({
    mutationFn: (value: "approved" | "rejected") =>
      decideApproval(
        approvalId as string,
        selected.data?.version ?? 0,
        value,
        opinion,
      ),
    onSuccess: () => {
      setOpinion("");
      void queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["approval", approvalId ?? "none"],
      });
    },
    onError: setActionError,
  });

  if (dashboard.isPending || (approvalId && selected.isPending))
    return (
      <Card bordered={false}>
        <Typography.Title level={3}>正在读取审批信息</Typography.Title>
      </Card>
    );
  if (dashboard.error) return <ApiErrorCard error={dashboard.error} />;
  if (approvalId && selected.error)
    return <ApiErrorCard error={selected.error} />;
  const approvals = dashboard.data?.approvals ?? [];
  const current = selected.data;

  return (
    <div className="page-stack narrow-page">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">Boss 人工关卡</Typography.Text>
          <Typography.Title level={1}>审批与风险</Typography.Title>
        </div>
        <Button onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}>
          返回看板
        </Button>
      </div>
      {!current && (
        <Card title="待处理事项" bordered={false}>
          <List
            locale={{ emptyText: <Empty description="当前没有待处理审批" /> }}
            dataSource={approvals.filter((item) =>
              ["pending", "waiting_direction"].includes(String(item.status)),
            )}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    type="primary"
                    onClick={() =>
                      onNavigate(
                        `/projects/${projectId}/approvals/${String(item.id)}`,
                      )
                    }
                  >
                    查看并处理
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <StatusTag value="等待人工" />
                      {approvalType(
                        String(item.approval_type ?? item.approvalType),
                      )}
                    </Space>
                  }
                  description={`创建时间：${String(item.created_at ?? item.createdAt)}；对象：${String(item.subject_id ?? item.subjectId)}`}
                />
              </List.Item>
            )}
          />
        </Card>
      )}
      {current && (
        <ApprovalDetail
          approval={current}
          opinion={opinion}
          setOpinion={setOpinion}
          error={actionError}
          loading={decision.isPending}
          onDecision={(value) => {
            if (value === "rejected" && !opinion.trim()) {
              setActionError(new Error("驳回审批必须填写非空方向意见"));
              return;
            }
            setActionError(null);
            decision.mutate(value);
          }}
        />
      )}
    </div>
  );
}

function ApprovalDetail({
  approval,
  opinion,
  setOpinion,
  error,
  loading,
  onDecision,
}: {
  approval: ApprovalView;
  opinion: string;
  setOpinion: (value: string) => void;
  error: unknown;
  loading: boolean;
  onDecision: (value: "approved" | "rejected") => void;
}) {
  const completed = !["pending", "waiting_direction"].includes(approval.status);
  return (
    <Card bordered={false}>
      <Space wrap>
        <Tag color="blue">{approvalType(approval.approvalType)}</Tag>
        <StatusTag value={completed ? "已完成" : "等待人工"} />
      </Space>
      <section className="approval-sequence">
        <InfoBlock title="发生了什么">
          当前项目到达 {approvalType(approval.approvalType)} 关卡，需要 Boss
          对持久化业务对象做决定。
        </InfoBlock>
        <InfoBlock title="为什么需要 Boss">
          这是固定流程中的人工关卡，数字员工不能代替 Boss 通过、驳回或改变方向。
        </InfoBlock>
        <InfoBlock title="依据是什么">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="关联项目">
              {approval.projectId}
            </Descriptions.Item>
            <Descriptions.Item label="关联任务">
              {String(approval.taskId ?? "未关联")}
            </Descriptions.Item>
            <Descriptions.Item label="主体对象">
              {String(approval.subjectType)} / {String(approval.subjectId)}
            </Descriptions.Item>
            <Descriptions.Item label="证据版本">
              {String(approval.evidenceVersionId ?? "未提供")}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {String(approval.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label="当前版本">
              {approval.version}
            </Descriptions.Item>
          </Descriptions>
        </InfoBlock>
        <InfoBlock title="Boss 可以做什么">
          {completed
            ? "该审批已经完成，页面只保留决定记录。"
            : "可以通过，或填写方向意见后驳回。"}
          {!completed && (
            <Input.TextArea
              rows={4}
              value={opinion}
              onChange={(event) => setOpinion(event.target.value)}
              placeholder="通过可填写补充意见；驳回必须说明方向"
            />
          )}
        </InfoBlock>
        <InfoBlock title="之后会怎样">
          {approval.direction
            ? `已记录方向意见：${String(approval.direction)}`
            : "通过后进入固定流程下一阶段；驳回后创建责任组长响应任务并保留旧版本。"}
        </InfoBlock>
      </section>
      {error ? <ApiErrorCard error={error} /> : null}
      {!completed && (
        <Space>
          <Button
            type="primary"
            loading={loading}
            onClick={() => onDecision("approved")}
          >
            通过
          </Button>
          <Button
            danger
            loading={loading}
            onClick={() => onDecision("rejected")}
          >
            驳回并提交意见
          </Button>
        </Space>
      )}
    </Card>
  );
}

function InfoBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="info-block">
      <Typography.Title level={4}>{title}</Typography.Title>
      <div>{children}</div>
    </div>
  );
}

function approvalType(value: string): string {
  const labels: Record<string, string> = {
    prd_approval: "PRD 审批",
    requirement_dispute: "需求争议裁决",
    major_risk: "重大风险裁决",
    test_release: "测试放行",
  };
  return labels[value] ?? value;
}
