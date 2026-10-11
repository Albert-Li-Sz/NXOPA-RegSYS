import { until } from './client.js';

// Outbox workers can deliver initial verification and resend messages out of order.
// Select the requested return path rather than assuming the newest message matches.
export async function verificationUrl(email: string, returnPath?: string): Promise<URL> {
  const result = await until(
    async () => {
      const search = (await (
        await fetch(
          `http://localhost:58025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        )
      ).json()) as { messages?: { ID: string }[] };
      const messages = await Promise.all(
        (search.messages ?? []).map(async ({ ID }) => {
          const message = (await (
            await fetch(`http://localhost:58025/api/v1/message/${ID}`)
          ).json()) as { Text?: string };
          const url = (message.Text ?? '').match(/http[^\s]+\/account\/verify\?[^\s]+/)?.[0];
          return url ? new URL(url) : null;
        }),
      );
      return (
        messages.find(
          (url) => url && (returnPath === undefined || url.searchParams.get('next') === returnPath),
        ) ?? null
      );
    },
    (url) => url !== null,
    30000,
  );
  if (!result) throw new Error('Verification message missing');
  return result;
}
