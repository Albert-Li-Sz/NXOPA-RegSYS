import { config } from '../apps/server/src/config.js';
import { db, lock, audit } from '../apps/server/src/db.js';
import { siteSettings, validatePublicUrl } from '../apps/server/src/site-settings.js';
const value = process.argv[2];
if (!value) throw new Error('用法：pnpm restore:public-url https://reg.example.org');
const publicUrl = validatePublicUrl(value);
try {
  const actor = await db.user.findFirstOrThrow({ where: { isAdmin: true }, select: { id: true } });
  const saved = await db.$transaction(async (tx) => {
    await lock(tx, 'setting:site');
    const { version, ...current } = await siteSettings();
    const setting = await tx.setting.upsert({
      where: { key: 'site' },
      create: { key: 'site', value: { ...current, publicUrl } },
      update: { value: { ...current, publicUrl }, version: { increment: 1 } },
    });
    await audit(tx, actor.id, 'SITE_URL_RECOVERY', 'site', {
      publicUrl,
      version: setting.version,
      method: 'CLI',
    });
    return setting;
  });
  console.log(
    `公网地址已恢复为 ${publicUrl}，配置版本 ${saved.version}。可信管理入口 ${config.publicUrl} 保持可用。`,
  );
} finally {
  await db.$disconnect();
}
