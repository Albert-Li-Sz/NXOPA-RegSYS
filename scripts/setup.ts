import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env')) {
  writeFileSync(
    '.env',
    readFileSync('.env.example', 'utf8').replace(
      'GENERATE_WITH_PNPM_SETUP',
      randomBytes(32).toString('hex'),
    ),
    { mode: 0o600 },
  );
}
for (const d of ['.runtime/storage', '.runtime/latex', '.runtime/backups'])
  mkdirSync(d, { recursive: true, mode: 0o700 });
console.log(
  'Local configuration ready. Secrets were generated in .env and are excluded from source control.',
);
