import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Descriptions, List, Space, Table, Tag, Typography } from "antd";
import {
  getExecution,
  getExecutionRuns,
  queryKeys,
  type ExecutionDetail,
} from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";

/** 展示真实执行尝试的时间线、模型、工具、命令、测试、错误和产物索引。 */
export function ExecutionConsolePage({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: queryKeys.executions(projectId),
    queryFn: () => getExecutionRuns(projectId),
  });
  const detail = useQuery({
    queryKey: ["execution-detail", projectId, selectedId],
    queryFn: () => getExecution(selectedId as string, projectId),
    enabled: selectedId !== null,
  });
  if (runs.isPending) return <Card loading title="正在读取真实执行记录" />;
  if (runs.error || !runs.data) return <ApiErrorCard error={runs.error} />;
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">UI 视图 / 调用控制台</Typography.Text>
          <Typography.Title level={1}>真实执行观测</Typography.Title>
          <Typography.Text type="secondary">
            所有状态、耗时、Token、工具和测试结果来自持久化执行证据。
          </Typography.Text>
        </div>
        <Space>
          <button
            className="link-button"
            type="button"
            onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}
          >
            返回看板
          </button>
          <button
            className="link-button"
            type="button"
            onClick={() => onNavigate(`/projects/${projectId}/scorecard`)}
          >
            查看评分卡
          </button>
        </Space>
      </div>
      <Card title={`执行尝试（${runs.data.total} 条）`} bordered={false}>
        <Table
          rowKey="executionId"
          dataSource={runs.data.items}
          pagination={false}
          rowClassName={(row) =>
            row.executionId === selectedId ? "execution-row-selected" : ""
          }
          onRow={(row) => ({
            onClick: () => setSelectedId(String(row.executionId)),
          })}
          columns={[
            {
              title: "执行",
              dataIndex: "executionId",
              render: (value: string) => (
                <Typography.Text code>{value}</Typography.Text>
              ),
            },
            { title: "角色", dataIndex: "role" },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string) => <Tag>{value}</Tag>,
            },
            { title: "开始时间", dataIndex: "startedAt" },
            {
              title: "模型",
              dataIndex: "modelName",
              render: (value: string | null) => value ?? "unknown",
            },
            {
              title: "工具/命令/测试",
              render: (_: unknown, row: Record<string, unknown>) =>
                `${row.toolCallCount}/${row.commandCount}/${row.testCount}`,
            },
            {
              title: "错误/重试",
              render: (_: unknown, row: Record<string, unknown>) =>
                `${row.errorCount}/${row.retryCount}`,
            },
          ]}
        />
      </Card>
      {detail.isPending ? <Card loading title="正在读取执行证据" /> : null}
      {detail.error ? <ApiErrorCard error={detail.error} /> : null}
      {detail.data ? <ExecutionDetailView detail={detail.data} /> : null}
    </div>
  );
}

/** 展示单次执行的分组证据和事件顺序，所有字段来自后端只读详情。 */
function ExecutionDetailView({ detail }: { detail: ExecutionDetail }) {
  const modelUsage = (detail.modelUsage ?? []) as Array<Record<string, unknown>>;
  const tools = (detail.toolCalls ?? []) as Array<Record<string, unknown>>;
  const tests = (detail.testRuns ?? []) as Array<Record<string, unknown>>;
  const errors = (detail.errors ?? []) as Array<Record<string, unknown>>;
  return (
    <Card title="执行证据详情" bordered={false}>
      <Descriptions column={{ xs: 1, sm: 2, lg: 3 }}>
        <Descriptions.Item label="项目">{detail.projectId}</Descriptions.Item>
        <Descriptions.Item label="任务">{detail.taskId}</Descriptions.Item>
        <Descriptions.Item label="Trace ID">{String(detail.traceId)}</Descriptions.Item>
        <Descriptions.Item label="执行状态"><Tag>{detail.status}</Tag></Descriptions.Item>
        <Descriptions.Item label="开始">{String(detail.startedAt)}</Descriptions.Item>
        <Descriptions.Item label="结束">{String(detail.finishedAt ?? "进行中")}</Descriptions.Item>
      </Descriptions>
      <div className="execution-detail-grid">
        <EvidenceList
          title="模型调用与 Token/成本"
          items={modelUsage}
          fields={[
            ["provider", "Provider"],
            ["model", "模型"],
            ["inputTokens", "输入 Token"],
            ["outputTokens", "输出 Token"],
            ["totalTokens", "总 Token"],
            ["estimatedCostMicros", "估算成本"],
          ]}
        />
        <EvidenceList
          title="工具调用"
          items={tools}
          fields={[
            ["toolName", "工具"],
            ["status", "状态"],
            ["durationMs", "耗时"],
            ["traceId", "Trace ID"],
          ]}
        />
        <EvidenceList
          title="测试验证"
          items={tests}
          fields={[
            ["testRunId", "测试"],
            ["status", "状态"],
            ["exitCode", "退出码"],
            ["traceId", "Trace ID"],
          ]}
        />
        <EvidenceList
          title="错误与重试"
          items={errors}
          fields={[
            ["errorType", "错误类型"],
            ["errorSummary", "错误摘要"],
            ["retryCount", "重试"],
            ["finalConclusion", "结论"],
          ]}
        />
      </div>
      <Card type="inner" title="完整事件时间线">
        <List
          dataSource={(detail.timeline ?? []) as Array<Record<string, unknown>>}
          locale={{ emptyText: "当前执行还没有可展示事件" }}
          renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    <Tag>{String(item.result)}</Tag>
                    {String(item.eventType)}
                    <Typography.Text code>
                      {String(item.eventId)}
                    </Typography.Text>
                  </Space>
                }
                description={
                  <Space wrap>
                    <span>{String(item.occurredAt)}</span>
                    <span>Trace: {String(item.traceId)}</span>
                    <span>
                      {String(item.failure ?? item.outputSummary ?? "无错误")}
                    </span>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </Card>
      <Card type="inner" title="产物与证据索引">
        <List
          dataSource={(detail.artifacts ?? []) as Array<Record<string, unknown>>}
          locale={{ emptyText: "当前执行没有关联产物" }}
          renderItem={(item) => (
            <List.Item>
              <Typography.Text>{String(item.name)}</Typography.Text>
              <Typography.Text type="secondary">
                {String(item.type)} · SHA-256 {String(item.sha256 ?? "unknown")}
              </Typography.Text>
            </List.Item>
          )}
        />
      </Card>
    </Card>
  );
}

/** 展示可复用的键值证据列表，缺失字段显式显示 unknown。 */
function EvidenceList({
  title,
  items,
  fields,
}: {
  title: string;
  items: Array<Record<string, unknown>>;
  fields: Array<[string, string]>;
}) {
  return (
    <Card type="inner" title={title}>
      <List
        size="small"
        dataSource={items}
        locale={{ emptyText: "数据不足或不适用" }}
        renderItem={(item) => (
          <List.Item>
            <Space wrap>
              {fields.map(([key, label]) => (
                <Typography.Text key={key}>
                  {label}：{String(item[key] ?? "unknown")}
                </Typography.Text>
              ))}
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );
}
