#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source scripts/compose-lib.sh
destination="${1:-.runtime/backups}"
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"
stage="$(mktemp -d "$destination/.backup-XXXXXX")"
running_services=()
restart(){
  local status=$?
  trap - EXIT
  if [[ ${#running_services[@]} -gt 0 ]]; then compose start "${running_services[@]}" >/dev/null || status=1; fi
  rm -rf "$stage" || status=1
  exit "$status"
}
trap restart EXIT
# The env file may already select the next release. Read the previous runtime
# before stopping it so its database client matches the database being backed up.
printf 'services:\n' > "$stage/runtime.yaml"
has_runtime=false
for service in api worker; do
  container="$(compose ps -a -q "$service")"
  if [[ -n "$container" ]]; then
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]]; then running_services+=("$service"); fi
    image="$(docker inspect --format '{{.Image}}' "$container")"
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Cannot identify the installed backup runtime.' >&2; exit 1; }
    printf '  %s:\n    image: %s\n    build: !reset null\n' "$service" "$image" >> "$stage/runtime.yaml"
    has_runtime=true
  fi
done
backup_compose(){ if [[ "$has_runtime" == true ]]; then compose -f "$stage/runtime.yaml" "$@"; else compose "$@"; fi; }
compose stop api worker >/dev/null
compose exec -T postgres pg_dump -U contest -d contest_center -Fc > "$stage/database.dump"
has_s3_schema="$(compose exec -T postgres psql -U contest -d contest_center -Atqc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Attachment' AND column_name='storageBackend')")"
if [[ "$has_s3_schema" == t ]]; then backup_compose run --rm -T --no-deps --user 1000 worker sh -c 'test -f src/storage-cli.ts || { echo "Storage backup helper is missing" >&2; exit 1; }; node --import tsx src/storage-cli.ts export /data/storage/.s3-backup'; fi
backup_compose run --rm -T --no-deps --user 1000 worker tar -czf - -C /data/storage . > "$stage/files.tgz"
backup_compose run --rm -T --no-deps --user 1000 worker sh -c 'if test -f src/storage-cli.ts; then node --import tsx src/storage-cli.ts clean /data/storage/.s3-backup; fi'
cp "$contest_env_file" "$stage/environment.env"
COPYFILE_DISABLE=1 tar -czf "$stage/raw.tgz" -C "$stage" database.dump files.tgz environment.env
backup_compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" -v "$(pwd)/scripts/verify-backup.mjs:/verify-backup.mjs:ro" api node /verify-backup.mjs /backup/raw.tgz outer
backup_compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" -v "$(pwd)/scripts/verify-backup.mjs:/verify-backup.mjs:ro" api node /verify-backup.mjs /backup/files.tgz files
# Host-owned output remains readable and chmod-able for non-root Linux installers.
backup_compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" api node --import tsx /app/scripts/archive-crypto.ts encrypt /backup/raw.tgz /backup/encrypted.ccbak
name="contest-center-$(date -u +%Y%m%dT%H%M%SZ).ccbak"
mv "$stage/encrypted.ccbak" "$destination/$name"
chmod 600 "$destination/$name"
echo "Encrypted backup created: $destination/$name"
find "$destination" -maxdepth 1 -name 'contest-center-*.ccbak' -type f -mtime +30 -delete
