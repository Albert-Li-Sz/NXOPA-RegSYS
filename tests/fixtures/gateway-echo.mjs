import { createServer } from 'node:http';

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Set-Cookie', 'gateway_fixture=ok; Path=/; Secure; HttpOnly; SameSite=Lax');
  response.end(
    JSON.stringify({
      service: process.env.ECHO_SERVICE,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    }),
  );
}).listen(Number(process.env.ECHO_PORT), '0.0.0.0');
