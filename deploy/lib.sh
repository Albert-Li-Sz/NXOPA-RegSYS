#!/usr/bin/env bash
# Shared by the three installation entry points; never source the user's .env as shell code.

repo_root="${NXOPA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
install_dir="$repo_root/deploy"
install_env="${INSTALL_ENV_FILE:-$install_dir/.env}"
case "$install_env" in
  /*) ;;
  *) install_env="$install_dir/$install_env" ;;
esac
export INSTALL_ENV_FILE="$install_env"
install_mode=source
proxy_mode=gateway
platform_override=""
proxy_platform_override=""
proxy_override=""

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
    HTTP_PORT HTTPS_PORT WEB_PORT API_PORT GATEWAY_PORT REVERSE_PROXY_MODE POSTGRES_PASSWORD ENCRYPTION_KEY \
    API_BIND_ADDRESS WEB_BIND_ADDRESS GATEWAY_BIND_ADDRESS MINIO_BIND_ADDRESS \
    STORAGE_MODE MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_CONSOLE_PORT S3_ENDPOINT S3_REGION S3_BUCKET S3_PREFIX S3_ACCESS_KEY S3_SECRET_KEY S3_FORCE_PATH_STYLE
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
  local database_password encryption_key minio_user minio_password
  database_password="$(openssl rand -hex 24)"
  encryption_key="$(openssl rand -hex 32)"
  minio_user="nxopa$(openssl rand -hex 8)"
  minio_password="$(openssl rand -hex 32)"
  (
    set -o noclobber
    sed -e "s/^POSTGRES_PASSWORD=GENERATE_ON_INSTALL$/POSTGRES_PASSWORD=$database_password/" \
      -e "s/^ENCRYPTION_KEY=GENERATE_ON_INSTALL$/ENCRYPTION_KEY=$encryption_key/" \
      -e "s/^MINIO_ROOT_USER=GENERATE_ON_INSTALL$/MINIO_ROOT_USER=$minio_user/" \
      -e "s/^MINIO_ROOT_PASSWORD=GENERATE_ON_INSTALL$/MINIO_ROOT_PASSWORD=$minio_password/" \
      "$install_dir/.env.example" > "$install_env"
  )
  chmod 600 "$install_env"
  printf '已生成配置：%s（权限 600，密钥不在终端显示）\n' "$install_env"
}

compose() {
  local compose_args=(--project-directory "$install_dir" --env-file "$install_env" -f "$install_dir/compose.yaml")
  if [[ "$(env_value STORAGE_MODE)" == MINIO ]]; then compose_args+=(--profile minio); fi
  if [[ -n "$platform_override" ]]; then compose_args+=(-f "$platform_override"); fi
  if [[ "$install_mode" == images ]]; then
    compose_args+=(-f "$install_dir/compose.images.yaml")
    if [[ -f "$install_dir/compose.digest.yaml" && "$(head -n 1 "$install_dir/compose.digest.yaml")" == "# NXOPA_IMAGE_TAG=${IMAGE_TAG:-$(env_value IMAGE_TAG)}" ]]; then compose_args+=(-f "$install_dir/compose.digest.yaml"); fi
  fi
  if [[ -n "$proxy_override" ]]; then compose_args+=(-f "$proxy_override" -f "$proxy_platform_override"); fi
  if [[ "${1:-}" == pull ]]; then compose_args+=(--parallel 1); fi
  docker compose "${compose_args[@]}" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail '未安装 Docker。请按 deploy/README.md 安装 Docker Engine / Desktop。'
  local version major minor patch
  version="$(docker compose version --short 2>/dev/null)" || fail '缺少 Docker Compose 插件，请按 deploy/README.md 安装。'
  if [[ ! "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then fail '无法识别 Docker Compose 版本。'; fi
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
  if (( major < 2 || (major == 2 && (minor < 24 || (minor == 24 && patch < 4))) )); then
    fail '请升级到 Docker Compose 2.24.4 或更新版本。'
  fi
  docker info >/dev/null 2>&1 || fail '无法连接 Docker，请启动 Docker 并检查当前账号的权限。'
  local platform
  platform="${DOCKER_DEFAULT_PLATFORM:-$(docker info --format '{{.OSType}}/{{.Architecture}}')}"
  case "$platform" in
    linux/amd64|linux/x86_64)
      platform_override="$install_dir/compose.amd64.yaml"
      proxy_platform_override="$install_dir/compose.proxy.amd64.yaml" ;;
    linux/arm64|linux/aarch64|linux/arm64/v8)
      platform_override="$install_dir/compose.arm64.yaml"
      proxy_platform_override="$install_dir/compose.proxy.arm64.yaml" ;;
    *) fail '安装器支持 Linux amd64 / arm64 Docker 服务端，请检查 Docker context 和 DOCKER_DEFAULT_PLATFORM。' ;;
  esac
}

normalize_private_ports() {
  local key bind value address port
  for key in API_PORT WEB_PORT GATEWAY_PORT MINIO_CONSOLE_PORT; do
    case "$key" in API_PORT) bind=API_BIND_ADDRESS ;; WEB_PORT) bind=WEB_BIND_ADDRESS ;; GATEWAY_PORT) bind=GATEWAY_BIND_ADDRESS ;; *) bind=MINIO_BIND_ADDRESS ;; esac
    value="${!key:-$(env_value "$key")}"
    [[ -n "$value" ]] || continue
    address="${!bind:-$(env_value "$bind")}"; address="${address:-127.0.0.1}"
    port="$value"
    # Read old host:port files without rewriting the saved configuration.
    if [[ "$value" == *:* ]]; then address="${value%:*}"; port="${value##*:}"; address="${address#[}"; address="${address%]}"; fi
    [[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || fail "$key 端口无效。"
    printf -v "$key" '%s' "$((10#$port))"; export "$key"
    printf -v "$bind" '%s' "$address"; export "$bind"
  done
}
require_config() {
  [[ -f "$install_env" ]] || fail '尚未生成配置，请先运行 bash ../install.sh 或 bash ../install.sh init。'
  if [[ "$(env_value STORAGE_MODE)" == MINIO ]]; then
    [[ -n "$(env_value MINIO_ROOT_USER)" && -n "$(env_value MINIO_ROOT_PASSWORD)" ]] || fail '内置 MinIO 需要设置私有凭据。'
    [[ "$(env_value MINIO_ROOT_USER)" != GENERATE_ON_INSTALL && "$(env_value MINIO_ROOT_PASSWORD)" != GENERATE_ON_INSTALL ]] || fail '请先运行 init 生成 MinIO 凭据。'
  fi
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
  proxy_mode="${REVERSE_PROXY_MODE:-$(env_value REVERSE_PROXY_MODE)}"
  if [[ -z "$proxy_mode" ]]; then
    # A pre-v0.1.4 file describes the existing Caddy entrance; preserve it until explicitly migrated.
    if [[ -n "$(env_value SITE_ADDRESS)$(env_value HTTP_PORT)$(env_value HTTPS_PORT)" ]]; then
      proxy_mode=caddy
    elif [[ -n "$(env_value WEB_PORT)$(env_value API_PORT)" ]]; then
      proxy_mode=external
    else
      proxy_mode=gateway
    fi
  fi
  case "$proxy_mode" in
    gateway) proxy_override="$install_dir/compose.gateway.yaml" ;;
    caddy) proxy_override="$install_dir/compose.caddy.yaml" ;;
    external) proxy_override="" ;;
    *) fail 'REVERSE_PROXY_MODE 只能为 gateway、external 或 caddy。' ;;
  esac
  normalize_private_ports
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
    CONTEST_COMPOSE_OVERRIDE="$override" CONTEST_COMPOSE_PROXY="$proxy_override" \
    CONTEST_COMPOSE_PLATFORM="$platform_override" \
    CONTEST_COMPOSE_PROXY_PLATFORM="${proxy_override:+$proxy_platform_override}" \
    bash "$repo_root/scripts/backup.sh" "$destination"
}

start_services() {
  if [[ "$install_mode" == images ]]; then
    if ! compose pull; then
      printf '镜像拉取失败。请记录上方失败的镜像名；若出现 content descriptor / not found，请检查镜像代理是否完整同步，并参阅 deploy/README.md。\n' >&2
      return 1
    fi
    compose up -d --no-build --remove-orphans --wait --wait-timeout 240 || return
  else
    compose up -d --build --remove-orphans --wait --wait-timeout 240 || return
  fi
  compose ps
}

show_settings() {
  printf '\n配置文件：%s\n项目名称：%s\n安装方式：%s\n访问地址：%s\n' \
    "$install_env" "$(env_value COMPOSE_PROJECT_NAME)" "$install_mode" "$(env_value PUBLIC_URL)"
  if [[ "$install_mode" == images ]]; then printf '镜像版本：%s\n' "$(env_value IMAGE_TAG)"; fi
  if [[ "$proxy_mode" == gateway ]]; then printf '入口：内部 Caddy HTTP %s，公网 HTTPS 由自有反向代理提供。\n' "$(env_value GATEWAY_PORT)"; fi
  if [[ "$proxy_mode" == caddy ]]; then printf '入口：沿用已有 Caddy 配置；切换自配代理请参阅 README。\n'; fi
}
