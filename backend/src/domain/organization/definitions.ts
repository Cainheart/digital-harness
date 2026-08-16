import { assertSafeData, validateSafeValue } from "../common.js";
import { InvalidRoleDefinitionError } from "../errors.js";

/** V1 的五类责任领域；研发区在办公室投影中由 development 和 npi 共同组成。 */
export type OrganizationDomainId = "product" | "development" | "npi" | "testing" | "project_management";
/** 岗位允许执行的工具名称；工具策略只保存能力名，不保存凭据或参数。 */
export type ToolName = "research.search" | "research.open" | "file.read" | "file.write" | "command.run" | "test.run" | "evidence.write" | "message.send" | "keychain.read";
/** 岗位对业务对象可执行的最小动作集合。 */
export type ObjectAction = "read" | "create" | "update" | "approve";
/** 工作区路径策略；路径均为 workspace URI 或相对路径模式。 */
export type PathPolicy = { readRoots: string[]; writeRoots: string[] };
/** 命令策略；只允许匹配白名单首命令，不接受任意 shell 管道和重定向。 */
export type CommandPolicy = { allowedCommands: string[]; forbiddenCommands: string[] };

/** 可配置、可版本化并可审计的岗位定义。 */
export type RoleDefinition = {
  roleId: string;
  domain: OrganizationDomainId;
  title: string;
  objective: string;
  responsibilities: string[];
  inputs: string[];
  outputs: string[];
  allowedTools: ToolName[];
  visibleObjects: string[];
  allowedObjects: string[];
  forbiddenActions: string[];
  roleVersion: number;
  objectActions: Record<string, ObjectAction[]>;
  pathPolicy: PathPolicy;
  commandPolicy: CommandPolicy;
  enabled: boolean;
};
/** 组织领域在查询和像素办公室投影中的稳定描述。 */
export type OrganizationDomain = { domainId: OrganizationDomainId; displayName: string; officeZone: string; groupName: string; responsibilities: string[]; version: number };
/** 数字员工实例；实例策略继承岗位版本，但保留专业标签和工位信息。 */
export type OrganizationMember = { instanceId: string; roleId: string; displayName: string; specialistTag: string; officeZone: string; deskGroup: string; status: "available" | "busy" | "blocked"; roleVersion: number };
/** 初始化组织所需的完整配置集合。 */
export type OrganizationSeed = { domains: OrganizationDomain[]; roles: RoleDefinition[]; members: OrganizationMember[]; bossDecisionBoundary: string[]; version: number };

/** 初始化数据中的岗位/实例 ID；接收旧设计中的 role_ 前缀别名。 */
export function canonicalRoleId(roleId: string): string { return roleId.startsWith("role_") ? roleId.slice("role_".length) : roleId; }

