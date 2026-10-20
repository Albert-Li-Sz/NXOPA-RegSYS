import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { BadRequestException } from '@nestjs/common';
import { config } from './config.js';
import { publicWebhookAddress } from './webhook-http.js';

export async function integrationTarget(raw: string, lookup = dns.lookup) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('外接平台地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new BadRequestException('仅支持 HTTP(S) 地址');
  if (config.production && url.protocol !== 'https:')
    throw new BadRequestException('生产环境外部连接需要 HTTPS');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let records: { address: string; family: number }[];
  try {
    records = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
  } catch {
    throw new BadRequestException('外接平台域名无法解析');
  }
  if (
    !records.length ||
    (!config.allowPrivate && records.some((r) => !publicWebhookAddress(r.address)))
  )
    throw new BadRequestException('此地址不在允许的公网范围');
  return { url, address: records.find((r) => r.family === 4) ?? records[0]! };
}

export async function integrationRequest(raw: string, init: RequestInit): Promise<Response> {
  const { url, address } = await integrationTarget(raw);
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string')
    throw new Error('Unsupported platform request body');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      {
        protocol: url.protocol,
        hostname: address.address,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: init.method ?? 'GET',
        servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
        headers: { ...Object.fromEntries(new Headers(init.headers)), Host: url.host },
        signal: init.signal ?? AbortSignal.timeout(20000),
      },
      async (response) => {
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            if (bytes > 10 * 1024 * 1024) {
              response.destroy();
              throw new Error('外接平台响应超过 10 MiB，请缩小数据范围');
            }
            chunks.push(Buffer.from(chunk));
          }
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
          const status = response.statusCode ?? 502;
          resolve(
            new Response(
              [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)),
              { status, headers },
            ),
          );
        } catch (error) {
          reject(error);
        }
      },
    );
    request.once('error', reject);
    request.end(init.body ?? undefined);
  });
}
