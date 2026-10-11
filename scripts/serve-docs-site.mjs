import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/docs-site');
const prefix = '/NXOPA-RegSYS/';
const port = Number(process.env.DOCS_PORT ?? 5184);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tex': 'text/plain; charset=utf-8',
};
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:' + port);
    if (url.pathname === '/' || url.pathname === prefix.slice(0, -1)) {
      response.writeHead(302, { Location: prefix }).end();
      return;
    }
    if (!url.pathname.startsWith(prefix)) throw new Error('Unknown path');
    const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile())
      throw new Error('Unknown file');
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('页面未找到');
  }
}).listen(port, '127.0.0.1', () => {
  console.log('Local: http://localhost:' + port + prefix);
});