/** 对岗位定义执行启用前完整性检查，避免空字段进入任务分派。 */
export function assertCompleteRoleDefinition(role: RoleDefinition): RoleDefinition {
  const validDomains = new Set<OrganizationDomainId>(["product", "development", "npi", "testing", "project_management"]);
  const validTools = new Set<ToolName>(["research.search", "research.open", "file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send", "keychain.read"]);
  const validObjectActions = new Set<ObjectAction>(["read", "create", "update", "approve"]);
  const requiredText: Array<keyof RoleDefinition> = ["roleId", "domain", "title", "objective"];
  for (const field of requiredText) if (typeof role[field] !== "string" || !String(role[field]).trim()) throw new InvalidRoleDefinitionError(`岗位字段 ${String(field)} 不能为空`, { data: { roleId: role.roleId, missingField: field } });
  try { validateSafeValue(role.roleId, "roleId"); } catch { throw new InvalidRoleDefinitionError("岗位 roleId 不符合安全格式", { data: { roleId: role.roleId, missingField: "roleId" } }); }
  if (!validDomains.has(role.domain)) throw new InvalidRoleDefinitionError("岗位 domain 不在五类责任领域内", { data: { roleId: role.roleId, invalidField: "domain" } });
  const requiredArrays: Array<keyof RoleDefinition> = ["responsibilities", "inputs", "outputs", "allowedTools", "visibleObjects", "allowedObjects", "forbiddenActions"];
  for (const field of requiredArrays) { const value = role[field]; if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) throw new InvalidRoleDefinitionError(`岗位字段 ${String(field)} 不能为空`, { data: { roleId: role.roleId, missingField: field } }); }
  if (role.allowedTools.some((tool) => !validTools.has(tool))) throw new InvalidRoleDefinitionError("岗位包含未定义工具", { data: { roleId: role.roleId, invalidField: "allowedTools" } });
  if (!role.objectActions || typeof role.objectActions !== "object" || Array.isArray(role.objectActions) || Object.keys(role.objectActions).length === 0 || Object.entries(role.objectActions).some(([objectType, actions]) => !objectType.trim() || !Array.isArray(actions) || actions.length === 0 || actions.some((action) => !validObjectActions.has(action)))) throw new InvalidRoleDefinitionError("岗位对象策略不完整或包含未定义动作", { data: { roleId: role.roleId, invalidField: "objectActions" } });
  if (!role.pathPolicy || !Array.isArray(role.pathPolicy.readRoots) || !Array.isArray(role.pathPolicy.writeRoots) || role.pathPolicy.readRoots.length === 0 || role.pathPolicy.readRoots.some((path) => typeof path !== "string" || !path.trim()) || role.pathPolicy.writeRoots.some((path) => typeof path !== "string" || !path.trim())) throw new InvalidRoleDefinitionError("岗位路径策略不完整", { data: { roleId: role.roleId, invalidField: "pathPolicy" } });
  if (!role.commandPolicy || !Array.isArray(role.commandPolicy.allowedCommands) || !Array.isArray(role.commandPolicy.forbiddenCommands) || role.commandPolicy.allowedCommands.length === 0 || role.commandPolicy.allowedCommands.some((command) => typeof command !== "string" || !command.trim()) || role.commandPolicy.forbiddenCommands.some((command) => typeof command !== "string" || !command.trim())) throw new InvalidRoleDefinitionError("岗位命令策略不完整", { data: { roleId: role.roleId, invalidField: "commandPolicy" } });
  if (!Number.isInteger(role.roleVersion) || role.roleVersion < 1) throw new InvalidRoleDefinitionError("岗位 roleVersion 必须是正整数", { data: { roleId: role.roleId, missingField: "roleVersion" } });
  if (typeof role.enabled !== "boolean") throw new InvalidRoleDefinitionError("岗位 enabled 必须是布尔值", { data: { roleId: role.roleId, invalidField: "enabled" } });
  // 修改日期：2026-08-16
  // 修改原因：岗位配置可能来自数据库或管理端输入；敏感字段/控制字符必须稳定映射为 INVALID_ROLE_DEFINITION，不能以未处理异常穿透 API。
  try { assertSafeData(role); } catch { throw new InvalidRoleDefinitionError("岗位定义包含敏感字段或不安全内容", { data: { roleId: role.roleId, invalidField: "security" } }); }
  return role;
}

/** 构造一份共享默认策略，保证初始化岗位的安全边界显式且可读。 */
function makeRole(input: Omit<RoleDefinition, "objectActions" | "pathPolicy" | "commandPolicy" | "enabled" | "roleVersion"> & Partial<Pick<RoleDefinition, "objectActions" | "pathPolicy" | "commandPolicy" | "enabled" | "roleVersion">>): RoleDefinition {
  const defaultActions = Object.fromEntries(input.allowedObjects.map((objectType) => [objectType, objectType === "message" ? ["create"] : ["read"]])) as Record<string, ObjectAction[]>;
  return assertCompleteRoleDefinition({
    ...input,
    roleVersion: input.roleVersion ?? 1,
    objectActions: input.objectActions ?? defaultActions,
    pathPolicy: input.pathPolicy ?? { readRoots: ["workspace://project/**"], writeRoots: [] },
    commandPolicy: input.commandPolicy ?? { allowedCommands: ["node"], forbiddenCommands: ["rm", "sudo", "curl", "wget"] },
    enabled: input.enabled ?? true,
  });
}

