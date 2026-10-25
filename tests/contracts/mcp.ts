import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Client as HttpClient, base } from '../integrations/client.js';
const context = JSON.parse(await readFile('.runtime/acceptance-context.json', 'utf8'));
const admin = await new HttpClient().login('admin');
const token = await admin.api('/admin/tokens', 'POST', {
  name: 'MCP acceptance fixture',
  contestIds: [context.freeContest],
  scopes: ['contests:read', 'registrations:read', 'finance:read', 'support:read'],
  fields: ['PERSON.name', 'FINANCE.summary'],
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
const transport = new StdioClientTransport({
  command: 'pnpm',
  args: ['--silent', '--filter', '@contest-center/mcp-adapter', 'start'],
  env: {
    ...(process.env as Record<string, string>),
    CONTEST_CENTER_TOKEN: token.token,
    CONTEST_CENTER_URL: `${base}/`,
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'acceptance-client', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
  assert.ok(tools.every((t) => /^(get|list)_/.test(t.name)));
  const good = await client.callTool({
    name: 'get_registration',
    arguments: { registrationId: context.individual },
  });
  assert.ok(!good.isError);
  const value = JSON.parse((good.content as any[])[0].text);
  assert.equal(value.people[0].email, undefined);
  assert.equal(value.organization, undefined);
  assert.equal(value.participationType, undefined);
  assert.deepEqual(value.people[0].answers, {});
  const denied = await client.callTool({
    name: 'get_registration',
    arguments: { registrationId: context.team },
  });
  assert.equal(denied.isError, true);
  const finance = await client.callTool({
    name: 'get_finance_summary',
    arguments: { contestId: context.freeContest },
  });
  assert.ok(!finance.isError);
  const support = await client.callTool({
    name: 'get_support_ticket',
    arguments: { ticketId: context.ticket },
  });
  assert.ok(!support.isError);
  const enhanced = JSON.parse(await readFile('.runtime/enhancement-context.json', 'utf8'));
  const scopedToken = await admin.api('/admin/tokens', 'POST', {
    name: 'MCP enhancement fields acceptance',
    contestIds: [enhanced.contestId],
    scopes: ['registrations:read'],
    fields: ['REGISTRATION.organization', 'REGISTRATION.participationType'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const scopedClient = new Client({ name: 'enhancement-fields-client', version: '1.0.0' });
  try {
    await scopedClient.connect(
      new StdioClientTransport({
        command: 'pnpm',
        args: ['--silent', '--filter', '@contest-center/mcp-adapter', 'start'],
        env: {
          ...(process.env as Record<string, string>),
          CONTEST_CENTER_TOKEN: scopedToken.token,
          CONTEST_CENTER_URL: base,
        },
        stderr: 'pipe',
      }),
    );
    const result = await scopedClient.callTool({
      name: 'get_registration',
      arguments: { registrationId: enhanced.registrationId },
    });
    assert.ok(!result.isError);
    const registration = JSON.parse((result.content as any[])[0].text);
    assert.equal(registration.organization.name, '南京晓庄学院');
    assert.ok(['OFFICIAL', 'UNOFFICIAL'].includes(registration.participationType));
    assert.equal(registration.people[0].name, undefined);
    assert.equal(registration.people[0].email, undefined);
  } finally {
    await scopedClient.close();
    await admin.api(`/admin/tokens/${scopedToken.id}`, 'DELETE');
  }
  await writeFile(
    '.runtime/reports/mcp.json',
    JSON.stringify(
      {
        status: 'PASS',
        tools: tools.map((t) => t.name),
        scopeDenial: 'PASS',
        fieldFiltering: 'PASS',
        enhancedFieldAuthorization: 'PASS',
      },
      null,
      2,
    ),
  );
  console.log(
    'Read-only stdio MCP: discovery, queries, field filtering and scope rejection passed',
  );
} finally {
  await client.close();
  await admin.api(`/admin/tokens/${token.id}`, 'DELETE');
}
