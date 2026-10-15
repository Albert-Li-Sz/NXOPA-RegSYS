import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const result = spawnSync('pnpm', ['audit', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
const report = JSON.parse(result.stdout);
if (report.error) throw new Error(report.error.message ?? 'Dependency audit unavailable');
const runtime = [],
  pluginPeers = [];
for (const advisory of Object.values(report.advisories ?? {})) {
  const paths = advisory.findings.flatMap((finding) => finding.paths);
  const finding = {
    module: advisory.module_name,
    severity: advisory.severity,
    patched: advisory.patched_versions,
    url: advisory.url,
    paths,
  };
  if (paths.some((path) => /^(apps|packages)__/.test(path))) runtime.push(finding);
  else pluginPeers.push(finding);
}
const output = {
  success: runtime.length === 0,
  checkedAt: new Date().toISOString(),
  runtimeFindings: runtime,
  externalPluginPeerFindings: pluginPeers,
};
mkdirSync('.runtime/reports', { recursive: true });
writeFileSync(
  '.runtime/reports/dependency-runtime-audit.json',
  JSON.stringify(output, null, 2) + '\n',
);
console.log(
  `Application runtime: ${runtime.length} advisories; separately tracked external plugin peer graph: ${pluginPeers.length}.`,
);
if (runtime.length) process.exitCode = 1;
