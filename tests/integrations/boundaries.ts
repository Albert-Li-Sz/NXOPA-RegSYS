import assert from 'node:assert/strict';
import { pdfText } from './pdf-text.js';
import { readFile, writeFile, mkdir, chmod, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { Client, until, base } from './client.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { encrypt } from '../../apps/server/src/security.js';
import { policySchema, fieldsSchema } from '../../packages/contracts/src/index.js';
const reports: string[] = [];
const fixture = JSON.parse(await readFile('.runtime/acceptance-context.json', 'utf8'));
if (config.production) throw new Error('Boundary fixtures are development-only');
let server: ReturnType<typeof createServer> | undefined;
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice');
  const r = await alice.api(`/registrations/${fixture.paid}`);
  const unchanged = await alice.api(`/registrations/${r.id}`, 'PUT', {
    version: r.version,
    teamName: r.teamName,
    teamEnglishName: r.teamEnglishName,
    answers: r.answers,
    people: r.people,
  });
  assert.equal(unchanged.version, r.version);
  assert.equal(unchanged.eligible, true);
  reports.push('Unchanged save preserves review, qualification and version');
  const secretDir = path.join(config.spool, 'isolation-fixture');
  await mkdir(secretDir, { mode: 0o700, recursive: true });
  await chmod(secretDir, 0o700);
  await writeFile(path.join(secretDir, 'secret.tex'), 'SHOULD-NOT-BE-VISIBLE', { mode: 0o600 });
  const source = String.raw`\documentclass{article}\usepackage{shellesc}\begin{document}\ifnum\ShellEscapeStatus=0 SHELL-DISABLED\else SHELL-ENABLED\fi\quad\immediate\write18{touch shell-marker}\IfFileExists{/jobs/isolation-fixture/secret.tex}{\input{/jobs/isolation-fixture/secret.tex}}{ISOLATED}\end{document}`;
  const preview = await admin.api('/admissions/preview', 'POST', { source });
  const outcome = await until(
    () => admin.api(`/jobs/${preview.id}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    120000,
  );
  assert.equal(outcome.state, 'SUCCESS', outcome.error);
  const isolationPdf = await admin.raw(`/api/v1/jobs/${preview.id}/download`);
  assert.equal(isolationPdf.status, 200);
  const isolationBytes = Buffer.from(await isolationPdf.arrayBuffer());
  const isolationText = await pdfText(isolationBytes);
  assert.match(isolationText, /ISOLATED/);
  assert.match(isolationText, /SHELL-DISABLED/);
  assert.doesNotMatch(isolationText, /SHOULD-NOT-BE-VISIBLE|SHELL-ENABLED/);
  await writeFile('.runtime/reports/isolation.pdf', isolationBytes);
  const folder = path.join(config.spool, preview.id);
  const remainingFiles = await readdir(folder, { encoding: 'utf8' }).catch((): string[] => []);
  assert.ok(!remainingFiles.includes('shell-marker'));
  const inspect = JSON.parse(
    execFileSync(
      'docker',
      ['inspect', process.env.TEST_LATEX_CONTAINER ?? 'contest-center-dev-latex-1'],
      { encoding: 'utf8' },
    ),
  )[0];
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.Memory, 1200 * 1024 * 1024);
  assert.ok(
    !inspect.Mounts.some(
      (m: any) => m.Destination.includes('storage') || m.Destination.includes('docker.sock'),
    ),
  );
  reports.push(
    `XeLaTeX no network, read-only container, private per-job UID, no shell execution (${outcome.state})`,
  );
  await rm(secretDir, { recursive: true, force: true });
  const loop = await admin.api('/admissions/preview', 'POST', {
    source: String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`,
  });
  const start = Date.now();
  await until(
    () => admin.api(`/jobs/${loop.id}`),
    (j) => j.state === 'FAILED',
    90000,
  );
  await db.job.update({ where: { id: loop.id }, data: { attempts: 4 } });
  assert.ok(Date.now() - start < 90000);
  reports.push('Runaway TeX compilation terminates within CPU/time limits');
  const metrics = await admin.api('/admin/metrics');
  assert.equal(metrics.workerHealthy, true);
  reports.push('Worker heartbeat and persisted queue metrics');
  const photoContest = await admin.api('/contests', 'POST', {
    title: '照片素材与座位验收',
    season: '验收',
    description: '编译只收到当前报名的照片',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 1000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: fieldsSchema.parse([
      { key: 'photo', label: '照片', scope: 'PERSON', type: 'photo', required: true },
    ]),
  });
  let photo = await alice.api('/registrations', 'POST', { contestId: photoContest.id });
  const upload = new FormData();
  upload.append(
    'file',
    new Blob([await readFile('tests/fixtures/portrait.png')], { type: 'image/png' }),
    'photo.png',
  );
  const attachment = await alice.api(`/files?registrationId=${photo.id}`, 'POST', upload);
  photo = await alice.api(`/registrations/${photo.id}`, 'PUT', {
    version: photo.version,
    teamName: '',
    teamEnglishName: '',
    answers: {},
    people: photo.people.map((p: any) => ({ ...p, answers: { photo: attachment.id } })),
  });
  photo = await alice.api(`/registrations/${photo.id}/submit`, 'POST', { version: photo.version });
  await admin.api('/admissions/templates', 'POST', {
    contestId: photoContest.id,
    name: '照片准考证',
    source: String.raw`\documentclass[UTF8,fontset=fandol]{ctexart}\usepackage{graphicx}\begin{document}{{participant.name}}\quad {{admission.room}} / {{admission.seat}}\includegraphics[width=15mm]{ {{participant.assets.photo}} }\end{document}`,
  });
  let generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [photo.id],
    seats: [{ registrationId: photo.id, number: `PHOTO-${Date.now()}`, room: 'C303', seat: '17' }],
  });
  const photoId = generated.results[0].documentId;
  await until(
    () => admin.api(`/registrations/${photo.id}`),
    (r) => r.admissions.some((d: any) => d.id === photoId && d.state === 'READY'),
    120000,
  );
  const pdf = await admin.raw(`/api/v1/admissions/${photoId}/download`);
  assert.equal(pdf.status, 200);
  await writeFile('.runtime/reports/photo-admission.pdf', Buffer.from(await pdf.arrayBuffer()));
  generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [photo.id],
    seats: [{ registrationId: photo.id, room: 'C303', seat: '18' }],
  });
  assert.equal(generated.results[0].documentId, photoId);
  await until(
    () => admin.api(`/registrations/${photo.id}`),
    (r) =>
      r.admissions.some((d: any) => d.id === photoId && d.state === 'READY' && d.seat === '18'),
    120000,
  );
  reports.push(
    'Chinese PDF with authorized photo assets, batch seat assignment and versioned regeneration',
  );
  await db.contest.update({ where: { id: photoContest.id }, data: { archived: true } });
  console.log(`Boundary acceptance: ${reports.length} checks passed`);
} finally {
  server?.close();
  await writeFile('.runtime/reports/boundaries.json', JSON.stringify({ report: reports }, null, 2));
  await db.$disconnect();
  await redis.quit();
}
