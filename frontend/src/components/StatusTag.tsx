import { Tag } from "antd";

const colors: Record<string, string> = {
  ready: "green",
  blocked: "red",
  degraded: "orange",
  P0: "red",
  P1: "orange",
  P2: "blue",
  P3: "default",
  已完成: "green",
  已结项: "green",
  已终止: "default",
  进行中: "blue",
  等待人工: "gold",
  已暂停: "orange",
  阻塞: "red",
  未开始: "default",
  待处理: "default",
  返工: "orange",
};
const icons: Record<string, string> = {
  ready: "✓",
  blocked: "!",
  degraded: "~",
  P0: "!",
  P1: "▲",
  P2: "●",
  P3: "•",
  已完成: "✓",
  进行中: "●",
  等待人工: "?",
  已暂停: "Ⅱ",
  阻塞: "!",
};

/** 状态同时使用文字、图标和颜色，避免只靠颜色传达业务事实。 */
export function StatusTag({ value }: { value: string }) {
  return (
    <Tag color={colors[value] ?? "blue"}>
      {icons[value] ?? "•"} {value}
    </Tag>
  );
}
