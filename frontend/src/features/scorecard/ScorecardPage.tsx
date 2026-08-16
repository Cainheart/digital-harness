import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  getScorecard,
  queryKeys,
  recalculateScorecard,
  type ScorecardView,
} from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";

/** 展示后端规则引擎产生的七维评分卡和九条硬性门槛。 */
export function ScorecardPage({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const scorecard = useQuery({
    queryKey: queryKeys.scorecard(projectId),
    queryFn: () => getScorecard(projectId),
  });
  const recalculate = useMutation({
    mutationFn: () => recalculateScorecard(projectId),
    onSuccess: (value) => {
      queryClient.setQueryData(queryKeys.scorecard(projectId), value);
    },
  });
  if (scorecard.isPending) return <Card loading title="正在计算评分卡" />;
  if (scorecard.error || !scorecard.data) {
    return <ApiErrorCard error={scorecard.error} />;
  }
  const view = scorecard.data;
  const blocked = view.releaseStatus !== "PASS";
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">项目评分卡 · {view.ruleVersion}</Typography.Text>
          <Typography.Title level={1}>证据支持的发布评估</Typography.Title>
          <Typography.Text type="secondary">
            计算时间：{view.calculatedAt} · 数据版本：{view.sourceDataVersion}
          </Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}>返回看板</Button>
          <Button onClick={() => onNavigate(`/projects/${projectId}/office`)}>像素办公室</Button>
          <Button
            type="primary"
            loading={recalculate.isPending}
            onClick={() => recalculate.mutate()}
          >
            重新计算并保存版本
          </Button>
        </Space>
      </div>
      {recalculate.error ? <ApiErrorCard error={recalculate.error} /> : null}
      <Alert
        type={blocked ? "warning" : "success"}
        showIcon
        message={`发布状态：${releaseLabel(view.releaseStatus)}`}
        description={
          blocked
            ? "硬性门槛或结构化证据不足时，overall score 不能替代整改。"
            : "所有硬性门槛和评分维度均满足当前规则。"
        }
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card bordered={false}>
            <Statistic
              title="总分"
              value={view.overallScore ?? "数据不足"}
              suffix={view.overallScore === null ? "" : "/ 100"}
            />
            {view.overallScore !== null ? <Progress percent={view.overallScore} showInfo={false} /> : null}
            <Typography.Text type="secondary">评分卡版本：{view.scorecardVersion || "未保存"}</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={16}>
          <Card title="整改建议" bordered={false}>
            {view.recommendations.length === 0 ? (
              <Typography.Text>暂无建议</Typography.Text>
            ) : (
              <ul>
                {view.recommendations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </Card>
        </Col>
      </Row>
      <Card title="七个评分维度" bordered={false}>
        <Row gutter={[16, 16]}>
          {view.dimensions.map((dimension) => (
            <DimensionCard key={dimension.dimensionId} dimension={dimension} />
          ))}
        </Row>
      </Card>
      <Card title="硬性发布门槛" bordered={false}>
        <div className="scorecard-gates">
          {view.hardGates.map((gate) => (
            <div
              className={`scorecard-gate scorecard-gate-${gate.status.toLowerCase()}`}
              key={gate.gateId}
            >
              <Space>
                <Tag
                  color={
                    gate.status === "PASS"
                      ? "green"
                      : gate.status === "FAIL"
                        ? "red"
                        : "orange"
                  }
                >
                  {gate.status}
                </Tag>
                <strong>{gate.label}</strong>
              </Space>
              <Typography.Text type="secondary">
                {gate.reason ?? "已满足"} · 证据：{gate.evidenceIds.join(", ") || "数据不足"}
              </Typography.Text>
              {gate.remediation ? <Typography.Text>{gate.remediation}</Typography.Text> : null}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** 展示一个评分维度的状态、分数、证据和待补数据。 */
function DimensionCard({
  dimension,
}: {
  dimension: ScorecardView["dimensions"][number];
}) {
  const color =
    dimension.status === "PASS"
      ? "green"
      : dimension.status === "NEEDS_REMEDIATION"
        ? "orange"
        : "gold";
  return (
    <Col xs={24} md={12} xl={8}>
      <Card size="small" title={dimension.label} extra={<Tag color={color}>{dimension.status}</Tag>}>
        <Statistic value={dimension.score ?? "数据不足"} suffix={dimension.score === null ? "" : "/ 100"} />
        <Typography.Text type="secondary">
          证据：{dimension.evidenceIds.join(", ") || "暂无"}
        </Typography.Text>
        {dimension.issues.map((issue) => (
          <Typography.Paragraph key={issue} type="warning">
            {issue}
          </Typography.Paragraph>
        ))}
        {dimension.missingData.map((item) => (
          <Typography.Paragraph key={item} type="secondary">
            缺失：{item}
          </Typography.Paragraph>
        ))}
      </Card>
    </Col>
  );
}

/** 将评分卡发布状态转为用户可读的中文标签。 */
function releaseLabel(value: string): string {
  if (value === "PASS") return "通过";
  if (value === "BLOCKED") return "阻塞";
  if (value === "NEEDS_REMEDIATION") return "需要整改";
  return "数据不足";
}
