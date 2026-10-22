#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source scripts/compose-lib.sh
input="${1:?Pass the encrypted backup path}"
input="$(cd "$(dirname "$input")" && pwd)/$(basename "$input")"
if [[ "${2:-}" != --yes ]]; then
  printf '恢复将覆盖当前数据库和附件。输入 RESTORE 确认: ' >&2
  IFS= read -r confirmation
  [[ "$confirmation" == RESTORE ]] || { echo '已取消恢复。' >&2; exit 1; }
fi
mkdir -p .runtime
stage="$(mktemp -d "$(pwd)/.runtime/.restore-XXXXXX")"
services_stopped=false
running_services=()
for service in api worker; do
  if [[ -n "$(compose ps --status running -q "$service")" ]]; then running_services+=("$service"); fi
done
finish(){
  local status=$?
  trap - EXIT
  if [[ "$status" == 0 && "$services_stopped" == true && ${#running_services[@]} -gt 0 ]]; then compose start "${running_services[@]}" >/dev/null || status=1; fi
  if [[ "$status" != 0 && "$services_stopped" == true ]]; then echo '恢复失败；API 与 Worker 保持停止。请先排查并使用恢复前备份重新恢复，确认完整后再启动服务。' >&2; fi
  rm -rf "$stage" || status=1
  exit "$status"
}
trap finish EXIT
cp "$input" "$stage/input.ccbak"
# Match the host owner so the installer can inspect and extract the private archive.
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" api node --import tsx /app/scripts/archive-crypto.ts decrypt /backup/input.ccbak /backup/raw.tgz
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" -v "$(pwd)/scripts/verify-backup.mjs:/verify-backup.mjs:ro" api node /verify-backup.mjs /backup/raw.tgz outer
tar --no-same-owner --no-same-permissions -xzf "$stage/raw.tgz" -C "$stage"
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" -v "$(pwd)/scripts/verify-backup.mjs:/verify-backup.mjs:ro" api node /verify-backup.mjs /backup/files.tgz files
mkdir -p "$stage/files"
tar --no-same-owner --no-same-permissions -xzf "$stage/files.tgz" -C "$stage/files"
compose exec -T postgres pg_restore --data-only --table=Setting --file=- < "$stage/database.dump" > "$stage/settings.sql"
compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$stage:/backup" -v "$(pwd)/scripts/verify-storage-backup.mjs:/verify-storage-backup.mjs:ro" api node /verify-storage-backup.mjs /backup
bash scripts/backup.sh .runtime/pre-restore-backups
compose stop api worker >/dev/null
services_stopped=true
compose exec -T postgres pg_restore -U contest -d contest_center --clean --if-exists --no-owner --single-transaction --exit-on-error < "$stage/database.dump"
# Only this recovery helper reads the host-private directory as root; restored files
# are assigned back to the normal application user before the services restart.
compose run --rm -T --no-deps --user root --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER -v "$stage:/backup" worker sh -c 'find /data/storage -mindepth 1 -delete && tar --no-same-owner --no-same-permissions --no-overwrite-dir -xzf /backup/files.tgz -C /data/storage && chown -R 1000:1000 /data/storage'
compose run --rm -T --no-deps initialize
compose run --rm -T --no-deps --user 1000 worker sh -c 'test -f src/storage-cli.ts || exit 1; node --import tsx src/storage-cli.ts restore /data/storage/.s3-backup && node --import tsx src/storage-cli.ts clean /data/storage/.s3-backup'
cp "$stage/environment.env" .runtime/restored-environment.env
chmod 600 .runtime/restored-environment.env
echo 'Database and private files restored. Original environment was saved to .runtime/restored-environment.env for comparison.'
