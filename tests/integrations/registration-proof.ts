import { until } from './client.js';

export async function registrationProof(
  actor: { api(path: string, method?: string, body?: unknown): Promise<any> },
  email: string,
  next?: string,
  mailBase = process.env.MAILPIT_URL ?? 'http://localhost:58025',
) {
  const search = async () =>
    (await (
      await fetch(`${mailBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as { messages?: { ID: string }[] };
  const previous = new Set((await search()).messages?.map((message) => message.ID));
  const proof = await actor.api('/auth/register/code', 'POST', { email, next });
  const code = await until(
    async () => {
      for (const message of (await search()).messages ?? []) {
        if (previous.has(message.ID)) continue;
        const content = (await (
          await fetch(`${mailBase}/api/v1/message/${message.ID}`)
        ).json()) as { Text?: string; Subject?: string };
        if (!content.Subject?.includes('注册')) continue;
        const match = content.Text?.match(/验证码[：:\s]+(\d{6})/);
        if (match) return match[1]!;
      }
      return '';
    },
    Boolean,
    30000,
  );
  return { token: proof.token as string, code };
}
