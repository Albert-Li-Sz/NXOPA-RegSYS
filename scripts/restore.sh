#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source scripts/compose-lib.sh
input="${1:?Pass the encrypted backup path}"
input="$(cd "$(dirname "$input")" && pwd)/$(basename "$input")"
mkdir -p .runtime
stage="$(mktemp -d "$(pwd)/.runtime/.restore-XXXXXX")"
services_stopped=false
finish(){ if [[ "$services_stopped" == true ]]; then compose start api worker >/dev/null; fi; rm -rf "$stage"; }
trap finish EXIT
cp "$input" "$stage/input.ccbak"
# Match the host owner so the installer can inspect and extract the private archive.
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" api node --import tsx /app/scripts/archive-crypto.ts decrypt /backup/input.ccbak /backup/raw.tgz
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" -v "$(pwd)/scripts/verify-backup.mjs:/verify-backup.mjs:ro" api node /verify-backup.mjs /backup/raw.tgz outer
tar --no-same-owner --no-same-permissions -xzf "$stage/raw.tgz" -C "$stage"
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" -v "$(pwd)/scripts/verify-backup.mjs:/verify-backup.mjs:ro" api node /verify-backup.mjs /backup/files.tgz files
compose stop api worker >/dev/null
services_stopped=true
compose exec -T postgres pg_restore -U contest -d contest_center --clean --if-exists --no-owner --single-transaction --exit-on-error < "$stage/database.dump"
# Only this recovery helper reads the host-private directory as root; restored files
# are assigned back to the normal application user before the services restart.
compose run --rm -T --no-deps --user root --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER -v "$stage:/backup" worker sh -c 'find /data/storage -mindepth 1 -delete && tar --no-same-owner --no-same-permissions --no-overwrite-dir -xzf /backup/files.tgz -C /data/storage && chown -R 1000:1000 /data/storage'
compose run --rm -T --no-deps initialize
compose run --rm -T --no-deps --user 1000 worker sh -c 'if test -f src/storage-cli.ts; then node --import tsx src/storage-cli.ts restore /data/storage/.s3-backup && node --import tsx src/storage-cli.ts clean /data/storage/.s3-backup; fi'
cp "$stage/environment.env" .runtime/restored-environment.env
chmod 600 .runtime/restored-environment.env
echo 'Database and private files restored. Original environment was saved to .runtime/restored-environment.env for comparison.'
