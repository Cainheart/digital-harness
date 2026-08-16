import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from "antd";
import {
  confirmArchiveDeletion,
  getArchive,
  previewArchiveDeletion,
  queryKeys,
  ArchiveDeletionPreview,
} from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";
import { StatusTag } from "../../components/StatusTag";

/** 提供历史项目搜索、筛选、只读复盘和删除二次确认。 */
export function ArchivePage({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({
    search: "",
    status: "",
    priority: "",
  });
  const filterKey = JSON.stringify(filters);
  const archive = useQuery({
    queryKey: queryKeys.archive(filterKey),
    queryFn: () =>
      getArchive({
        ...filters,
        status: filters.status || undefined,
        priority: filters.priority || undefined,
      }),
  });
  const [preview, setPreview] = useState<ArchiveDeletionPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const deletionPreview = useMutation({
    mutationFn: (value: { id: string; version: number }) =>
      previewArchiveDeletion(value.id, value.version),
    onSuccess: setPreview,
    onError: setError,
  });
  const deletion = useMutation({
    mutationFn: (value: { id: string; version: number; token: string }) =>
      confirmArchiveDeletion(value.id, value.version, value.token),
    onSuccess: () => {
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ["archive"] });
    },
    onError: setError,
  });
  if (archive.isPending)
    return (
      <Card bordered={false}>
        <Typography.Title level={3}>正在读取历史存档</Typography.Title>
      </Card>
    );
  if (archive.error || !archive.data)
    return <ApiErrorCard error={archive.error} />;
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">项目生命周期</Typography.Text>
          <Typography.Title level={1}>历史存档</Typography.Title>
        </div>
      </div>
      <Alert
        type="info"
        showIcon
        message="重新打开历史项目只代表查看，不会恢复为活动项目。活动项目必须先按终止流程处理，不能直接删除。"
      />
      {error ? <ApiErrorCard error={error} /> : null}
      <Card bordered={false}>
        <Space wrap>
          <Input.Search
            placeholder="按项目名称搜索"
            allowClear
            value={filters.search}
            onChange={(event) =>
              setFilters({ ...filters, search: event.target.value })
            }
            onSearch={(value) => setFilters({ ...filters, search: value })}
            style={{ width: 260 }}
          />
          <Select
            allowClear
            placeholder="状态"
            value={filters.status || undefined}
            onChange={(value) =>
              setFilters({ ...filters, status: value ?? "" })
            }
            options={[
              { value: "已结项", label: "已结项" },
              { value: "已终止", label: "已终止" },
            ]}
            style={{ width: 140 }}
          />
          <Select
            allowClear
            placeholder="优先级"
            value={filters.priority || undefined}
            onChange={(value) =>
              setFilters({ ...filters, priority: value ?? "" })
            }
            options={["P0", "P1", "P2", "P3"].map((value) => ({
              value,
              label: value,
            }))}
            style={{ width: 120 }}
          />
        </Space>
      </Card>
      <Card bordered={false}>
        <Table
          rowKey="id"
          dataSource={archive.data.items}
          pagination={false}
          columns={[
            {
              title: "项目",
              render: (_: unknown, row: Record<string, unknown>) => (
                <Button
                  type="link"
                  onClick={() => onNavigate(`/archive/${String(row.id)}`)}
                >
                  {String(row.name)}
                </Button>
              ),
            },
            {
              title: "最终状态",
              render: (_: unknown, row: Record<string, unknown>) => (
                <StatusTag value={String(row.finalStatus)} />
              ),
            },
            { title: "优先级", dataIndex: "priority" },
            { title: "创建时间", dataIndex: "createdAt" },
            {
              title: "结束时间",
              dataIndex: "endedAt",
              render: (value: unknown) => (value ? String(value) : "未记录"),
            },
            {
              title: "缺陷",
              render: (_: unknown, row: Record<string, unknown>) => {
                const defects = row.defects as Record<string, unknown>;
                return `${String(defects.total)} / 未关闭 ${String(defects.open)}`;
              },
            },
            {
              title: "模型成本",
              render: (_: unknown, row: Record<string, unknown>) => {
                const cost = row.modelCost as Record<string, unknown>;
                return `${String(cost.callCount)} 次 · ${String(cost.totalTokens)} Token`;
              },
            },
            {
              title: "操作",
              render: (_: unknown, row: Record<string, unknown>) => (
                <Space>
                  <Button
                    onClick={() => onNavigate(`/archive/${String(row.id)}`)}
                  >
                    只读查看
                  </Button>
                  <Button
                    danger
                    onClick={() => {
                      setError(null);
                      deletionPreview.mutate({
                        id: String(row.id),
                        version: Number(row.version),
                      });
                    }}
                  >
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        open={Boolean(preview)}
        title="删除历史项目：第二次确认"
        onCancel={() => setPreview(null)}
        footer={
          preview
            ? [
                <Button key="cancel" onClick={() => setPreview(null)}>
                  取消
                </Button>,
                <Button
                  key="delete"
                  danger
                  loading={deletion.isPending}
                  onClick={() =>
                    void deletion.mutate({
                      id: preview.projectId,
                      version: Number(
                        archive.data?.items.find(
                          (item) => item.id === preview.projectId,
                        )?.version ?? 1,
                      ),
                      token: preview.confirmationToken,
                    })
                  }
                >
                  我已理解，确认永久删除
                </Button>,
              ]
            : null
        }
      >
        {preview && (
          <>
            <Alert
              type="error"
              showIcon
              message={preview.irreversibleWarning}
            />
            <Typography.Paragraph>
              <strong>{preview.projectName}</strong> · {preview.status} ·
              结束时间：{preview.endedAt ?? "未记录"}
            </Typography.Paragraph>
            <Typography.Paragraph>删除范围：</Typography.Paragraph>
            <ul>
              {preview.deletionScope.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </div>
  );
}
