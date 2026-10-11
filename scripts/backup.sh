#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
destination="${1:-.runtime/backups}"
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"
stage="$(mktemp -d "$destination/.backup-XXXXXX")"
restart(){ docker compose start api worker >/dev/null; rm -rf "$stage"; }
trap restart EXIT
docker compose stop api worker >/dev/null
docker compose exec -T postgres pg_dump -U contest -d contest_center -Fc > "$stage/database.dump"
docker compose run --rm -T --no-deps --user 1000 worker tar -czf - -C /data/storage . > "$stage/files.tgz"
cp .env "$stage/environment.env"
COPYFILE_DISABLE=1 tar -czf "$stage/raw.tgz" -C "$stage" database.dump files.tgz environment.env
docker compose run --rm -T --no-deps --user root --cap-add DAC_OVERRIDE -v "$stage:/backup" api pnpm exec tsx /app/scripts/archive-crypto.ts encrypt /backup/raw.tgz /backup/encrypted.ccbak
name="contest-center-$(date -u +%Y%m%dT%H%M%SZ).ccbak"
mv "$stage/encrypted.ccbak" "$destination/$name"
chmod 600 "$destination/$name"
echo "Encrypted backup created: $destination/$name"
find "$destination" -maxdepth 1 -name 'contest-center-*.ccbak' -type f -mtime +30 -delete
