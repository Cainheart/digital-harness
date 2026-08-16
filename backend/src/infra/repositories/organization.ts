import BetterSqlite3 from "better-sqlite3";
import {
  assertCompleteRoleDefinition,
  canonicalRoleId,
  OrganizationDomain,
  OrganizationMember,
  OrganizationSeed,
  RoleDefinition,
} from "../../domain/organization/definitions.js";
import {
  InvalidRoleDefinitionError,
  NotFoundError,
} from "../../domain/errors.js";
import { jsonText, jsonValue } from "./common.js";

/** 组织、岗位和员工实例的 SQLite 仓储；所有岗位读取都经过完整性校验。 */
export class OrganizationRepository {
  /** 查询五类责任领域的展示和职责信息。 */
  listDomains(connection: BetterSqlite3.Database): OrganizationDomain[] {
    return (
      connection
        .prepare(
          "SELECT * FROM organization_domains WHERE enabled=1 ORDER BY domain_id",
        )
        .all() as DomainRow[]
    ).map(domainFromRow);
  }
  /** 查询全部启用岗位；不返回凭据、提示词或隐藏参数。 */
  listRoles(connection: BetterSqlite3.Database): RoleDefinition[] {
    return (
      connection
        .prepare(
          "SELECT * FROM role_definitions WHERE enabled=1 ORDER BY domain_id,role_id",
        )
        .all() as RoleRow[]
    ).map(roleFromRow);
  }
  /** 按岗位 ID 查询岗位，兼容 role_ 前缀的设计文档示例。 */
  getRole(connection: BetterSqlite3.Database, roleId: string): RoleDefinition {
    const row = connection
      .prepare("SELECT * FROM role_definitions WHERE role_id=?")
      .get(canonicalRoleId(roleId)) as RoleRow | undefined;
    if (!row) throw new NotFoundError("岗位不存在");
    const role = roleFromRow(row);
    if (!role.enabled) throw new NotFoundError("岗位当前未启用");
    return role;
  }
  /** 查询员工实例；岗位版本从实例快照中恢复，供执行授权建立稳定边界。 */
  // 修改日期：2026-08-16
  // 修改原因：禁用岗位或过期员工岗位快照不能继续作为消息端点或 Boss 方向接收人，必须在读取时阻断而不是等执行阶段失败。
  getMember(
    connection: BetterSqlite3.Database,
    instanceId: string,
  ): OrganizationMember {
    const row = connection
      .prepare(
        "SELECT organization_members.*, role_definitions.enabled AS role_enabled, role_definitions.role_version AS current_role_version FROM organization_members JOIN role_definitions ON role_definitions.role_id=organization_members.role_id WHERE organization_members.instance_id=?",
      )
      .get(instanceId) as MemberRow | undefined;
    if (!row) throw new NotFoundError("员工实例不存在");
    if (row.role_enabled !== 1 || row.current_role_version !== row.role_version)
      throw new InvalidRoleDefinitionError("员工实例关联的岗位当前不可执行", {
        data: { instanceId, roleId: row.role_id },
      });
    return memberFromRow(row);
  }
  /** 查询全部员工实例，用于组织图和办公室投影。 */
  listMembers(connection: BetterSqlite3.Database): OrganizationMember[] {
    return (
      connection
        .prepare(
          "SELECT organization_members.* FROM organization_members JOIN role_definitions ON role_definitions.role_id=organization_members.role_id WHERE role_definitions.enabled=1 AND role_definitions.role_version=organization_members.role_version ORDER BY instance_id",
        )
        .all() as MemberRow[]
    ).map(memberFromRow);
  }
  /** 以当前数据库内容构造组织查询结果。 */
  getOrganization(
    connection: BetterSqlite3.Database,
    seed: OrganizationSeed,
  ): OrganizationSeed {
    return {
      domains: this.listDomains(connection),
      roles: this.listRoles(connection),
      members: this.listMembers(connection),
      bossDecisionBoundary: [...seed.bossDecisionBoundary],
      version: seed.version,
    };
  }
  /** 启用岗位前校验所有职责、工具、对象和路径字段均非空。 */
  enableRole(
    connection: BetterSqlite3.Database,
    roleId: string,
  ): RoleDefinition {
    const role = this.getRoleIncludingDisabled(connection, roleId);
    assertCompleteRoleDefinition(role);
    connection
      .prepare(
        "UPDATE role_definitions SET enabled=1,updated_at=? WHERE role_id=?",
      )
      .run(new Date().toISOString(), role.roleId);
    return { ...role, enabled: true };
  }
  /** 禁用岗位；已有历史执行授权不被修改，新任务不能领取该岗位。 */
  disableRole(connection: BetterSqlite3.Database, roleId: string): void {
    this.getRoleIncludingDisabled(connection, roleId);
    connection
      .prepare(
        "UPDATE role_definitions SET enabled=0,updated_at=? WHERE role_id=?",
      )
      .run(new Date().toISOString(), canonicalRoleId(roleId));
  }
  /** 保存递增版本的岗位策略，并同步更新员工实例的当前版本。 */
  replaceRole(
    connection: BetterSqlite3.Database,
    role: RoleDefinition,
  ): RoleDefinition {
    assertCompleteRoleDefinition(role);
    const current = this.getRoleIncludingDisabled(connection, role.roleId);
    if (role.roleVersion <= current.roleVersion)
      throw new Error("roleVersion must increase");
    const now = new Date().toISOString();
    connection
      .prepare(
        "UPDATE role_definitions SET domain_id=?,title=?,objective=?,responsibilities_json=?,inputs_json=?,outputs_json=?,allowed_tools_json=?,visible_objects_json=?,allowed_objects_json=?,forbidden_actions_json=?,object_actions_json=?,path_policy_json=?,command_policy_json=?,role_version=?,enabled=?,updated_at=? WHERE role_id=?",
      )
      .run(
        role.domain,
        role.title,
        role.objective,
        jsonText(role.responsibilities),
        jsonText(role.inputs),
        jsonText(role.outputs),
        jsonText(role.allowedTools),
        jsonText(role.visibleObjects),
        jsonText(role.allowedObjects),
        jsonText(role.forbiddenActions),
        jsonText(role.objectActions),
        jsonText(role.pathPolicy),
        jsonText(role.commandPolicy),
        role.roleVersion,
        role.enabled ? 1 : 0,
        now,
        canonicalRoleId(role.roleId),
      );
    connection
      .prepare("UPDATE organization_members SET role_version=? WHERE role_id=?")
      .run(role.roleVersion, canonicalRoleId(role.roleId));
    return role;
  }
  /** 获取包含禁用岗位的内部记录，避免启用校验被查询过滤绕过。 */
  private getRoleIncludingDisabled(
    connection: BetterSqlite3.Database,
    roleId: string,
  ): RoleDefinition {
    const row = connection
      .prepare("SELECT * FROM role_definitions WHERE role_id=?")
      .get(canonicalRoleId(roleId)) as RoleRow | undefined;
    if (!row) throw new NotFoundError("岗位不存在");
    return roleFromRow(row);
  }
}