const PRODUCT_OBJECTS = ["project", "task", "artifact", "artifact_version", "approval", "review", "requirement", "message"];
const DEVELOPMENT_OBJECTS = ["project", "task", "artifact", "artifact_version", "review", "test_case", "defect", "execution_attempt", "tool_call", "message"];
const NPI_OBJECTS = ["project", "task", "artifact", "artifact_version", "test_run", "defect", "execution_attempt", "tool_call", "message"];
const TEST_OBJECTS = ["project", "task", "artifact", "artifact_version", "test_case", "test_run", "defect", "message"];
const SUPERVISOR_OBJECTS = ["project", "task", "artifact", "artifact_version", "approval", "review", "test_run", "defect", "notification", "message"];
const READ_PROJECT_PATH = { readRoots: ["workspace://project/**"], writeRoots: [] } satisfies PathPolicy;
const DEVELOPMENT_PATH = { readRoots: ["workspace://project/**"], writeRoots: ["workspace://project/**"] } satisfies PathPolicy;
const DEVELOPMENT_COMMANDS = { allowedCommands: ["node", "npm", "pnpm", "npx", "git", "tsc", "vitest"], forbiddenCommands: ["rm", "sudo", "curl", "wget", "ssh"] } satisfies CommandPolicy;
const TEST_COMMANDS = { allowedCommands: ["node", "npm", "pnpm", "npx", "vitest"], forbiddenCommands: ["rm", "sudo", "curl", "wget", "ssh"] } satisfies CommandPolicy;
const TEST_MEMBER_ACTIONS = { project: ["read"], task: ["read", "update"], artifact: ["read"], artifact_version: ["read"], test_case: ["read"], test_run: ["read", "create", "update"], defect: ["read", "create"], message: ["create"] } satisfies Record<string, ObjectAction[]>;

