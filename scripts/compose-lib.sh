#!/usr/bin/env bash
# Called after backup/restore switches to the repository root.
# The install entry supplies explicit paths; the original root deployment remains the default.
contest_compose_file="${CONTEST_COMPOSE_FILE:-$(pwd)/compose.yaml}"
contest_env_file="${CONTEST_ENV_FILE:-$(pwd)/.env}"
compose() {
  docker compose --env-file "$contest_env_file" -f "$contest_compose_file" "$@"
}
