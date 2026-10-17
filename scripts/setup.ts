import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
const existing = existsSync('.env');
const source = readFileSync(existing ? '.env' : '.env.example', 'utf8');
if (!existing || source.includes('GENERATE_WITH_PNPM_SETUP')) {
  writeFileSync(
    '.env',
    source.replace('GENERATE_WITH_PNPM_SETUP', randomBytes(32).toString('hex')),
    { mode: 0o600 },
  );
}
if (!/^[a-f0-9]{64}$/i.test(parse(readFileSync('.env', 'utf8')).ENCRYPTION_KEY ?? ''))
  throw new Error(
    'ENCRYPTION_KEY in .env is invalid; preserve the original key when repairing existing installations',
  );
for (const d of ['.runtime/storage', '.runtime/latex', '.runtime/backups'])
  mkdirSync(d, { recursive: true, mode: 0o700 });
console.log(
  'Local configuration ready. The encryption key in .env is valid and remains excluded from source control.',
);
