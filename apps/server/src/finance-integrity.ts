import type { Tx } from './db.js';
// Channel display normalization does not define the database's transfer identity.
export function normalizePaymentText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}
export function paymentReference(value: string, refund = false) {
  return `${refund ? 'refund' : 'payment'}:${value}`;
}
// History and live writes deliberately call the same PostgreSQL function. JavaScript
// lowercasing and whitespace classes differ from PostgreSQL for valid Unicode input.
export async function normalizeTransactionReference(tx: Tx, value: string) {
  const rows = await tx.$queryRaw<
    { value: string }[]
  >`SELECT nxopa_normalize_payment_text(${value}) AS value`;
  return rows[0]!.value;
}
