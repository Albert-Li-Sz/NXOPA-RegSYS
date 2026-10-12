#!/usr/bin/env bash
set -euo pipefail
umask 077

install_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$install_dir/.." && pwd)"
install_env="${INSTALL_ENV_FILE:-$install_dir/.env}"
case "$install_env" in
  /*) ;;
  *) install_env="$install_dir/$install_env" ;;
esac
export INSTALL_ENV_FILE="$install_env"
install_mode=source

usage() {
  cat <<'EOF'
南晓开放原子社在线报名系统 · Docker Compose 安装

用法：bash install/install.sh <命令>
  init                  生成独立 .env 和随机密钥，保留已有配置
  up                    按 INSTALL_MODE 构建或拉取镜像，迁移并等待服务就绪
  pull                  镜像模式下拉取配置的发布版本
  admin                 交互创建首次系统管理员
  config                检查配置（不打印密码）
  status                查看服务状态
  logs [服务名...]       查看最近 100 行并持续跟踪日志
  stop                  停止容器，保留数据
  down                  移除容器和网络，保留数据卷
  update                先备份，再按配置构建或拉取镜像并启动
  backup [目录]         加密备份，默认 install/backups
  restore <备份文件>     恢复数据库与私有文件
  restore-url <HTTPS地址> 恢复后台公网地址
  compose <参数...>      对安装实例执行其他 Docker Compose 命令

公网域名、HTTPS、SMTP 与平台配置说明见 install/README.md。
EOF
}

init_env() {
  if [[ -f "$install_env" ]]; then
    chmod 600 "$install_env"
    echo "保留已有配置：$install_env"
    return
  fi
  command -v openssl >/dev/null 2>&1 || {
    echo '缺少 openssl，请先安装后再生成配置。' >&2
    exit 1
  }
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
  echo "已生成配置：${install_env}（权限 600，密钥不在终端显示）"
  echo '本机可直接启动；公网部署先按 README 配置域名与 HTTPS。'
}

compose() {
  local compose_args=(--project-directory "$install_dir" --env-file "$install_env" -f "$install_dir/compose.yaml")
  if [[ "$install_mode" == images ]]; then compose_args+=(-f "$install_dir/compose.images.yaml"); fi
  docker compose "${compose_args[@]}" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo '未安装 Docker，请按 install/README.md 安装 Docker Engine / Desktop。' >&2
    exit 1
  }
  docker compose version >/dev/null 2>&1 || {
    echo '缺少 Docker Compose 插件，请按 install/README.md 安装。' >&2
    exit 1
  }
  docker info >/dev/null || {
    echo '无法连接 Docker，请启动 Docker 并检查当前账号的权限。' >&2
    exit 1
  }
}

require_config() {
  if [[ ! -f "$install_env" ]]; then
    echo '尚未生成配置，请先执行 bash install/install.sh init。' >&2
    exit 1
  fi
  local placeholders
  placeholders=$(awk '/^(ENCRYPTION_KEY|POSTGRES_PASSWORD)=GENERATE_ON_INSTALL$/ { print $1 }' "$install_env")
  if [[ -n "$placeholders" ]]; then
    echo '配置仍包含未生成的密钥。请使用 init 创建配置，或填写有效的随机密钥。' >&2
    exit 1
  fi
  install_mode="${INSTALL_MODE:-$(awk -F= '/^[[:space:]]*INSTALL_MODE[[:space:]]*=/ { value=$2; gsub(/^[[:space:]\047\042]+|[[:space:]\047\042]+$/, "", value); print value }' "$install_env" | tail -1)}"
  install_mode="${install_mode:-source}"
  case "$install_mode" in
    source|images) ;;
    *) echo 'INSTALL_MODE 只能为 source 或 images。' >&2; exit 1 ;;
  esac
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

action="${1:-help}"
if [[ $# -gt 0 ]]; then shift; fi
case "$action" in
  help|-h|--help) usage; exit 0 ;;
  init) init_env; exit 0 ;;
  up) init_env ;;
esac
case "$action" in
  up|pull|admin|config|status|logs|stop|down|update|backup|restore|restore-url|compose) ;;
  *) echo "未知命令：$action" >&2; usage; exit 2 ;;
esac
require_docker
require_config

case "$action" in
  up|update)
    if [[ "$action" == update ]]; then backup; fi
    if [[ "$install_mode" == images ]]; then
      compose pull
      compose up -d --no-build --wait --wait-timeout 240
    else
      compose up -d --build --wait --wait-timeout 240
    fi
    compose ps
    echo '服务已启动。首次安装请执行 bash install/install.sh admin 创建系统管理员。'
    ;;
  pull)
    if [[ "$install_mode" != images ]]; then
      echo '请先在 .env 中设置 INSTALL_MODE=images，再执行 pull。' >&2
      exit 1
    fi
    compose pull
    ;;
  admin)
    if [[ -n "${ADMIN_EMAIL:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
      export ADMIN_USERNAME="${ADMIN_USERNAME:-administrator}"
      compose exec -T -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_USERNAME api pnpm bootstrap:admin
    else
      compose exec api pnpm bootstrap:admin
    fi
    ;;
  config) echo 'Docker Compose 配置检查通过。' ;;
  status) compose ps -a ;;
  logs) compose logs --tail 100 -f "$@" ;;
  stop) compose stop ;;
  down) compose down ;;
  backup) backup "$@" ;;
  restore)
    input="${1:?请提供加密备份文件路径}"
    override=""
    if [[ "$install_mode" == images ]]; then override="$install_dir/compose.images.yaml"; fi
    CONTEST_COMPOSE_FILE="$install_dir/compose.yaml" CONTEST_ENV_FILE="$install_env" \
      CONTEST_COMPOSE_OVERRIDE="$override" \
      bash "$repo_root/scripts/restore.sh" "$(absolute_path "$input")"
    ;;
  restore-url)
    url="${1:?请提供 HTTPS 公网地址}"
    compose exec -T api pnpm restore:public-url "$url"
    ;;
  compose) compose "$@" ;;
esac
