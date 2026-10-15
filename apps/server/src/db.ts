import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 30 }),
});
const requestTransaction = new AsyncLocalStorage<Prisma.TransactionClient>();
// HTTP idempotency records and business writes commit in the same transaction.
export const db = new Proxy(client, {
  get(target, key) {
    const tx = requestTransaction.getStore();
    if (tx && key === '$transaction')
      return async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(tx);
    if (tx && key in tx) return Reflect.get(tx, key);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export function atomicRequest<T>(fn: () => Promise<T>) {
  return client.$transaction((tx) => requestTransaction.run(tx, fn), {
    timeout: 120000,
    maxWait: 10000,
  });
}
export type Tx = Prisma.TransactionClient;
export const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v));
export async function lock(tx: Tx, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
}
export async function audit(
  tx: Tx,
  actorId: string,
  action: string,
  resourceId: string,
  details: unknown = {},
) {
  await tx.auditEvent.create({ data: { actorId, action, resourceId, details: json(details) } });
}
export async function event(tx: Tx, type: string, resourceId: string, payload: unknown = {}) {
  await tx.outboxEvent.create({ data: { type, resourceId, payload: json(payload) } });
}
export async function enqueue(
  tx: Tx,
  kind: string,
  resourceId: string,
  dedupeKey: string,
  payload: unknown,
) {
  await lock(tx, `enqueue:${dedupeKey}`);
  const prior = await tx.job.findUnique({ where: { dedupeKey } });
  if (prior) return prior;
  const job = await tx.job.create({
    data: { kind, resourceId, dedupeKey, payload: json(payload), state: 'OUTBOX' },
  });
  await event(tx, 'TASK', resourceId, { jobId: job.id });
  return job;
}
export const registrationInclude = {
  contest: true,
  people: true,
  coaches: { include: { user: { select: { id: true, name: true, email: true } } } },
} as const;
export type Registration = Prisma.RegistrationGetPayload<{ include: typeof registrationInclude }>;
