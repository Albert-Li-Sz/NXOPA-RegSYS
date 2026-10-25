import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const folder = '.runtime/domjudge-packaging';
await mkdir(folder, { recursive: true });
const packaging = '396fd5446c53ec9dc6d66208b41915b9cdcd1bc1';
const archive = await fetch(
  `https://codeload.github.com/DOMjudge/domjudge-packaging/tar.gz/${packaging}`,
);
if (!archive.ok) throw new Error('Official packaging download failed');
await writeFile('.runtime/domjudge-packaging.tgz', Buffer.from(await archive.arrayBuffer()));
execFileSync('tar', [
  '-xzf',
  '.runtime/domjudge-packaging.tgz',
  '-C',
  folder,
  '--strip-components=1',
]);
const file = `${folder}/docker/domjudge.tar.gz`,
  hash = '3d46b31c296581833ac9f8e9b249d929fc28710e834b1cec68723791a2dceb97';
let existing: Buffer | undefined;
try {
  existing = await readFile(file);
} catch {}
if (!existing || createHash('sha256').update(existing).digest('hex') !== hash) {
  console.log('Downloading official DOMjudge 9.0.1 release in validated ranges');
  const total = 58250832,
    chunk = 4000000;
  const parts = await Promise.all(
    Array.from({ length: Math.ceil(total / chunk) }, async (_, i) => {
      const start = i * chunk,
        end = Math.min(total - 1, start + chunk - 1);
      const r = await fetch('https://www.domjudge.org/releases/domjudge-9.0.1.tar.gz', {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(240000),
      });
      if (r.status !== 206) throw new Error('Server did not accept range');
      const data = Buffer.from(await r.arrayBuffer());
      if (data.length !== end - start + 1) throw new Error('Release download incomplete');
      return data;
    }),
  );
  const data = Buffer.concat(parts);
  if (createHash('sha256').update(data).digest('hex') !== hash)
    throw new Error('DOMjudge release checksum mismatch');
  await writeFile(file, data);
}
execFileSync(
  'docker',
  ['build', '-t', 'contest-center-domjudge:9.0.1', '-f', 'domserver/Dockerfile', '.'],
  { cwd: `${folder}/docker`, stdio: 'inherit' },
);
console.log(
  'DOMjudge 9.0.1 fixture ready. Start infra/fixtures/domjudge/compose.yaml after stopping the Hydro fixture.',
);
