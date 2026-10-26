import { describe, it, expect } from 'vitest';
import {
  policySchema,
  quoteFee,
  contestStatus,
  registrationEligible,
  fieldsSchema,
  platformExportSchema,
  hydroExportFields,
  requiredHydroExportFields,
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
  it('requires approval for eligibility even in automatically reviewed activities', () => {
    const p = policySchema.parse({ manualReview: false, coachMode: 'DISABLED' });
    const r = {
      status: 'SUBMITTED',
      review: 'PENDING',
      feeCents: 0,
      netPaidCents: 0,
      people: [{ active: true, confirmed: true }],
      coaches: [],
    };
    expect(registrationEligible(r, p)).toBe(false);
    expect(registrationEligible({ ...r, review: 'APPROVED' }, p)).toBe(true);
  });
  it('accepts all 64 Hydro optional-field combinations with stable mandatory identity and rank', () => {
    const optional = hydroExportFields.filter(
      (field) => !requiredHydroExportFields.includes(field),
    );
    for (let bits = 0; bits < 64; bits++) {
      const fields = [
        ...requiredHydroExportFields,
        ...optional.filter((_, index) => bits & (1 << index)),
      ];
      expect(
        platformExportSchema.parse({ platform: 'HYDRO', hydroFields: fields }).hydroFields,
      ).toEqual(fields);
    }
    expect(platformExportSchema.parse({ platform: 'HYDRO' }).hydroFields).toBeUndefined();
    for (const hydroFields of [
      [],
      ['id', 'name'],
      ['id', 'name', 'rank', 'id'],
      ['id', 'name', 'rank', 'email'],
    ])
      expect(platformExportSchema.safeParse({ platform: 'HYDRO', hydroFields }).success).toBe(
        false,
      );
    expect(
      platformExportSchema.safeParse({ platform: 'DOMJUDGE', hydroFields: hydroExportFields })
        .success,
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
  it('bounds total template work even when nested loops produce no text', () => {
    const source = '{{#each members}}'.repeat(8) + '{{/each}}'.repeat(8);
    expect(() => renderTemplate(source, { members: Array(100).fill({}) })).toThrow(
      /模板展开|模板循环/,
    );
  });
  it('bounds expanded and escaped template output', () => {
    expect(() => renderTemplate('{{value}}{{value}}', { value: '中'.repeat(150000) })).toThrow(
      /250000/,
    );
    expect(() => renderTemplate('{{value}}', { value: '&'.repeat(150000) })).toThrow(/250000/);
  });
  it.each([{ min: -1 }, { max: 1.5 }, { min: 5, max: 2 }])(
    'rejects invalid text bounds %j',
    (bounds) => {
      expect(() =>
        fieldsSchema.parse([
          { key: 'answer', label: '文本', scope: 'PERSON', type: 'text', ...bounds },
        ]),
      ).toThrow();
    },
  );
});
