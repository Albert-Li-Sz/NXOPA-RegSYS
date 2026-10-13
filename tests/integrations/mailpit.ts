import { until } from './client.js';
import { createHash } from 'node:crypto';
import { db } from '../../apps/server/src/db.js';
export const mailpitBase = process.env.MAILPIT_URL ?? 'http://localhost:58025';

// Outbox workers can deliver initial verification and resend messages out of order.
// Select the requested return path rather than assuming the newest message matches.
export async function verificationUrl(email: string, returnPath?: string): Promise<URL> {
  const result = await until(
    async () => {
      const search = (await (
        await fetch(`${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
      ).json()) as { messages?: { ID: string }[] };
      const messages = await Promise.all(
        (search.messages ?? []).map(async ({ ID }) => {
          const message = (await (await fetch(`${mailpitBase}/api/v1/message/${ID}`)).json()) as {
            Text?: string;
          };
          const url = (message.Text ?? '').match(/http[^\s]+\/account\/verify\?[^\s]+/)?.[0];
          return url ? new URL(url) : null;
        }),
      );
      const recipient = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      const active = new Set(
        (
          await db.emailToken.findMany({
            where: {
              userId: recipient.id,
              purpose: 'VERIFY',
              usedAt: null,
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          })
        ).map((token) => token.id),
      );
      return (
        messages.find(
          (url) =>
            url &&
            active.has(
              createHash('sha256')
                .update(url.searchParams.get('token') ?? '')
                .digest('hex'),
            ) &&
            (returnPath === undefined || url.searchParams.get('next') === returnPath),
        ) ?? null
      );
    },
    (url) => url !== null,
    30000,
  );
  if (!result) throw new Error('Verification message missing');
  return result;
}
