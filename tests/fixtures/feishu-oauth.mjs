import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
let profile = { open_id: 'ou_fixture', name: '飞书测试用户', email: 'feishu-fixture@example.test' },
  tokenRequests = 0;
const codes = new Map(),
  tokens = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/fixture') {
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      profile = { ...profile, ...JSON.parse(body) };
    }
    res.end(JSON.stringify({ profile, tokenRequests }));
    return;
  }
  if (url.pathname === '/open-apis/authen/v1/authorize') {
    if (
      url.searchParams.get('response_type') !== 'code' ||
      url.searchParams.get('code_challenge_method') !== 'S256'
    ) {
      res.writeHead(400);
      res.end('{}');
      return;
    }
    const code = randomUUID();
    codes.set(code, {
      profile: { ...profile },
      redirect: url.searchParams.get('redirect_uri'),
      challenge: url.searchParams.get('code_challenge'),
    });
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: callback.href });
    res.end();
    return;
  }
  if (url.pathname === '/oauth/v3/token') {
    tokenRequests++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = new URLSearchParams(raw),
      record = codes.get(body.get('code'));
    codes.delete(body.get('code'));
    if (
      !record ||
      body.get('client_id') !== 'cli_fixture' ||
      body.get('client_secret') !== 'fixture-secret' ||
      body.get('grant_type') !== 'authorization_code' ||
      body.get('redirect_uri') !== record.redirect ||
      createHash('sha256')
        .update(body.get('code_verifier') || '')
        .digest('base64url') !== record.challenge
    ) {
      res.writeHead(400);
      res.end(JSON.stringify({ code: 20073 }));
      return;
    }
    const access_token = randomUUID();
    tokens.set(access_token, record.profile);
    res.end(JSON.stringify({ code: 0, access_token, expires_in: 3600 }));
    return;
  }
  if (url.pathname === '/open-apis/authen/v1/user_info') {
    const data = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    res.end(JSON.stringify(data ? { code: 0, data } : { code: 20005 }));
    return;
  }
  res.writeHead(404);
  res.end('{}');
});
server.listen(Number(process.env.FEISHU_FIXTURE_PORT), '127.0.0.1');
