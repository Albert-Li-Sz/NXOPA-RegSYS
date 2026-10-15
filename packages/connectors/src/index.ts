import type {
  ConnectorConfiguration,
  ContestPlatformConnector,
  ProvisioningInput,
  ProvisioningResultV1,
} from '@contest-center/contracts';
const headers = (c: ConnectorConfiguration) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Authorization: c.credentials.token
    ? `Bearer ${c.credentials.token}`
    : `Basic ${Buffer.from(`${c.credentials.username}:${c.credentials.password}`).toString('base64')}`,
});
async function request(c: ConnectorConfiguration, path: string, init: RequestInit = {}) {
  const remaining = c.requestDeadline ? c.requestDeadline - Date.now() : 20000;
  if (remaining <= 0) throw new Error('Platform request deadline exceeded');
  const r = await fetch(`${c.baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...headers(c), ...init.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(Math.min(20000, remaining)),
  });
  if (!r.ok) throw new Error(`Platform HTTP ${r.status} at ${path}`);
  return r.json();
}
export class HydroConnector implements ContestPlatformConnector {
  async probe(c: ConnectorConfiguration) {
    const result = await request(c, '/contest-center/v1/probe');
    if (
      !['nickname', 'unofficial', 'contest_linkage'].every((cap) =>
        result.capabilities?.includes(cap),
      )
    )
      throw new Error('Hydro 插件能力不足，请升级到 0.2.0 或更新版本');
    return result;
  }
  async provisionRegistration(
    c: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1> {
    await this.probe(c);
    const output = await request(c, '/contest-center/v1/provision', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        domainId: c.domainId,
        contestId: c.remoteContestId,
        nickname: c.nickname !== false,
        unrank:
          c.importMode === 'FORCE_UNOFFICIAL' || input.envelope.participationType === 'UNOFFICIAL',
      }),
    });
    await input.onProgress?.(output);
    return output;
  }
  async getProvisioningResult(
    c: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1> {
    return request(c, '/contest-center/v1/result', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        domainId: c.domainId,
        contestId: c.remoteContestId,
        nickname: c.nickname !== false,
        unrank:
          c.importMode === 'FORCE_UNOFFICIAL' || input.envelope.participationType === 'UNOFFICIAL',
      }),
    });
  }
}
type RemoteUser = {
  id: string;
  username: string;
  team_id: string;
  roles: string[];
  enabled: boolean;
  name?: string;
  email?: string | null;
};
export class DOMjudgeConnector implements ContestPlatformConnector {
  async organizations(c: ConnectorConfiguration): Promise<any[]> {
    return request(c, '/api/organizations');
  }
  async groups(c: ConnectorConfiguration): Promise<any[]> {
    return request(c, `/api/contests/${encodeURIComponent(c.remoteContestId)}/groups`);
  }
  async createOrganization(
    c: ConnectorConfiguration,
    id: string,
    info: import('@contest-center/contracts').OrganizationInfo,
  ) {
    const prior = (await this.organizations(c)).find((x) => String(x.id) === id);
    if (prior) {
      if (prior.formal_name !== info.name && prior.name !== info.name)
        throw new Error('远端学校标识已被其他学校使用');
      return prior;
    }
    await request(c, '/api/organizations', {
      method: 'POST',
      body: JSON.stringify({
        id,
        name: info.shortName || info.name,
        formal_name: info.name,
        shortname: info.shortName,
        country: info.country,
        icpc_id: info.icpcId || null,
      }),
    });
    return (await this.organizations(c)).find((x) => String(x.id) === id);
  }
  async probe(c: ConnectorConfiguration) {
    const info = await request(c, '/api/');
    const version = String(
      info.domjudge?.version ?? info.provider?.version ?? info.domjudge_version ?? 'unknown',
    );
    if (!version.startsWith('9.0.1')) throw new Error(`DOMjudge ${version} 尚未验收，需要 9.0.1`);
    await request(c, '/api/users');
    await request(c, `/api/contests/${encodeURIComponent(c.remoteContestId)}`);
    await this.organizations(c);
    const groups = await this.groups(c);
    for (const id of [...c.groupIds, ...(c.unofficialGroupId ? [c.unofficialGroupId] : [])])
      if (!groups.some((x) => String(x.id) === id))
        throw new Error(`分组 ${id} 不允许参加目标比赛`);
    if (c.unofficialGroupId && c.groupIds.includes(c.unofficialGroupId))
      throw new Error('正式与非正式分组必须不同');
    const official = groups.find((x) => String(x.id) === c.groupIds[0]);
    const unofficial = groups.find((x) => String(x.id) === c.unofficialGroupId);
    if (
      official &&
      unofficial &&
      official.sortorder !== undefined &&
      unofficial.sortorder !== undefined &&
      official.sortorder === unofficial.sortorder
    )
      throw new Error('正式与非正式分组排名顺序相同，请在 DOMjudge 中设置不同排名顺序');
    return {
      version,
      capabilities: [
        'provision',
        'query',
        'organization',
        'team',
        'groups',
        'independent_team_account',
      ],
    };
  }
  private teamId(input: ProvisioningInput) {
    return input.remoteTeamId ?? `cc-${input.envelope.registrationId.replaceAll('-', '')}`;
  }
  private desired(c: ConnectorConfiguration, input: ProvisioningInput) {
    const fields = input.envelope.form?.answers.registration as Record<string, unknown> | undefined;
    const unofficial =
      c.importMode === 'FORCE_UNOFFICIAL' || input.envelope.participationType === 'UNOFFICIAL';
    if (unofficial && !c.unofficialGroupId) throw new Error('请配置非正式参赛分组');
    return {
      id: this.teamId(input),
      name: input.envelope.teamName || input.envelope.people[0]!.name,
      display_name: input.envelope.teamName || input.envelope.people[0]!.name,
      group_ids: unofficial ? [c.unofficialGroupId!] : c.groupIds,
      organization_id: c.organizationId ?? null,
      members: input.envelope.people.map((p) => p.name).join(', '),
      icpc_id: fields?.team_icpc_id || null,
      label: fields?.team_label || null,
      location: { description: String(fields?.team_location ?? '') },
      public_description: [
        input.envelope.teamEnglishName,
        input.envelope.people.map((p) => p.name).join(', '),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  async provisionRegistration(
    c: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1> {
    await this.probe(c);
    const desired = this.desired(c, input);
    if (
      c.organizationId &&
      !(await this.organizations(c)).some((x) => String(x.id) === c.organizationId)
    )
      throw new Error('确认的学校映射在远端不存在，请重新确认');
    if (desired.label) {
      const conflict = ((await request(c, '/api/teams')) as { id: string; label?: string }[]).find(
        (t) => t.label === desired.label && String(t.id) !== desired.id,
      );
      if (conflict)
        throw new Error(
          `队伍编号／座位 ${desired.label} 已被远端队伍 ${conflict.id} 使用。DOMjudge 要求队伍编号全局唯一，请修改该字段后重新审核并同步`,
        );
    }
    const teamPath = `/api/contests/${encodeURIComponent(c.remoteContestId)}/teams/${encodeURIComponent(desired.id)}`;
    let team;
    try {
      team = await request(c, teamPath);
    } catch (e) {
      if (!String(e).includes('HTTP 404')) throw e;
    }
    // DOMjudge 9.0.1 imports teams by external ID, so repeated POST updates the same team.
    if (!team || input.allowSharedTeamUpdate !== false)
      await request(c, `/api/contests/${encodeURIComponent(c.remoteContestId)}/teams`, {
        method: 'POST',
        body: JSON.stringify(desired),
      });
    else throw new Error('此远端队伍被其他比赛绑定共享，请管理员处理冲突后重试');
    await input.onProgress?.({
      schemaVersion: 1,
      registrationId: input.envelope.registrationId,
      state: 'TEAM_CREATED',
      remoteTeamId: desired.id,
      username: input.username,
    });
    const users = (await request(c, '/api/users')) as RemoteUser[];
    const prior = users.find((u) => u.username === input.username);
    if (prior && String(prior.team_id) !== desired.id) throw new Error('远端账号已绑定其他队伍');
    const email =
      input.envelope.people.find((p) => p.captain)?.email ||
      input.envelope.people[0]?.email ||
      null;
    if (!prior)
      await request(c, '/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: input.username,
          name: desired.name,
          email,
          ip: null,
          password: input.password,
          enabled: true,
          team_id: desired.id,
          roles: ['team'],
        }),
      });
    else if (
      (prior.name !== undefined && prior.name !== desired.name) ||
      (input.envelope.organization && prior.email !== email)
    )
      throw new Error(
        `DOMjudge 9.0.1 账号资料需要人工更新：名称 ${prior.name ?? ''} → ${desired.name}；邮箱 ${prior.email ?? ''} → ${email ?? ''}。请在远端后台修改后重试`,
      );
    const account = ((await request(c, '/api/users')) as RemoteUser[]).find(
      (u) => u.username === input.username,
    );
    await input.onProgress?.({
      schemaVersion: 1,
      registrationId: input.envelope.registrationId,
      state: 'ACCOUNT_CREATED',
      remoteTeamId: desired.id,
      remoteUserId: String(account?.id),
      username: input.username,
    });
    return this.getProvisioningResult(c, input);
  }
  async getProvisioningResult(
    c: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1> {
    const desired = this.desired(c, input);
    const team = await request(
      c,
      `/api/contests/${encodeURIComponent(c.remoteContestId)}/teams/${encodeURIComponent(desired.id)}?strict=false`,
    );
    const account = ((await request(c, '/api/users')) as RemoteUser[]).find(
      (u) =>
        u.username === input.username &&
        String(u.team_id) === desired.id &&
        u.enabled &&
        u.roles.includes('team'),
    );
    if (!account || String(team.id) !== desired.id) throw new Error('账号与队伍关联校验失败');
    if (
      team.name !== desired.name ||
      (team.display_name !== undefined && team.display_name !== desired.display_name) ||
      JSON.stringify((team.group_ids ?? []).map(String).sort()) !==
        JSON.stringify(desired.group_ids.map(String).sort()) ||
      String(team.organization_id ?? '') !== String(desired.organization_id ?? '')
    )
      throw new Error('队名、学校或参赛分组读回校验失败');
    if (team.public_description !== desired.public_description)
      throw new Error('队伍英文名与成员姓名读回校验失败');
    if (
      c.organizationId &&
      !(await this.organizations(c)).some((x) => String(x.id) === c.organizationId)
    )
      throw new Error('远端学校读回校验失败');
    const participant = {
      ...c,
      credentials: { username: input.username, password: input.password },
    };
    const me = await request(participant, '/api/user');
    const contests = (await request(participant, '/api/contests')) as { id: string }[];
    if (me.username !== input.username || !contests.some((x) => String(x.id) === c.remoteContestId))
      throw new Error('参赛账号实际登录或目标比赛访问失败');
    return {
      schemaVersion: 1,
      registrationId: input.envelope.registrationId,
      state: 'VERIFIED',
      remoteUserId: String(account.id),
      remoteTeamId: desired.id,
      username: input.username,
      verification: {
        teamName: team.name,
        organizationId: team.organization_id,
        groupIds: team.group_ids,
        contestId: c.remoteContestId,
        members: desired.members,
        publicDescription: team.public_description,
      },
    };
  }
}

export function connector(type: string): ContestPlatformConnector {
  if (type === 'HYDRO') return new HydroConnector();
  if (type === 'DOMJUDGE') return new DOMjudgeConnector();
  throw new Error('Unsupported platform type');
}
