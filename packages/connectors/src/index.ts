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
  const r = await fetch(`${c.baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...headers(c), ...init.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Platform HTTP ${r.status} at ${path}`);
  return r.json();
}
export class HydroConnector implements ContestPlatformConnector {
  async probe(c: ConnectorConfiguration) {
    return request(c, '/contest-center/v1/probe');
  }
  async provisionRegistration(
    c: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1> {
    const output = await request(c, '/contest-center/v1/provision', {
      method: 'POST',
      body: JSON.stringify({ ...input, domainId: c.domainId, contestId: c.remoteContestId }),
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
      body: JSON.stringify({ ...input, domainId: c.domainId, contestId: c.remoteContestId }),
    });
  }
}
type RemoteUser = {
  id: string;
  username: string;
  team_id: string;
  roles: string[];
  enabled: boolean;
};
export class DOMjudgeConnector implements ContestPlatformConnector {
  async probe(c: ConnectorConfiguration) {
    const info = await request(c, '/api/');
    const version = String(
      info.domjudge?.version ?? info.provider?.version ?? info.domjudge_version ?? 'unknown',
    );
    if (!version.startsWith('9.0.1'))
      throw new Error(`DOMjudge ${version} has not been validated; expected 9.0.1`);
    await request(c, '/api/users');
    await request(c, `/api/contests/${encodeURIComponent(c.remoteContestId)}`);
    return { version, capabilities: ['provision', 'query', 'independent_team_account'] };
  }
  async provisionRegistration(
    c: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1> {
    const teamId = `cc-${input.envelope.registrationId.replaceAll('-', '')}`;
    const teamPath = `/api/contests/${encodeURIComponent(c.remoteContestId)}/teams/${teamId}`;
    let team: Record<string, unknown> | undefined;
    try {
      team = await request(c, teamPath);
    } catch (e) {
      if (!String(e).includes('HTTP 404')) throw e;
    }
    if (!team)
      await request(c, `/api/contests/${encodeURIComponent(c.remoteContestId)}/teams`, {
        method: 'POST',
        body: JSON.stringify({
          id: teamId,
          name: input.envelope.teamName || input.envelope.people[0]!.name,
          display_name: input.envelope.teamName || input.envelope.people[0]!.name,
          group_ids: c.groupIds,
          organization_id: c.organizationId ?? null,
          members: input.envelope.people.map((p) => p.name).join(', '),
        }),
      });
    team = await request(c, teamPath);
    await input.onProgress?.({
      schemaVersion: 1,
      registrationId: input.envelope.registrationId,
      state: 'TEAM_CREATED',
      remoteTeamId: teamId,
      username: input.username,
    });
    const users = (await request(c, '/api/users')) as RemoteUser[];
    const prior = users.find((u) => u.username === input.username);
    if (prior && prior.team_id !== teamId)
      throw new Error('Remote username already belongs to a different team');
    if (!prior)
      await request(c, '/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: input.username,
          name: input.envelope.teamName || input.envelope.people[0]!.name,
          email: null,
          ip: null,
          password: input.password,
          enabled: true,
          team_id: teamId,
          roles: ['team'],
        }),
      });
    const account = ((await request(c, '/api/users')) as RemoteUser[]).find(
      (u) => u.username === input.username,
    );
    await input.onProgress?.({
      schemaVersion: 1,
      registrationId: input.envelope.registrationId,
      state: 'ACCOUNT_CREATED',
      remoteTeamId: teamId,
      remoteUserId: String(account?.id),
      username: input.username,
    });
    return this.getProvisioningResult(c, input);
  }
  async getProvisioningResult(
    c: ConnectorConfiguration,
    input: ProvisioningInput,
  ): Promise<ProvisioningResultV1> {
    const teamId = `cc-${input.envelope.registrationId.replaceAll('-', '')}`;
    const team = await request(
      c,
      `/api/contests/${encodeURIComponent(c.remoteContestId)}/teams/${teamId}`,
    );
    const users = (await request(c, '/api/users')) as RemoteUser[];
    const account = users.find(
      (u) => u.username === input.username && u.team_id === teamId && u.enabled,
    );
    if (!account || String(team.id) !== teamId)
      throw new Error('Account or contest team linkage was not verified');
    const participantConfig = {
      ...c,
      credentials: { username: input.username, password: input.password },
    };
    const me = await request(participantConfig, '/api/user');
    const contests = (await request(participantConfig, '/api/contests')) as { id: string }[];
    if (me.username !== input.username || !contests.some((x) => String(x.id) === c.remoteContestId))
      throw new Error('Participant login or contest access failed');
    return {
      schemaVersion: 1,
      registrationId: input.envelope.registrationId,
      state: 'VERIFIED',
      remoteUserId: String(account.id),
      remoteTeamId: teamId,
      username: input.username,
    };
  }
}
export function connector(type: string): ContestPlatformConnector {
  if (type === 'HYDRO') return new HydroConnector();
  if (type === 'DOMJUDGE') return new DOMjudgeConnector();
  throw new Error('Unsupported platform type');
}
