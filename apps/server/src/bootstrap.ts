import { hash, argon2id } from 'argon2';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { db } from './db.js';
import { passwordSchema } from './auth.js';
import { defaultTemplate } from '@contest-center/contracts';
import { redis } from './auth.js';
const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = z
  .email()
  .parse(process.env.ADMIN_EMAIL ?? (await rl.question('Administrator email: ')))
  .toLowerCase();
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  rl.close();
  process.stdout.write('Administrator password (hidden): ');
  if (!process.stdin.isTTY) throw new Error('Use ADMIN_PASSWORD when stdin is not a terminal');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  password = await new Promise<string>((resolve) => {
    let value = '';
    process.stdin.on('data', function handler(buffer: Buffer) {
      for (const c of buffer.toString()) {
        if (c === '\r' || c === '\n') {
          process.stdin.off('data', handler);
          process.stdin.setRawMode(false);
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    });
  });
  process.stdout.write('\n');
}
passwordSchema.parse(password);
if (await db.user.findUnique({ where: { email } }))
  throw new Error('This email already exists; bootstrap never overwrites an account');
await db.$transaction(async (tx) => {
  const administrator = await tx.user.create({
    data: {
      email,
      username: process.env.ADMIN_USERNAME ?? 'administrator',
      name: '系统管理员',
      passwordHash: await hash(password, { type: argon2id }),
      verified: true,
      isAdmin: true,
    },
  });
  await tx.adminGrant.create({
    data: { userId: administrator.id, level: 'SYSTEM', grantedBy: administrator.id },
  });
});
if (!(await db.admissionTemplate.count()))
  await db.admissionTemplate.create({
    data: { name: '默认中文准考证', source: defaultTemplate, version: 1 },
  });
console.log('Administrator created.');
rl.close();
await db.$disconnect();
await redis.quit();
process.exit(0);
