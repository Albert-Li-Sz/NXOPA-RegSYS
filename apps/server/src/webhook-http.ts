import { BlockList, isIP } from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BadRequestException } from '@nestjs/common';
import { config } from './config.js';

const private4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  private4.addSubnet(network, prefix);
const global6 = new BlockList();
const metadata = new BlockList();
metadata.addAddress('100.100.100.200');
metadata.addAddress('fd00:ec2::254', 'ipv6');
metadata.addAddress('fd20:ce::254', 'ipv6');
global6.addSubnet('2000::', 3, 'ipv6');
const private6 = new BlockList();
for (const [network, prefix] of [
  ['2001:db8::', 32],
  ['2001::', 32],
  ['2002::', 16],
] as const)
  private6.addSubnet(network, prefix, 'ipv6');
export function publicWebhookAddress(address: string) {
  if (isIP(address) === 4) return !private4.check(address);
  return isIP(address) === 6 && global6.check(address, 'ipv6') && !private6.check(address, 'ipv6');
}
export async function webhookTarget(
  raw: string,
  {
    allowPrivate = false,
    lookup = dns.lookup,
  }: {
    allowPrivate?: boolean;
    lookup?: (
      host: string,
      options: { all: true },
    ) => Promise<{ address: string; family: number }[]>;
  } = {},
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('Webhook 地址无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (config.production && url.protocol !== 'https:')
  )
    throw new BadRequestException('Webhook 需使用公网 HTTP(S) 地址，生产环境需要 HTTPS');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || /\.(localhost|local|internal)$/i.test(host)))
    throw new BadRequestException('Webhook 不允许内网地址');
  let records: { address: string; family: number }[];
  try {
    records = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
  } catch {
    throw new BadRequestException('Webhook 域名无法解析');
  }
  const privateAllowed = new BlockList();
  for (const [network, prefix] of [
    ['10.0.0.0', 8],
    ['127.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['100.64.0.0', 10],
  ] as const)
    privateAllowed.addSubnet(network, prefix);
  privateAllowed.addAddress('::1', 'ipv6');
  privateAllowed.addSubnet('fc00::', 7, 'ipv6');
  if (
    !records.length ||
    records.some(
      (record) =>
        metadata.check(record.address, isIP(record.address) === 6 ? 'ipv6' : 'ipv4') ||
        (!publicWebhookAddress(record.address) &&
          !(
            allowPrivate &&
            privateAllowed.check(record.address, isIP(record.address) === 6 ? 'ipv6' : 'ipv4')
          )),
    )
  )
    throw new BadRequestException('Webhook 不允许内网、回环或保留地址');
  return { url, address: records.find((record) => record.family === 4) ?? records[0]! };
}
export async function postWebhook(
  raw: string,
  body: string,
  headers: Record<string, string>,
  allowPrivate = false,
) {
  const { url, address } = await webhookTarget(raw, { allowPrivate });
  // Connect to the validated address directly; no second DNS lookup or redirects.
  const status = await new Promise<number>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      {
        protocol: url.protocol,
        hostname: address.address,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'POST',
        servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
        headers: { ...headers, Host: url.host, 'Content-Length': String(Buffer.byteLength(body)) },
        signal: AbortSignal.timeout(15000),
      },
      (response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      },
    );
    request.once('error', reject);
    request.end(body);
  });
  if (status < 200 || status >= 300) throw new Error(`Webhook HTTP ${status}`);
}
