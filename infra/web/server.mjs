import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.pdf', 'application/pdf'],
]);

const server = createServer(async (req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const reply = (status, message, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(req.method === 'HEAD' ? undefined : message);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply(405, '仅支持 GET / HEAD', { Allow: 'GET, HEAD' });
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://web').pathname);
    if (pathname.includes('\0') || pathname.includes('\\')) {
      reply(400, '请求路径无效');
      return;
    }
    if (pathname === '/healthz') {
      reply(200, 'ok', { 'Cache-Control': 'no-store' });
      return;
    }
    let file = resolve(root, `.${pathname}`);
    if (
      (file !== resolve(root) && !file.startsWith(`${resolve(root)}${sep}`)) ||
      pathname.split('/').some((segment) => segment.startsWith('.'))
    ) {
      reply(404, '页面不存在');
      return;
    }
    let info;
    try {
      info = await stat(file);
      if (!info.isFile()) info = undefined;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    if (!info) {
      // Missing static files must not masquerade as successful HTML responses.
      if (/^\/(assets|brand|pdfjs)\//.test(pathname) || mime.has(extname(pathname))) {
        reply(404, '文件不存在');
        return;
      }
      file = resolve(root, 'index.html');
      info = await stat(file);
    }
    res.writeHead(200, {
      'Content-Type': mime.get(extname(file)) ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': /^\/assets\//.test(pathname)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    if (error instanceof URIError) reply(400, '请求路径无效');
    else {
      console.error('页面服务请求失败：', error.code ?? error.name);
      reply(500, '页面服务暂时不可用');
    }
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(port, '0.0.0.0', () => console.log(`官网页面服务已启动，端口 ${port}`));
