import assert from 'node:assert/strict';
export const fullRegressionSuites = [
  'test:integration',
  'test:registration-exports',
  'test:auth',
  'test:audit-20261022',
  'test:accounts',
  'test:feishu',
  'test:invitations',
  'test:mail',
  'test:mail-failover',
  'test:template-bugs',
  'test:overview',
  'test:enhancements',
  'test:admissions',
  'test:activity-workflows',
  'test:exam-sites',
  'test:bugs',
  'test:security',
  'test:audit-fixes',
  'test:whole-audit',
  'test:permissions',
  'test:file-race',
  'test:load',
  'test:e2e',
];
export const expectedChecks = {
  'test:permissions': 18,
  'test:whole-audit': 11,
  'test:security': 18,
  'test:audit-20261022': 15,
};
export function validateFullRegression(report, commit) {
  assert.equal(report.success, true);
  assert.equal(report.fullRun, true, 'Filtered regression cannot authorize a release');
  assert.equal(report.startCommit, commit, 'Tests must start on the released commit');
  assert.equal(report.commit, commit);
  assert.equal(report.startWorkingTreeDirty, false, 'Tests must start with a clean source tree');
  assert.equal(report.workingTreeDirty, false, 'Source changed during tests');
  for (const suite of fullRegressionSuites) {
    const result = report.results.find((result) => result.suite === suite);
    assert.equal(result?.success, true, `${suite} must pass before packaging`);
    assert.deepEqual(result.command, ['pnpm', suite], `${suite} must run without selectors`);
    if (expectedChecks[suite])
      assert.equal(
        result.checkCount,
        expectedChecks[suite],
        `${suite} must execute every declared check`,
      );
  }
  const browser = report.results.find((result) => result.suite === 'test:e2e').browser;
  assert.ok(browser && browser.expected > 0, 'Browser report must contain executed tests');
  assert.equal(browser.unexpected, 0);
  assert.equal(browser.skipped, 0, 'Skipped browser tests cannot authorize a release');
  assert.equal(browser.flaky, 0, 'Flaky browser tests must be resolved before a release');
}
