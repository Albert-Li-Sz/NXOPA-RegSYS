import { describe, it, expect } from 'vitest';
import { normalizePaymentText, paymentReference } from '../../apps/server/src/finance-integrity.js';
import {
  answersSchema,
  policySchema,
  defaultSite,
  registrationReviewPhase,
} from '../../packages/contracts/src/index.js';
describe('2026-10-22 audit invariants', () => {
  it.each([' ABC 123 ', 'ＡＢＣ　１２３', '\tAbC\n123\r'])(
    'normalizes transfer identity: %s',
    (value) => {
      expect(normalizePaymentText(value)).toBe('abc 123');
      expect(paymentReference(normalizePaymentText(value))).toBe('payment:abc 123');
    },
  );
  it('separates incoming transfer and refund identities', () =>
    expect(paymentReference('a', true)).toBe('refund:a'));
  it('keeps invalidated submissions reviewable after the editing window closes', () =>
    expect(registrationReviewPhase({ status: 'CORRECTION', review: 'CORRECTION' })).toBe('AMEND'));
  it('keeps unsubmitted ordinary edits outside the review queue', () =>
    expect(registrationReviewPhase({ status: 'CORRECTION', review: 'PENDING' })).toBeNull());
  it('bounds stored answers before export allocation', () => {
    expect(answersSchema.safeParse({ answer: 'x'.repeat(65536) }).success).toBe(false);
    expect(answersSchema.safeParse({ answer: '合法资料' }).success).toBe(true);
  });
  it('rejects fee products that overflow the database amount', () =>
    expect(
      policySchema.safeParse({
        mode: 'TEAM',
        maxMembers: 30,
        feeMode: 'PER_PERSON',
        feeCents: 100_000_000,
      }).success,
    ).toBe(false));
  it('uses a primary color with accessible white text', () => {
    const channels = [1, 3, 5]
      .map((i) => parseInt(defaultSite.primaryColor.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const luminance = channels.reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
