import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Radio,
  Row,
  Space,
  Steps,
  Typography,
} from "antd";
import dayjs, { Dayjs } from "dayjs";
import { createProject, startProject, ProjectInput } from "../../api/client";
import { ApiErrorCard } from "../../components/ApiErrorCard";

type FormValues = Omit<ProjectInput, "deadline" | "idempotencyKey"> & {
  deadline?: Dayjs;
};

/** 只收集 Boss 的业务方向，技术方案和成员级拆解留给数字员工与责任组长。 */
export function ProjectInitiationPage({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [form] = Form.useForm<FormValues>();
  const [values, setValues] = useState<FormValues | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    try {
      const next = await form.validateFields();
      setValues(next);
      setError(null);
    } catch (_error) {
      setError(
        new Error(
          "请补齐项目名称、业务目标、目标用户、优先级、截止时间和已知约束",
        ),
      );
    }
  };

  const confirmStart = async () => {
    if (!values) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createProject({
        name: values.name,
        businessGoal: values.businessGoal,
        targetUsers: values.targetUsers,
        priority: values.priority,
        deadline: values.deadline?.toISOString() ?? null,
        constraints: values.constraints,
      });
      const started = await startProject(
        created.project.id,
        created.project.version,
      );
      onNavigate(`/projects/${started.aggregateId}/dashboard`);
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  };

  if (values) {
    return (
      <div className="page-stack narrow-page">
        <Steps
          current={1}
          items={[{ title: "填写方向" }, { title: "确认启动" }]}
        />
        <Card title="启动前请确认" bordered={false}>
          <Alert
            type="info"
            showIcon
            message="这一步只会在你明确确认后创建启动事件和首个任务"
          />
          <DescriptionsSummary values={values} />
          {error ? <ApiErrorCard error={error} /> : null}
          <Space>
            <Button onClick={() => setValues(null)} disabled={submitting}>
              返回修改
            </Button>
            <Button
              type="primary"
              loading={submitting}
              onClick={() => void confirmStart()}
            >
              确认启动数字公司
            </Button>
          </Space>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-stack narrow-page">
      <Steps
        current={0}
        items={[{ title: "填写方向" }, { title: "确认启动" }]}
      />
      <Card title="新建项目" bordered={false}>
        <Typography.Paragraph type="secondary">
          只填写你希望解决的业务问题。这里不需要技术方案、成员级任务拆解或强制成功指标。
        </Typography.Paragraph>
        {error ? <ApiErrorCard error={error} /> : null}
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item
            name="name"
            label="项目名称"
            rules={[{ required: true, message: "请输入项目名称" }]}
          >
            <Input
              placeholder="例如：帮助团队管理项目的小应用"
              maxLength={120}
            />
          </Form.Item>
          <Form.Item
            name="businessGoal"
            label="业务目标"
            rules={[{ required: true, message: "请说明希望解决的问题" }]}
          >
            <Input.TextArea
              rows={3}
              placeholder="希望让谁更容易完成什么事情？"
              maxLength={2_000}
            />
          </Form.Item>
          <Form.Item
            name="targetUsers"
            label="目标用户"
            rules={[{ required: true, message: "请填写目标用户" }]}
          >
            <Input placeholder="例如：10～50 人的研发团队" maxLength={500} />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="priority"
                label="优先级"
                initialValue="P1"
                rules={[{ required: true }]}
              >
                <Radio.Group
                  options={["P0", "P1", "P2", "P3"].map((value) => ({
                    label: value,
                    value,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="deadline"
                label="截止时间"
                rules={[{ required: true, message: "请选择截止时间" }]}
              >
                <DatePicker
                  showTime
                  className="full-width"
                  disabledDate={(date) => date.isBefore(dayjs(), "day")}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="constraints"
            label="已知约束"
            rules={[
              {
                required: true,
                message: "请填写已知约束，没有的话请填写“暂无”",
              },
            ]}
          >
            <Input.TextArea
              rows={3}
              placeholder="例如：只能在本机运行；暂无"
              maxLength={2_000}
            />
          </Form.Item>
          <Button type="primary" onClick={() => void submit()}>
            查看启动摘要
          </Button>
        </Form>
      </Card>
    </div>
  );
}

function DescriptionsSummary({ values }: { values: FormValues }) {
  return (
    <div className="summary-grid">
      <div>
        <span>项目名称</span>
        <strong>{values.name}</strong>
      </div>
      <div>
        <span>业务目标</span>
        <strong>{values.businessGoal}</strong>
      </div>
      <div>
        <span>目标用户</span>
        <strong>{values.targetUsers}</strong>
      </div>
      <div>
        <span>优先级</span>
        <strong>{values.priority}</strong>
      </div>
      <div>
        <span>截止时间</span>
        <strong>{values.deadline?.format("YYYY-MM-DD HH:mm")}</strong>
      </div>
      <div>
        <span>已知约束</span>
        <strong>{values.constraints}</strong>
      </div>
      <div>
        <span>预计参与部门</span>
        <strong>产品、研发、NPI、测试、项目主管</strong>
      </div>
      <div>
        <span>首个执行阶段</span>
        <strong>调研与 PRD</strong>
      </div>
    </div>
  );
}
