#!/usr/bin/env bash
# Called after backup/restore switches to the repository root.
# The install entry supplies explicit paths; the original root deployment remains the default.
contest_compose_file="${CONTEST_COMPOSE_FILE:-$(pwd)/compose.yaml}"
contest_env_file="${CONTEST_ENV_FILE:-$(pwd)/.env}"
if [[ ! -f "$contest_compose_file" && -f "$(pwd)/deploy/compose.yaml" ]]; then
  echo '安装器布局请使用 bash install.sh backup/restore；或显式提供 CONTEST_COMPOSE_FILE 与 CONTEST_ENV_FILE。' >&2
  exit 1
fi
[[ -f "$contest_compose_file" && -f "$contest_env_file" ]] || { echo '找不到 Compose 或环境配置文件，请通过 install.sh 操作实例。' >&2; exit 1; }
compose() {
  local compose_args=(--env-file "$contest_env_file" -f "$contest_compose_file")
  if [[ "$(awk -F= '$1=="STORAGE_MODE" {print $2;exit}' "$contest_env_file")" == MINIO ]]; then compose_args+=(--profile minio); fi
  if [[ -n "${CONTEST_COMPOSE_PLATFORM:-}" ]]; then compose_args+=(-f "$CONTEST_COMPOSE_PLATFORM"); fi
  if [[ -n "${CONTEST_COMPOSE_OVERRIDE:-}" ]]; then compose_args+=(-f "$CONTEST_COMPOSE_OVERRIDE"); fi
  # Match the installer: ignore legacy compose.digest.yaml during backup/restore.
  if [[ -n "${CONTEST_COMPOSE_PROXY:-}" ]]; then compose_args+=(-f "$CONTEST_COMPOSE_PROXY"); fi
  if [[ -n "${CONTEST_COMPOSE_PROXY_PLATFORM:-}" ]]; then compose_args+=(-f "$CONTEST_COMPOSE_PROXY_PLATFORM"); fi
  docker compose "${compose_args[@]}" "$@"
}
