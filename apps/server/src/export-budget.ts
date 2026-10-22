import { HttpException } from '@nestjs/common';
import { rateLimit, redis } from './auth.js';
import { opaqueToken } from './security.js';
// A shared Redis lease bounds memory across API instances. No DB connection waits on it.
export async function withExportBudget<T>(
  actor: string,
  contest: string,
  run: () => Promise<T>,
): Promise<T> {
  await rateLimit(`exports:${actor}`, 20);
  const token = opaqueToken();
  const acquired = Number(
    await redis.eval(
      "if redis.call('ZCOUNT',KEYS[1],ARGV[1],'+inf')>=2 or redis.call('EXISTS',KEYS[2])==1 then return 0 end; redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[1],180); redis.call('SET',KEYS[2],ARGV[3],'EX',180); return 1",
      2,
      'export-leases',
      `export-contest:${contest}`,
      Date.now(),
      Date.now() + 180000,
      token,
    ),
  );
  if (!acquired) throw new HttpException('导出繁忙，请稍后重试', 429);
  try {
    return await run();
  } finally {
    await redis.eval(
      "redis.call('ZREM',KEYS[1],ARGV[1]); if redis.call('GET',KEYS[2])==ARGV[1] then redis.call('DEL',KEYS[2]) end",
      2,
      'export-leases',
      `export-contest:${contest}`,
      token,
    );
  }
}
