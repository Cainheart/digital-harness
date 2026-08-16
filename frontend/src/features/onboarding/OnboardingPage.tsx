import { Button, Card, Col, Row, Steps, Tag, Typography } from "antd";

const topics = [
  {
    title: "数字公司怎么分工",
    text: "产品、研发、测试和项目主管各有负责范围；研发区会区分开发组和 NPI 修复组。",
  },
  {
    title: "项目会经历什么",
    text: "项目会依次经历调研与 PRD、审批、可行性讨论、开发、Review、测试、缺陷修复、放行和结项。",
  },
  {
    title: "哪些工作会自动进行",
    text: "在获得授权后，数字员工可以整理公开资料、准备交付物、执行代码检查和测试，并保留证据。",
  },
  {
    title: "什么时候需要你决定",
    text: "PRD、重大风险、需求争议和测试放行需要 Boss 决策；暂停、恢复和终止也由你确认。",
  },
  {
    title: "可能产生哪些模型调用",
    text: "产品、开发、NPI、测试和项目主管五个领域可以分别使用配置好的模型；每次调用都会记录次数、耗时、Token 和成本摘要。",
  },
  {
    title: "可能发生哪些本地变更",
    text: "开发任务可能在受控项目工作区中创建或修改文件，并执行允许的构建和测试；不会绕过项目边界直接操作本机文件。",
  },
  {
    title: "运行准备不完整怎么办",
    text: "开始前会检查模型、公开资料、工作区、容器和数据保存能力。缺少条件时会说明影响和下一步，真实执行不会启动。",
  },
];

/** 用非技术化语言解释组织、流程、人工关卡和准备状态。 */
export function OnboardingPage({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <Tag color="blue">第一次进入</Tag>
        <Typography.Title level={1}>
          先了解这家公司，再开始一个项目
        </Typography.Title>
        <Typography.Paragraph>
          Digital Harness
          会把产品想法交给一组有明确职责的数字员工处理。你只需要说明方向、确认重要关卡，并在出现风险时做决定。
        </Typography.Paragraph>
        <Button
          type="primary"
          size="large"
          onClick={() => onNavigate("/readiness")}
        >
          查看运行准备
        </Button>
      </section>
      <Card title="你会看到什么" bordered={false}>
        <Row gutter={[16, 16]}>
          {topics.map((topic) => (
            <Col xs={24} md={12} xl={8} key={topic.title}>
              <Card className="topic-card" size="small">
                <Typography.Title level={4}>{topic.title}</Typography.Title>
                <Typography.Paragraph>{topic.text}</Typography.Paragraph>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
      <Card title="项目流程总览" bordered={false}>
        <Steps
          responsive
          items={[
            { title: "了解与准备" },
            { title: "立项与启动" },
            { title: "自动工作与人工关卡" },
            { title: "测试放行" },
            { title: "只读存档" },
          ]}
        />
      </Card>
    </div>
  );
}
