#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source scripts/compose-lib.sh
destination="${1:-.runtime/backups}"
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"
stage="$(mktemp -d "$destination/.backup-XXXXXX")"
restart(){ compose start api worker >/dev/null; rm -rf "$stage"; }
trap restart EXIT
compose stop api worker >/dev/null
compose exec -T postgres pg_dump -U contest -d contest_center -Fc > "$stage/database.dump"
compose run --rm -T --no-deps --user 1000 worker sh -c 'if test -f src/storage-cli.ts; then node --import tsx src/storage-cli.ts export /data/storage/.s3-backup; fi'
compose run --rm -T --no-deps --user 1000 worker tar -czf - -C /data/storage . > "$stage/files.tgz"
compose run --rm -T --no-deps --user 1000 worker sh -c 'if test -f src/storage-cli.ts; then node --import tsx src/storage-cli.ts clean /data/storage/.s3-backup; fi'
cp "$contest_env_file" "$stage/environment.env"
COPYFILE_DISABLE=1 tar -czf "$stage/raw.tgz" -C "$stage" database.dump files.tgz environment.env
# Host-owned output remains readable and chmod-able for non-root Linux installers.
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" api node --import tsx /app/scripts/archive-crypto.ts encrypt /backup/raw.tgz /backup/encrypted.ccbak
name="contest-center-$(date -u +%Y%m%dT%H%M%SZ).ccbak"
mv "$stage/encrypted.ccbak" "$destination/$name"
chmod 600 "$destination/$name"
echo "Encrypted backup created: $destination/$name"
find "$destination" -maxdepth 1 -name 'contest-center-*.ccbak' -type f -mtime +30 -delete