/** 保存 organization_domains 的 SQLite 行形状。 */
type DomainRow = {
  domain_id: string;
  display_name: string;
  office_zone: string;
  group_name: string;
  responsibilities_json: string;
  version: number;
};
/** 保存 role_definitions 的 SQLite 行形状。 */
type RoleRow = {
  role_id: string;
  domain_id: string;
  title: string;
  objective: string;
  responsibilities_json: string;
  inputs_json: string;
  outputs_json: string;
  allowed_tools_json: string;
  visible_objects_json: string;
  allowed_objects_json: string;
  forbidden_actions_json: string;
  object_actions_json: string;
  path_policy_json: string;
  command_policy_json: string;
  role_version: number;
  enabled: number;
};
/** 保存 organization_members 的 SQLite 行形状。 */
type MemberRow = {
  instance_id: string;
  role_id: string;
  display_name: string;
  specialist_tag: string;
  office_zone: string;
  desk_group: string;
  status: "available" | "busy" | "blocked";
  role_version: number;
  role_enabled?: number;
  current_role_version?: number;
};
/** 将领域行恢复为组织查询模型。 */
function domainFromRow(row: DomainRow): OrganizationDomain {
  return {
    domainId: row.domain_id as OrganizationDomain["domainId"],
    displayName: row.display_name,
    officeZone: row.office_zone,
    groupName: row.group_name,
    responsibilities: jsonValue<string[]>(row.responsibilities_json),
    version: row.version,
  };
}
/** 将岗位行恢复为严格岗位定义并重新执行完整性校验。 */
function roleFromRow(row: RoleRow): RoleDefinition {
  return assertCompleteRoleDefinition({
    roleId: row.role_id,
    domain: row.domain_id as RoleDefinition["domain"],
    title: row.title,
    objective: row.objective,
    responsibilities: jsonValue<string[]>(row.responsibilities_json),
    inputs: jsonValue<string[]>(row.inputs_json),
    outputs: jsonValue<string[]>(row.outputs_json),
    allowedTools: jsonValue<RoleDefinition["allowedTools"]>(
      row.allowed_tools_json,
    ),
    visibleObjects: jsonValue<string[]>(row.visible_objects_json),
    allowedObjects: jsonValue<string[]>(row.allowed_objects_json),
    forbiddenActions: jsonValue<string[]>(row.forbidden_actions_json),
    objectActions: jsonValue<RoleDefinition["objectActions"]>(
      row.object_actions_json,
    ),
    pathPolicy: jsonValue<RoleDefinition["pathPolicy"]>(row.path_policy_json),
    commandPolicy: jsonValue<RoleDefinition["commandPolicy"]>(
      row.command_policy_json,
    ),
    roleVersion: row.role_version,
    enabled: row.enabled === 1,
  });
}
/** 将员工行恢复为办公室和消息使用的员工实例。 */
function memberFromRow(row: MemberRow): OrganizationMember {
  return {
    instanceId: row.instance_id,
    roleId: row.role_id,
    displayName: row.display_name,
    specialistTag: row.specialist_tag,
    officeZone: row.office_zone,
    deskGroup: row.desk_group,
    status: row.status,
    roleVersion: row.role_version,
  };
}
