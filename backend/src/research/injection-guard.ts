/** 提示注入命中结果只包含类别和位置摘要，不保留恶意网页原文。 */
export type InjectionDetection = {
  detected: boolean;
  categories: string[];
  riskSummary: string | null;
};

/** 识别网页中的越权指令；检测结果不会进入角色、流程或工具策略。 */
export class InjectionGuard {
  /** 扫描不可信文本并返回可供安全事件使用的固定类别。 */
  detect(value: string): InjectionDetection {
    const categories = new Set<string>();
    const patterns: Array<[string, RegExp]> = [
      [
        "ignore_system_rules",
        /ignore\s+(?:all\s+)?(?:system|previous)\s+(?:rules|instructions)/i,
      ],
      ["ignore_system_rules", /忽略(?:所有)?(?:系统|之前)的?(?:规则|指令)/i],
      [
        "execute_command",
        /(?:run|execute)\s+(?:the\s+)?(?:following\s+)?(?:command|shell)/i,
      ],
      ["execute_command", /执行(?:以下)?(?:命令|shell)/i],
      [
        "credential_exfiltration",
        /(?:reveal|leak|print|send)\s+(?:the\s+)?(?:api[_ -]?key|password|token|credentials?)/i,
      ],
      [
        "credential_exfiltration",
        /(?:泄露|打印|发送|读取).*(?:凭据|密钥|密码|token|令牌)/i,
      ],
      ["role_change", /(?:you are now|change your role|act as|become)\s+/i],
      ["role_change", /(?:改变|切换)你的?(?:角色|权限)/i],
    ];
    for (const [category, pattern] of patterns)
      if (pattern.test(value)) categories.add(category);
    if (categories.size === 0)
      return { detected: false, categories: [], riskSummary: null };
    return {
      detected: true,
      categories: [...categories].sort(),
      riskSummary:
        "网页包含疑似提示注入内容；原文仅作为不可信资料保留，未执行任何指令。",
    };
  }
}

/** 默认注入检测器，避免每个调用方各自维护一套安全规则。 */
export const defaultInjectionGuard = new InjectionGuard();
