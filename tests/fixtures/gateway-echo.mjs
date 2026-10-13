import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Set-Cookie', 'gateway_fixture=ok; Path=/; Secure; HttpOnly; SameSite=Lax');
  response.end(
    JSON.stringify({
      service: process.env.ECHO_SERVICE,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.url?.startsWith('/api/v1/upload-size') ? '' : body.toString(),
      bodyBytes: body.length,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    }),
  );
}).listen(Number(process.env.ECHO_PORT), '0.0.0.0');
