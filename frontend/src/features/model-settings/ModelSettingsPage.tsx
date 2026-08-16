import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  deleteModelCredential,
  getModelSettings,
  ModelSetting,
  queryKeys,
  updateModelSetting,
} from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";
import { StatusTag } from "../../components/StatusTag";

const domainLabels: Record<string, string> = {
  product: "产品",
  development: "开发",
  npi: "NPI 修复",
  testing: "测试",
  project_management: "项目主管",
};

/** 管理五领域脱敏模型配置；页面永远不回填或显示凭据明文。 */
export function ModelSettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: queryKeys.models,
    queryFn: getModelSettings,
  });
  const [selected, setSelected] = useState<ModelSetting | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [credential, setCredential] = useState("");
  const update = useMutation({
    mutationFn: (value: {
      domain: string;
      provider: string;
      modelName: string;
      credential: string;
      expectedConfigVersion: number;
    }) => updateModelSetting(value.domain, value),
    onSuccess: () => {
      setSelected(null);
      setCredential("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (value: { domain: string; version: number }) =>
      deleteModelCredential(value.domain, value.version),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.models }),
    onError: setError,
  });
  if (settings.isPending)
    return (
      <Card bordered={false}>
        <Typography.Title level={3}>正在读取模型配置</Typography.Title>
      </Card>
    );
  if (settings.error || !settings.data)
    return <ApiErrorCard error={settings.error} />;
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">调用控制台入口</Typography.Text>
          <Typography.Title level={1}>模型设置</Typography.Title>
        </div>
      </div>
      <Alert
        type="info"
        showIcon
        message="这里显示提供商、模型和连接状态，不显示 API Key。运行中的任务沿用启动时的配置，尚未启动的任务使用最新配置。"
      />
      {error ? <ApiErrorCard error={error} /> : null}
      <Row gutter={[16, 16]}>
        {settings.data.items.map((item) => (
          <Col xs={24} md={12} xl={8} key={item.domain}>
            <Card
              title={domainLabels[item.domain] ?? item.domain}
              extra={
                <Tag>
                  {item.configVersion === 0
                    ? "未配置"
                    : `版本 ${item.configVersion}`}
                </Tag>
              }
            >
              <Descriptions item={item} />
              <Space wrap>
                <Button
                  onClick={() => {
                    setSelected(item);
                    setError(null);
                  }}
                >
                  更新配置
                </Button>
                <Button
                  danger
                  disabled={item.credentialStatus === "missing"}
                  loading={remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      domain: item.domain,
                      version: item.configVersion,
                    })
                  }
                >
                  删除凭据
                </Button>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
      {selected && (
        <Card
          title={`更新${domainLabels[selected.domain] ?? selected.domain}配置`}
          bordered={false}
        >
          <Form
            layout="vertical"
            onFinish={(values: { provider: string; modelName: string }) =>
              update.mutate({
                domain: selected.domain,
                provider: values.provider,
                modelName: values.modelName,
                credential,
                expectedConfigVersion: selected.configVersion,
              })
            }
          >
            <Form.Item
              name="provider"
              label="提供商"
              initialValue={selected.provider}
              rules={[{ required: true }]}
            >
              <Select
                options={[
                  { value: "openai", label: "OpenAI" },
                  { value: "deepseek", label: "DeepSeek" },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="modelName"
              label="模型名称"
              initialValue={selected.modelName}
              rules={[{ required: true, message: "请输入模型名称" }]}
            >
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item label="API Key（只写入本机凭据存储，不会回显）" required>
              <Input.Password
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                autoComplete="new-password"
              />
            </Form.Item>
            <Space>
              <Button
                onClick={() => {
                  setSelected(null);
                  setCredential("");
                }}
              >
                取消
              </Button>
              <Button
                type="primary"
                htmlType="submit"
                loading={update.isPending}
                disabled={!credential.trim()}
              >
                保存并记录变更
              </Button>
            </Space>
          </Form>
        </Card>
      )}
      <Card title="配置审查提示" bordered={false}>
        <Typography.Paragraph>
          保存配置会记录变更前后版本、受影响领域和时间；连接失败时相关任务会显示阻塞原因，不会静默切换模型。
        </Typography.Paragraph>
        <Table
          size="small"
          pagination={false}
          rowKey="domain"
          dataSource={settings.data.items}
          columns={[
            {
              title: "领域",
              render: (_: unknown, row: ModelSetting) =>
                domainLabels[row.domain] ?? row.domain,
            },
            { title: "提供商", dataIndex: "provider" },
            { title: "模型", dataIndex: "modelName" },
            {
              title: "凭据",
              render: (_: unknown, row: ModelSetting) => (
                <StatusTag
                  value={
                    row.credentialStatus === "configured" ? "ready" : "blocked"
                  }
                />
              ),
            },
            {
              title: "连接",
              render: (_: unknown, row: ModelSetting) => (
                <StatusTag
                  value={row.connectionStatus === "ready" ? "ready" : "blocked"}
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

function Descriptions({ item }: { item: ModelSetting }) {
  return (
    <div className="model-summary">
      <div>
        <span>提供商</span>
        <strong>{item.provider}</strong>
      </div>
      <div>
        <span>模型</span>
        <strong>{item.modelName}</strong>
      </div>
      <div>
        <span>凭据</span>
        <strong>
          {item.credentialStatus === "configured"
            ? "已配置（不显示内容）"
            : "未配置"}
        </strong>
      </div>
      <div>
        <span>连接</span>
        <strong>{item.connectionStatus}</strong>
      </div>
      {item.lastErrorCode && (
        <div>
          <span>最近错误</span>
          <strong>{item.lastErrorCode}</strong>
        </div>
      )}
    </div>
  );
}
