#!/usr/bin/env bash
# Called after backup/restore switches to the repository root.
# The install entry supplies explicit paths; the original root deployment remains the default.
contest_compose_file="${CONTEST_COMPOSE_FILE:-$(pwd)/compose.yaml}"
contest_env_file="${CONTEST_ENV_FILE:-$(pwd)/.env}"
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