/** 版本化初始化岗位；修改岗位能力必须递增 roleVersion 并重新生成执行授权。 */
export const INITIAL_ROLES: RoleDefinition[] = [
  makeRole({ roleId: "product_market_pm", domain: "product", title: "用户/市场 PM", objective: "发现用户问题、市场机会和竞品事实", responsibilities: ["用户研究", "市场调研", "竞品分析"], inputs: ["项目目标", "公开资料"], outputs: ["调研报告", "来源目录"], allowedTools: ["research.search", "research.open", "file.read", "evidence.write", "message.send"], visibleObjects: PRODUCT_OBJECTS, allowedObjects: PRODUCT_OBJECTS, forbiddenActions: ["submit_technical_approval", "modify_workflow", "change_role_policy"] }),
  makeRole({ roleId: "product_solution_pm", domain: "product", title: "产品方案 PM", objective: "定义产品范围、流程、验收和成功指标", responsibilities: ["PRD 起草", "验收标准", "PM 交叉评审"], inputs: ["调研报告", "Boss 方向"], outputs: ["PRD", "验收标准", "评审意见"], allowedTools: ["research.search", "research.open", "file.read", "evidence.write", "message.send"], visibleObjects: PRODUCT_OBJECTS, allowedObjects: PRODUCT_OBJECTS, forbiddenActions: ["submit_technical_approval", "approve_own_review", "modify_workflow", "change_role_policy"] }),
  makeRole({ roleId: "developer_representative", domain: "development", title: "开发代表", objective: "完成可行性沟通、任务拆解、依赖协调和最终代码 Review", responsibilities: ["可行性讨论", "任务分派", "最终 Review"], inputs: ["PRD", "可行性意见", "成员交付物"], outputs: ["任务拆解", "Review 报告", "技术澄清"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: DEVELOPMENT_OBJECTS, allowedObjects: DEVELOPMENT_OBJECTS, forbiddenActions: ["approve_own_review", "modify_workflow", "change_role_policy"], objectActions: { project: ["read"], task: ["read", "create", "update"], artifact: ["read", "create", "update"], artifact_version: ["read", "create"], review: ["read", "create", "approve"], test_case: ["read"], defect: ["read"], execution_attempt: ["read", "create"], tool_call: ["read"], message: ["create"] }, pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "frontend_developer", domain: "development", title: "前端开发", objective: "实现界面与交互相关任务并完成自测", responsibilities: ["界面实现", "交互实现", "前端自测"], inputs: ["开发任务", "设计和验收标准"], outputs: ["代码变更", "自测结果"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: DEVELOPMENT_OBJECTS, allowedObjects: DEVELOPMENT_OBJECTS, forbiddenActions: ["approve_own_review", "approve_review", "modify_workflow", "change_role_policy"], objectActions: { project: ["read"], task: ["read", "update"], artifact: ["read", "create", "update"], artifact_version: ["read", "create"], review: ["read"], test_case: ["read"], defect: ["read"], execution_attempt: ["read", "create"], tool_call: ["read"], message: ["create"] }, pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "backend_developer", domain: "development", title: "后端开发", objective: "实现业务逻辑与服务相关任务并完成自测", responsibilities: ["业务逻辑", "服务接口", "后端自测"], inputs: ["开发任务", "接口契约"], outputs: ["代码变更", "自测结果"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: DEVELOPMENT_OBJECTS, allowedObjects: DEVELOPMENT_OBJECTS, forbiddenActions: ["approve_own_review", "approve_review", "modify_workflow", "change_role_policy"], objectActions: { project: ["read"], task: ["read", "update"], artifact: ["read", "create", "update"], artifact_version: ["read", "create"], review: ["read"], test_case: ["read"], defect: ["read"], execution_attempt: ["read", "create"], tool_call: ["read"], message: ["create"] }, pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "integration_developer", domain: "development", title: "集成开发", objective: "处理模块协作和外部能力接入相关任务", responsibilities: ["模块集成", "外部能力接入", "集成自测"], inputs: ["模块契约", "开发任务"], outputs: ["集成变更", "集成证据"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: DEVELOPMENT_OBJECTS, allowedObjects: DEVELOPMENT_OBJECTS, forbiddenActions: ["approve_own_review", "approve_review", "modify_workflow", "change_role_policy"], objectActions: { project: ["read"], task: ["read", "update"], artifact: ["read", "create", "update"], artifact_version: ["read", "create"], review: ["read"], test_case: ["read"], defect: ["read"], execution_attempt: ["read", "create"], tool_call: ["read"], message: ["create"] }, pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "code_quality_developer", domain: "development", title: "代码质量开发", objective: "检查可维护性、自测覆盖和质量风险", responsibilities: ["质量检查", "可维护性建议", "自测建议"], inputs: ["代码变更", "测试证据"], outputs: ["质量报告", "改进建议"], allowedTools: ["file.read", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: DEVELOPMENT_OBJECTS, allowedObjects: DEVELOPMENT_OBJECTS, forbiddenActions: ["approve_own_review", "approve_review", "modify_workflow", "change_role_policy"], objectActions: { project: ["read"], task: ["read"], artifact: ["read", "create"], artifact_version: ["read"], review: ["read"], test_case: ["read"], defect: ["read"], execution_attempt: ["read", "create"], tool_call: ["read"], message: ["create"] }, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "npi_lead", domain: "npi", title: "NPI 组长", objective: "承接测试缺陷、分派修复并协调回归", responsibilities: ["缺陷分派", "修复协调", "回归协调"], inputs: ["缺陷单", "测试证据"], outputs: ["NPI 任务", "回归请求"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: NPI_OBJECTS, allowedObjects: NPI_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], objectActions: { project: ["read"], task: ["read", "create", "update"], artifact: ["read", "create", "update"], artifact_version: ["read", "create"], test_run: ["read"], defect: ["read", "update"], execution_attempt: ["read", "create"], tool_call: ["read"], message: ["create"] }, pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "defect_analyst", domain: "npi", title: "缺陷分析", objective: "复现问题、定位原因并判断影响范围", responsibilities: ["问题复现", "原因定位", "影响分析"], inputs: ["缺陷单", "测试运行"], outputs: ["缺陷分析", "修复建议"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: NPI_OBJECTS, allowedObjects: NPI_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "frontend_fixer", domain: "npi", title: "前端修复", objective: "按缺陷归属完成前端修复并提交证据", responsibilities: ["前端缺陷修复", "修复自测", "修复交接"], inputs: ["前端缺陷分析", "修复任务"], outputs: ["修复变更", "修复说明"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: NPI_OBJECTS, allowedObjects: NPI_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "backend_fixer", domain: "npi", title: "后端修复", objective: "按缺陷归属完成后端修复并提交证据", responsibilities: ["后端缺陷修复", "修复自测", "修复交接"], inputs: ["后端缺陷分析", "修复任务"], outputs: ["修复变更", "修复说明"], allowedTools: ["file.read", "file.write", "command.run", "test.run", "evidence.write", "message.send"], visibleObjects: NPI_OBJECTS, allowedObjects: NPI_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], pathPolicy: DEVELOPMENT_PATH, commandPolicy: DEVELOPMENT_COMMANDS }),
  makeRole({ roleId: "regression_coordinator", domain: "npi", title: "回归协同", objective: "整理修复证据并向测试组发起回归请求", responsibilities: ["修复证据整理", "回归请求", "跨组协调"], inputs: ["修复结果", "缺陷状态"], outputs: ["回归请求", "修复交接包"], allowedTools: ["file.read", "evidence.write", "message.send"], visibleObjects: NPI_OBJECTS, allowedObjects: NPI_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"] }),
  makeRole({ roleId: "test_lead", domain: "testing", title: "测试组长", objective: "制定测试策略、分派测试并汇总放行建议", responsibilities: ["测试策略", "用例分派", "报告汇总"], inputs: ["PRD", "开发交付物", "风险信息"], outputs: ["测试策略", "测试报告", "放行建议"], allowedTools: ["file.read", "test.run", "evidence.write", "message.send"], visibleObjects: TEST_OBJECTS, allowedObjects: TEST_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], objectActions: { project: ["read"], task: ["read", "create", "update"], artifact: ["read"], artifact_version: ["read"], test_case: ["read", "create", "update"], test_run: ["read", "create", "update"], defect: ["read", "create", "update"], message: ["create"] }, commandPolicy: TEST_COMMANDS }),
  makeRole({ roleId: "functional_tester", domain: "testing", title: "功能测试", objective: "验证主流程和业务验收标准", responsibilities: ["主流程验证", "验收标准验证", "测试记录"], inputs: ["测试用例", "测试环境"], outputs: ["测试结果", "缺陷单"], allowedTools: ["file.read", "test.run", "evidence.write", "message.send"], visibleObjects: TEST_OBJECTS, allowedObjects: TEST_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], objectActions: TEST_MEMBER_ACTIONS, commandPolicy: TEST_COMMANDS }),
  makeRole({ roleId: "edge_tester", domain: "testing", title: "边界/异常测试", objective: "验证异常、边界和错误处理", responsibilities: ["边界测试", "异常测试", "错误证据"], inputs: ["测试用例", "错误场景"], outputs: ["异常测试结果", "缺陷单"], allowedTools: ["file.read", "test.run", "evidence.write", "message.send"], visibleObjects: TEST_OBJECTS, allowedObjects: TEST_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], objectActions: TEST_MEMBER_ACTIONS, commandPolicy: TEST_COMMANDS }),
  makeRole({ roleId: "integration_tester", domain: "testing", title: "接口/集成测试", objective: "验证模块契约和跨模块协作", responsibilities: ["接口验证", "集成验证", "契约记录"], inputs: ["接口契约", "集成环境"], outputs: ["接口测试结果", "缺陷单"], allowedTools: ["file.read", "test.run", "evidence.write", "message.send"], visibleObjects: TEST_OBJECTS, allowedObjects: TEST_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], objectActions: TEST_MEMBER_ACTIONS, commandPolicy: TEST_COMMANDS }),
  makeRole({ roleId: "regression_tester", domain: "testing", title: "回归测试", objective: "验证修复结果及其影响范围", responsibilities: ["修复回归", "影响范围验证", "回归结论"], inputs: ["回归请求", "修复证据"], outputs: ["回归结果", "缺陷状态建议"], allowedTools: ["file.read", "test.run", "evidence.write", "message.send"], visibleObjects: TEST_OBJECTS, allowedObjects: TEST_OBJECTS, forbiddenActions: ["approve_test_release", "modify_workflow", "change_role_policy"], objectActions: TEST_MEMBER_ACTIONS, commandPolicy: TEST_COMMANDS }),
  makeRole({ roleId: "process_supervisor", domain: "project_management", title: "流程主管", objective: "检查状态、审批与交付物完整性", responsibilities: ["流程检查", "状态监督", "交付物检查"], inputs: ["项目事件", "任务和消息"], outputs: ["状态报告", "流程风险"], allowedTools: ["file.read", "evidence.write", "message.send"], visibleObjects: SUPERVISOR_OBJECTS, allowedObjects: SUPERVISOR_OBJECTS, forbiddenActions: ["approve_project", "modify_workflow", "change_role_policy"] }),
  makeRole({ roleId: "quality_risk_supervisor", domain: "project_management", title: "质量/风险主管", objective: "识别进度与质量风险并判断是否升级 Boss", responsibilities: ["质量检查", "风险识别", "重大风险升级"], inputs: ["测试报告", "缺陷和事件"], outputs: ["风险报告", "升级建议"], allowedTools: ["file.read", "evidence.write", "message.send"], visibleObjects: SUPERVISOR_OBJECTS, allowedObjects: SUPERVISOR_OBJECTS, forbiddenActions: ["approve_project", "modify_workflow", "change_role_policy"] }),
];

/** 初始化五类责任领域及其办公室分区。 */
export const INITIAL_DOMAINS: OrganizationDomain[] = [
  { domainId: "product", displayName: "产品区", officeZone: "产品区", groupName: "product", responsibilities: ["用户与市场调研", "PRD 起草", "产品交叉评审"], version: 1 },
  { domainId: "development", displayName: "研发区", officeZone: "研发区", groupName: "development", responsibilities: ["可行性沟通", "任务拆解", "代码实现与 Review"], version: 1 },
  { domainId: "npi", displayName: "研发区", officeZone: "研发区", groupName: "npi", responsibilities: ["缺陷分析", "修复", "回归协同"], version: 1 },
  { domainId: "testing", displayName: "测试区", officeZone: "测试区", groupName: "testing", responsibilities: ["测试策略", "真实测试", "回归验证"], version: 1 },
  { domainId: "project_management", displayName: "项目主管区", officeZone: "项目主管区", groupName: "project_management", responsibilities: ["流程监督", "质量和风险监督"], version: 1 },
];

/** 初始化员工实例；emp_07 保持示例中的开发代表交接实例。 */
export const INITIAL_MEMBERS: OrganizationMember[] = [
  ["emp_01", "product_market_pm", "用户/市场 PM", "research", "产品区", "product"], ["emp_02", "product_solution_pm", "产品方案 PM", "product", "产品区", "product"], ["emp_03", "frontend_developer", "前端开发", "frontend", "研发区", "development"], ["emp_04", "backend_developer", "后端开发", "backend", "研发区", "development"], ["emp_05", "integration_developer", "集成开发", "integration", "研发区", "development"], ["emp_06", "code_quality_developer", "代码质量开发", "quality", "研发区", "development"], ["emp_07", "developer_representative", "开发代表", "lead", "研发区", "development"], ["emp_08", "npi_lead", "NPI 组长", "lead", "研发区", "npi"], ["emp_09", "defect_analyst", "缺陷分析", "analysis", "研发区", "npi"], ["emp_10", "frontend_fixer", "前端修复", "frontend", "研发区", "npi"], ["emp_11", "backend_fixer", "后端修复", "backend", "研发区", "npi"], ["emp_12", "regression_coordinator", "回归协同", "regression", "研发区", "npi"], ["emp_13", "test_lead", "测试组长", "lead", "测试区", "testing"], ["emp_14", "functional_tester", "功能测试", "functional", "测试区", "testing"], ["emp_15", "edge_tester", "边界/异常测试", "edge", "测试区", "testing"], ["emp_16", "integration_tester", "接口/集成测试", "integration", "测试区", "testing"], ["emp_17", "regression_tester", "回归测试", "regression", "测试区", "testing"], ["emp_18", "process_supervisor", "流程主管", "process", "项目主管区", "project_management"], ["emp_19", "quality_risk_supervisor", "质量/风险主管", "risk", "项目主管区", "project_management"],
].map(([instanceId, roleId, displayName, specialistTag, officeZone, deskGroup]) => ({ instanceId, roleId, displayName, specialistTag, officeZone, deskGroup, status: "available", roleVersion: INITIAL_ROLES.find((role) => role.roleId === roleId)?.roleVersion ?? 1 }));

/** Boss 只处理方向和高风险决策，不能被转换为成员级技术任务。 */
export const BOSS_DECISION_BOUNDARY = ["prd_approval", "requirement_dispute", "major_risk", "test_release"];
/** 汇总 Task 3 的版本化组织初始化数据。 */
export const INITIAL_ORGANIZATION: OrganizationSeed = { domains: INITIAL_DOMAINS, roles: INITIAL_ROLES, members: INITIAL_MEMBERS, bossDecisionBoundary: BOSS_DECISION_BOUNDARY, version: 1 };

/** 验证实例角色关系，防止消息伪造发送方或接收方。 */
export function assertMemberRole(member: OrganizationMember, roleId: string): void { if (canonicalRoleId(member.roleId) !== canonicalRoleId(roleId)) throw new InvalidRoleDefinitionError("员工实例与岗位不匹配", { data: { instanceId: member.instanceId, roleId } }); }

/** 将旧式 role_ 前缀输入规范化为初始化数据使用的角色 ID。 */
export function safeRoleId(roleId: unknown): string { return canonicalRoleId(validateSafeValue(String(roleId ?? ""), "roleId")); }
