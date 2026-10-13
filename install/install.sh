#!/usr/bin/env bash
set -euo pipefail
umask 077

# shellcheck source=install/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
南晓开放原子社在线报名系统 · Docker Compose 安装

用法：bash install/install.sh [命令]
  不带参数 / install    交互安装：地址、镜像版本、启动及首次管理员
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

交互升级：bash install/update.sh
交互卸载：bash install/uninstall.sh
公网域名、HTTPS、SMTP 与平台配置说明见 install/README.md。
EOF
}

interactive_admin() {
  local email username password repeated
  ask username '首次管理员用户名' 'administrator'
  [[ "$username" =~ ^[A-Za-z0-9_]{3,32}$ ]] || fail '用户名须为 3 至 32 位字母、数字或下划线。'
  while true; do
    ask email '首次管理员邮箱'
    if [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then break; fi
    printf '请填写有效邮箱。\n' >&2
  done
  while true; do
    printf '管理员密码（10 至 128 位，输入不显示）: ' >&2
    IFS= read -r -s password || fail '输入已结束，操作取消。'
    printf '\n确认管理员密码: ' >&2
    IFS= read -r -s repeated || fail '输入已结束，操作取消。'
    printf '\n' >&2
    if (( ${#password} < 10 || ${#password} > 128 )); then
      printf '密码长度须为 10 至 128 位。\n' >&2
    elif [[ "$password" != "$repeated" ]]; then
      printf '两次密码不一致，请重新输入。\n' >&2
    else
      break
    fi
  done
  ADMIN_EMAIL="$email" ADMIN_USERNAME="$username" ADMIN_PASSWORD="$password" \
    compose exec -T -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_USERNAME api pnpm bootstrap:admin
  unset password repeated
}

interactive_install() {
  local choice project tag public_url web_port api_port api_bind web_bind
  local existing=false admin_default=y
  printf '南晓开放原子社在线报名系统 · 交互安装\n'
  use_saved_environment
  require_docker
  if [[ -f "$install_env" ]]; then
    existing=true
    admin_default=n
    init_env
    require_config
    show_settings
    printf '已检测到配置，将沿用项目名称、访问地址及密钥。升级请使用 update.sh。\n'
    if ! confirm '按现有配置启动系统' y; then printf '已取消。\n'; return; fi
  else
    while true; do
      ask project 'Docker Compose 项目名称' 'nxopa-regsys'
      if [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then break; fi
      printf '项目名称须以小写字母或数字开头，仅含小写字母、数字、连字符和下划线。\n' >&2
    done
    if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || \
          -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
      fail '此项目已有容器或数据卷，请恢复原 .env，或选择新项目名称。'
    fi
    printf '\n1) 拉取发布镜像（推荐，无需在服务器编译）\n2) 从完整源码构建\n'
    while true; do
      ask choice '安装方式' '1'
      case "$choice" in
        1) install_mode=images; break ;;
        2)
          [[ -f "$repo_root/infra/Dockerfile" ]] || fail '源码模式需要完整仓库；当前安装包只支持发布镜像。'
          install_mode=source; break ;;
        *) printf '请选择 1 或 2。\n' >&2 ;;
      esac
    done
    tag="$(env_value IMAGE_TAG "$install_dir/.env.example")"
    if [[ "$install_mode" == images ]]; then ask_tag tag "$tag"; fi
    printf '\n默认不安装 Caddy。请自行配置反向代理：/api/ 转发 API，其余请求转发前端。\n'
    while true; do
      ask public_url '浏览器访问地址（HTTPS 域名，或本机 HTTP 地址）' 'http://localhost:8080'
      if [[ "$public_url" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ||
            "$public_url" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$ ]]; then
        local url_port="${public_url##*:}"
        if [[ "$url_port" =~ ^[0-9]+$ ]] && (( 10#$url_port < 1 || 10#$url_port > 65535 )); then
          printf '地址中的端口须为 1 至 65535。\n' >&2
        else
          break
        fi
      else
        printf '请填写根路径 HTTPS 地址，或 http://localhost:端口；不含路径、账号、查询或片段。\n' >&2
      fi
    done
    ask_port web_port '前端的本机上游端口' '8081'
    ask_port api_port 'API 的本机上游端口' '3000'
    [[ "$web_port" != "$api_port" ]] || fail '前端与 API 端口不能相同。'
    if [[ "$public_url" == "http://localhost:$web_port" || "$public_url" == "http://127.0.0.1:$web_port" ||
          "$public_url" == "http://localhost:$api_port" || "$public_url" == "http://127.0.0.1:$api_port" ]]; then
      fail '本机反向代理的访问端口须与两个上游端口不同。'
    fi
    printf '\n项目：%s\n安装方式：%s\n访问地址：%s\n' "$project" "$install_mode" "$public_url"
    if [[ "$install_mode" == images ]]; then printf '镜像版本：%s\n' "$tag"; fi
    if ! confirm '生成配置并开始安装' y; then printf '已取消。\n'; return; fi
    init_env
    set_env_value COMPOSE_PROJECT_NAME "$project"
    set_env_value INSTALL_MODE "$install_mode"
    set_env_value IMAGE_TAG "$tag"
    set_env_value PUBLIC_URL "$public_url"
    set_env_value REVERSE_PROXY_MODE external
    set_env_value WEB_PORT "127.0.0.1:$web_port"
    set_env_value API_PORT "127.0.0.1:$api_port"
    require_config
  fi
  start_services
  if [[ "$proxy_mode" == external ]]; then
    api_bind="$(env_value API_PORT)"; web_bind="$(env_value WEB_PORT)"
    printf '\n请配置自有反向代理：/api/ → http://%s（保留 /api/ 路径）；其余请求 → http://%s。\n示例：%s/nginx.conf.example；仅健康检查通过不表示反向代理已就绪。\n' \
      "${api_bind:-127.0.0.1:3000}" "${web_bind:-127.0.0.1:8081}" "$install_dir"
  fi
  printf '\n服务健康检查通过。配置的访问地址：%s\n' "$(env_value PUBLIC_URL)"
  if confirm '现在创建首次系统管理员（已有管理员时请选择 n）' "$admin_default"; then interactive_admin; fi
  if [[ "$existing" == false ]]; then printf '首次登录后，请在管理中心配置邮件服务，再开放公开注册。\n'; fi
  printf '安装完成。日志：bash %s/install.sh logs\n' "$install_dir"
}

action="${1:-install}"
if [[ $# -gt 0 ]]; then shift; fi
case "$action" in
  help|-h|--help) usage; exit 0 ;;
  install) interactive_install; exit 0 ;;
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
    start_services
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
    proxy_override=""
    if [[ "$install_mode" == images ]]; then override="$install_dir/compose.images.yaml"; fi
    if [[ "$proxy_mode" == caddy ]]; then proxy_override="$install_dir/compose.caddy.yaml"; fi
    CONTEST_COMPOSE_FILE="$install_dir/compose.yaml" CONTEST_ENV_FILE="$install_env" \
      CONTEST_COMPOSE_OVERRIDE="$override" CONTEST_COMPOSE_PROXY="$proxy_override" \
      CONTEST_COMPOSE_PLATFORM="$platform_override" \
      bash "$repo_root/scripts/restore.sh" "$(absolute_path "$input")"
    ;;
  restore-url)
    url="${1:?请提供 HTTPS 公网地址}"
    compose exec -T api pnpm restore:public-url "$url"
    ;;
  compose) compose "$@" ;;
esac
