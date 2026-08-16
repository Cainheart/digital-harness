import { Alert, Descriptions } from "antd";
import { ApiError } from "../api/client";

/** 将接口错误按发生了什么、影响、数据、下一步和 traceId 展示给 Boss。 */
export function ApiErrorCard({ error }: { error: unknown }) {
  const apiError = error instanceof ApiError ? error : null;
  const message = apiError?.message ?? "暂时无法读取这项业务信息";
  return (
    <Alert
      type="error"
      showIcon
      message={message}
      description={
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="影响">
            {apiError?.impact ?? "当前页面数据未更新"}
          </Descriptions.Item>
          <Descriptions.Item label="是否暂停">
            {apiError?.paused ? "相关流程保持暂停" : "未改变项目运行状态"}
          </Descriptions.Item>
          <Descriptions.Item label="数据">
            {apiError?.dataPreserved === false
              ? "请联系支持人员确认"
              : "已有数据已保留"}
          </Descriptions.Item>
          <Descriptions.Item label="下一步">
            {apiError?.nextAction ?? "刷新页面后重试"}
          </Descriptions.Item>
          <Descriptions.Item label="定位引用">
            {apiError?.traceId ?? "暂未提供"}
          </Descriptions.Item>
        </Descriptions>
      }
    />
  );
}
