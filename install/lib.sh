#!/usr/bin/env bash
# Shared by the three installation entry points; never source the user's .env as shell code.

install_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$install_dir/.." && pwd)"
install_env="${INSTALL_ENV_FILE:-$install_dir/.env}"
case "$install_env" in
  /*) ;;
  *) install_env="$install_dir/$install_env" ;;
esac
export INSTALL_ENV_FILE="$install_env"
install_mode=source

fail() { printf '%s\n' "$*" >&2; exit 1; }

env_value() {
  local key="$1" file="${2:-$install_env}"
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      line=$0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      if (line !~ "^" key "[[:space:]]*=") next
      sub(/^[^=]*=[[:space:]]*/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line ~ /^"/) { sub(/^"/, "", line); sub(/"[[:space:]]*(#.*)?$/, "", line) }
      else if (line ~ /^\047/) { sub(/^\047/, "", line); sub(/\047[[:space:]]*(#.*)?$/, "", line) }
      else sub(/[[:space:]]+#.*$/, "", line)
      value=line
    }
    END { print value }
  ' "$file"
}

set_env_value() {
  local key="$1" value="$2" staged
  staged="$(mktemp "$install_env.tmp.XXXXXX")"
  if ! awk -v key="$key" -v value="$value" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
      if (!found) print key "=" value
      found=1; next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$install_env" > "$staged"; then
    rm -f "$staged"
    fail '配置写入失败。'
  fi
  chmod 600 "$staged"
  mv "$staged" "$install_env"
}

# Interactive operations always use the selected file, rather than unrelated shell overrides.
use_saved_environment() {
  unset INSTALL_MODE IMAGE_TAG IMAGE_PREFIX COMPOSE_PROJECT_NAME PUBLIC_URL SITE_ADDRESS \
    HTTP_PORT HTTPS_PORT POSTGRES_PASSWORD ENCRYPTION_KEY
}

ask() {
  local target="$1" question="$2" default="${3:-}" response
  printf '%s' "$question" >&2
  if [[ -n "$default" ]]; then printf ' [%s]' "$default" >&2; fi
  printf ': ' >&2
  if ! IFS= read -r response; then fail '输入已结束，操作取消。'; fi
  printf -v "$target" '%s' "${response:-$default}"
}

confirm() {
  local reply
  while true; do
    ask reply "$1（y/n）" "${2:-n}"
    case "$reply" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) printf '请输入 y 或 n。\n' >&2 ;;
    esac
  done
}

ask_port() {
  local target="$1" question="$2" default="$3" entered_port
  while true; do
    ask entered_port "$question" "$default"
    if [[ "$entered_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$entered_port >= 1 && 10#$entered_port <= 65535 )); then
      printf -v "$target" '%s' "$((10#$entered_port))"
      return
    fi
    printf '端口须为 1 至 65535 的整数。\n' >&2
  done
}

ask_tag() {
  local target="$1" default="$2" entered_tag
  while true; do
    ask entered_tag '目标镜像版本，例如 v0.1.2' "$default"
    if [[ "$entered_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]]; then
      printf -v "$target" '%s' "$entered_tag"
      return
    fi
    printf '请填写固定版本标签，例如 v0.1.2。\n' >&2
  done
}

init_env() {
  if [[ -f "$install_env" ]]; then
    chmod 600 "$install_env"
    printf '保留已有配置：%s\n' "$install_env"
    return
  fi
  command -v openssl >/dev/null 2>&1 || fail '缺少 openssl，请先安装后再生成配置。'
  local database_password encryption_key
  database_password="$(openssl rand -hex 24)"
  encryption_key="$(openssl rand -hex 32)"
  (
    set -o noclobber
    sed -e "s/^POSTGRES_PASSWORD=GENERATE_ON_INSTALL$/POSTGRES_PASSWORD=$database_password/" \
      -e "s/^ENCRYPTION_KEY=GENERATE_ON_INSTALL$/ENCRYPTION_KEY=$encryption_key/" \
      "$install_dir/.env.example" > "$install_env"
  )
  chmod 600 "$install_env"
  printf '已生成配置：%s（权限 600，密钥不在终端显示）\n' "$install_env"
}

compose() {
  local compose_args=(--project-directory "$install_dir" --env-file "$install_env" -f "$install_dir/compose.yaml")
  if [[ "$install_mode" == images ]]; then compose_args+=(-f "$install_dir/compose.images.yaml"); fi
  docker compose "${compose_args[@]}" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail '未安装 Docker。请按 install/README.md 安装 Docker Engine / Desktop。'
  local version major minor patch
  version="$(docker compose version --short 2>/dev/null)" || fail '缺少 Docker Compose 插件，请按 install/README.md 安装。'
  if [[ ! "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then fail '无法识别 Docker Compose 版本。'; fi
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
  if (( major < 2 || (major == 2 && (minor < 24 || (minor == 24 && patch < 4))) )); then
    fail '请升级到 Docker Compose 2.24.4 或更新版本。'
  fi
  docker info >/dev/null 2>&1 || fail '无法连接 Docker，请启动 Docker 并检查当前账号的权限。'
}

require_config() {
  [[ -f "$install_env" ]] || fail '尚未生成配置，请先运行 bash install.sh 或 bash install.sh init。'
  if awk '/^(ENCRYPTION_KEY|POSTGRES_PASSWORD)=GENERATE_ON_INSTALL$/ { found=1 } END { exit !found }' "$install_env"; then
    fail '配置仍包含未生成的密钥。请使用 init 创建配置，或填写有效的随机密钥。'
  fi
  install_mode="${INSTALL_MODE:-$(env_value INSTALL_MODE)}"
  install_mode="${install_mode:-source}"
  case "$install_mode" in
    source|images) ;;
    *) fail 'INSTALL_MODE 只能为 source 或 images。' ;;
  esac
  if [[ "$install_mode" == source && ! -f "$repo_root/infra/Dockerfile" ]]; then
    fail '源码模式需要完整仓库。Release 安装包请使用 INSTALL_MODE=images。'
  fi
  compose config --quiet
}

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

backup() {
  local destination override=""
  destination="$(absolute_path "${1:-$install_dir/backups}")"
  if [[ "$install_mode" == images ]]; then override="$install_dir/compose.images.yaml"; fi
  CONTEST_COMPOSE_FILE="$install_dir/compose.yaml" CONTEST_ENV_FILE="$install_env" \
    CONTEST_COMPOSE_OVERRIDE="$override" \
    bash "$repo_root/scripts/backup.sh" "$destination"
}

start_services() {
  if [[ "$install_mode" == images ]]; then
    compose pull || return
    compose up -d --no-build --wait --wait-timeout 240 || return
  else
    compose up -d --build --wait --wait-timeout 240 || return
  fi
  compose ps
}

show_settings() {
  printf '\n配置文件：%s\n项目名称：%s\n安装方式：%s\n访问地址：%s\n' \
    "$install_env" "$(env_value COMPOSE_PROJECT_NAME)" "$install_mode" "$(env_value PUBLIC_URL)"
  if [[ "$install_mode" == images ]]; then printf '镜像版本：%s\n' "$(env_value IMAGE_TAG)"; fi
}
