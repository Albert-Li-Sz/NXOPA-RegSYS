import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const base = process.env.CONTEST_CENTER_URL ?? 'http://localhost:3000';
const token = process.env.CONTEST_CENTER_TOKEN;
if (!token) throw new Error('CONTEST_CENTER_TOKEN is required');
const server = new McpServer({ name: 'contest-center', version: '1.0.0' });
async function query(path: string) {
  const response = await fetch(`${base}/api/automation/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !response.ok,
  };
}
server.registerTool(
  'list_contests',
  { description: '查询 Token 授权的竞赛', inputSchema: {} },
  () => query('/contests'),
);
server.registerTool(
  'list_registrations',
  {
    description: '查询授权竞赛的报名；按字段权限脱敏，每页 500 条，用最后一项 ID 作为 cursor',
    inputSchema: { contestId: z.string().uuid().optional(), cursor: z.string().uuid().optional() },
  },
  ({ contestId, cursor }) =>
    query(
      `/registrations?${new URLSearchParams({ ...(contestId ? { contestId } : {}), ...(cursor ? { cursor } : {}) })}`,
    ),
);
server.registerTool(
  'get_registration',
  { description: '查询一份授权报名', inputSchema: { registrationId: z.string().uuid() } },
  ({ registrationId }) => query(`/registrations/${registrationId}`),
);
server.registerTool(
  'get_finance_summary',
  {
    description: '查询授权竞赛的财务摘要（人民币分）',
    inputSchema: { contestId: z.string().uuid() },
  },
  ({ contestId }) => query(`/finance?contestId=${contestId}`),
);
server.registerTool(
  'get_support_ticket',
  { description: '查询授权竞赛工单', inputSchema: { ticketId: z.string().uuid() } },
  ({ ticketId }) => query(`/support/${ticketId}`),
);
await server.connect(new StdioServerTransport());
