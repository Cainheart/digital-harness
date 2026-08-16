import { useQuery } from "@tanstack/react-query";
import { Button, Card, Descriptions, List, Space, Tag, Typography } from "antd";
import { getArtifact } from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";

/** 展示交付物元数据、完整性引用和不可变版本链，不直接渲染文件正文。 */
export function ArtifactDetailPage({
  projectId,
  artifactId,
  onNavigate,
}: {
  projectId: string;
  artifactId: string;
  onNavigate: (path: string) => void;
}) {
  const artifact = useQuery({
    queryKey: ["artifact", projectId, artifactId],
    queryFn: () => getArtifact(projectId, artifactId),
  });
  if (artifact.isPending)
    return (
      <Card bordered={false}>
        <Typography.Title level={3}>正在读取交付物</Typography.Title>
      </Card>
    );
  if (artifact.error || !artifact.data)
    return <ApiErrorCard error={artifact.error} />;
  const value = artifact.data.artifact;
  return (
    <div className="page-stack narrow-page">
      <div className="page-heading">
        <div>
          <Typography.Text type="secondary">交付物详情</Typography.Text>
          <Typography.Title level={1}>{String(value.name)}</Typography.Title>
          <Space>
            <Tag>{String(value.artifactType)}</Tag>
            <Tag>{String(value.status)}</Tag>
          </Space>
        </div>
        <Button onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}>
          返回看板
        </Button>
      </div>
      <Card bordered={false}>
        <Descriptions column={1}>
          <Descriptions.Item label="负责人">
            {String(value.ownerRole)}
          </Descriptions.Item>
          <Descriptions.Item label="创建人">
            {String(value.createdBy)}
          </Descriptions.Item>
          <Descriptions.Item label="所属任务">
            {String(value.taskId ?? "未关联")}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {String(value.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label="版本">
            {String(value.version)}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="版本历史" bordered={false}>
        <List
          dataSource={artifact.data.versions}
          locale={{ emptyText: "尚无版本" }}
          renderItem={(version) => (
            <List.Item>
              <List.Item.Meta
                title={`v${String(version.version)} · ${String(version.integrityStatus)}`}
                description={
                  <span>
                    {String(version.changeReason)} · {String(version.createdAt)}{" "}
                    · SHA-256{" "}
                    {String(
                      version.contentRef &&
                        (version.contentRef as Record<string, unknown>).sha256,
                    )}
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
