import { describe, it, expect } from 'vitest';
import {
  fullRegressionSuites,
  expectedChecks,
  validateFullRegression,
} from '../../scripts/release-validation.mjs';
const fixture = () => ({
  success: true,
  fullRun: true,
  ojRun: true,
  startCommit: 'abc',
  commit: 'abc',
  startWorkingTreeDirty: false,
  workingTreeDirty: false,
  results: fullRegressionSuites.map((suite) => ({
    suite,
    success: true,
    checkCount: expectedChecks[suite],
    command: ['pnpm', suite],
    ...(suite === 'test:e2e'
      ? { browser: { expected: 100, unexpected: 0, skipped: 0, flaky: 0 } }
      : {}),
  })),
});
describe('release acceptance evidence', () => {
  it('accepts a complete clean run on the released revision', () =>
    expect(() => validateFullRegression(fixture(), 'abc')).not.toThrow());
  it.each(['fullRun', 'startWorkingTreeDirty', 'workingTreeDirty', 'startCommit', 'commit'])(
    'rejects mismatching %s',
    (key) => {
      const report = fixture();
      report[key] = typeof report[key] === 'boolean' ? !report[key] : 'other';
      expect(() => validateFullRegression(report, 'abc')).toThrow();
    },
  );
  it.each(['skipped', 'flaky', 'unexpected'])('rejects incomplete browser results: %s', (key) => {
    const report = fixture();
    report.results.at(-1).browser[key] = 1;
    expect(() => validateFullRegression(report, 'abc')).toThrow();
  });
  it('rejects selected browser cases masquerading as the full suite', () => {
    const report = fixture();
    report.results.at(-1).command.push('one.spec.ts');
    expect(() => validateFullRegression(report, 'abc')).toThrow();
  });
});
