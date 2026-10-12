#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source scripts/compose-lib.sh
input="${1:?Pass the encrypted backup path}"
input="$(cd "$(dirname "$input")" && pwd)/$(basename "$input")"
mkdir -p .runtime
stage="$(mktemp -d "$(pwd)/.runtime/.restore-XXXXXX")"
finish(){ compose start api worker >/dev/null; rm -rf "$stage"; }
trap finish EXIT
cp "$input" "$stage/input.ccbak"
compose run --rm -T --no-deps --user root --cap-add DAC_OVERRIDE -v "$stage:/backup" api pnpm exec tsx /app/scripts/archive-crypto.ts decrypt /backup/input.ccbak /backup/raw.tgz
tar -tzf "$stage/raw.tgz" | while IFS= read -r entry; do
  case "$entry" in database.dump|files.tgz|environment.env) ;; *) echo 'Unexpected backup entry' >&2; exit 1;; esac
done
tar -xzf "$stage/raw.tgz" -C "$stage"
compose stop api worker >/dev/null
compose exec -T postgres pg_restore -U contest -d contest_center --clean --if-exists --no-owner --single-transaction --exit-on-error < "$stage/database.dump"
compose run --rm -T --no-deps --user 1000 --cap-add DAC_OVERRIDE -v "$stage:/backup" worker sh -c 'rm -rf /data/storage/* && tar --no-same-owner -xzf /backup/files.tgz -C /data/storage'
cp "$stage/environment.env" .runtime/restored-environment.env
chmod 600 .runtime/restored-environment.env
echo 'Database and private files restored. Original environment was saved to .runtime/restored-environment.env for comparison.'
