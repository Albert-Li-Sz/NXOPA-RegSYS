import { describe, it, expect } from 'vitest';
import {
  policySchema,
  quoteFee,
  contestStatus,
  registrationEligible,
  fieldsSchema,
} from '../../packages/contracts/src/index.js';
import { renderTemplate } from '../../apps/server/src/templates.js';
describe('domain boundaries', () => {
  it('uses inclusive start and exclusive end in UTC', () => {
    const c = {
      opensAt: '2026-10-10T00:00:00Z',
      closesAt: '2026-10-11T00:00:00Z',
      manuallyClosed: false,
    };
    expect(contestStatus(c, new Date(c.opensAt))).toBe('OPEN');
    expect(contestStatus(c, new Date(c.closesAt))).toBe('CLOSED');
    expect(contestStatus({ ...c, manuallyClosed: true }, new Date(c.opensAt))).toBe('CLOSED');
  });
  it('does not treat vouchers as payment', () => {
    const p = policySchema.parse({
      feeMode: 'PER_PERSON',
      feeCents: 500,
      minMembers: 1,
      maxMembers: 1,
    });
    const r = {
      status: 'SUBMITTED',
      review: 'APPROVED',
      feeCents: 500,
      netPaidCents: 499,
      people: [{ confirmed: true, active: true }],
      coaches: [],
    };
    expect(quoteFee(p, 3)).toBe(1500);
    expect(registrationEligible(r, p)).toBe(false);
    expect(registrationEligible({ ...r, netPaidCents: 500 }, p)).toBe(true);
    expect(registrationEligible({ ...r, status: 'CORRECTION', netPaidCents: 500 }, p)).toBe(false);
    expect(
      registrationEligible(
        { ...r, review: 'REJECTED', netPaidCents: 500 },
        { ...p, manualReview: false },
      ),
    ).toBe(false);
  });
  it('renders escaped Chinese data and an entire team in one document', () => {
    const out = renderTemplate(
      '{{#each team.members}}{{this.name}} {{this.school}}\n{{/each}}{{#if team.name}}{{team.name}}{{/if}}',
      {
        team: {
          name: '团队',
          members: [
            { name: '甲 & 乙', school: '100%_#' },
            { name: '丙', school: '大学' },
          ],
        },
      },
    );
    expect(out).toContain('甲 \\& 乙');
    expect(out).toContain('100\\%\\_\\#');
    expect(out).toContain('丙');
    expect(out).toContain('团队');
  });
  it('rejects prototype fields and raw substitutions', () => {
    expect(() =>
      fieldsSchema.parse([{ key: 'constructor', label: 'bad', scope: 'PERSON', type: 'text' }]),
    ).toThrow();
    expect(() => renderTemplate('{{{secret}}}', {})).toThrow();
    expect(() => renderTemplate('{{__proto__.x}}', {})).toThrow();
  });
});
