#!/usr/bin/env bash
set -euo pipefail
umask 077
NXOPA_INSTALLER_VERSION=v0.3.1

usage() {
  cat <<'EOF'
NXOPA-RegSYS · 一键安装、更新与卸载
用法：bash install.sh [--dir 安装目录] [--github-prefix 加速前缀] [命令]
  不带参数       交互选择安装、更新、卸载或查看状态
  install        交互安装，默认使用发布镜像和本机 Caddy 8080
  update         先加密备份，再更新镜像与安装材料；--yes 按已保存配置执行
  uninstall      卸载；默认保留数据，永久删除须输入项目名确认
  init/up/admin/config/status/logs/stop/down/pull
  backup [目录] / restore <文件> / restore-url <地址>
  compose <参数> 对当前实例执行 Docker Compose 命令

单文件安装：curl -fsSL https://raw.githubusercontent.com/Albert-Li-Sz/NXOPA-RegSYS/main/install.sh -o install.sh
            bash install.sh
默认下载到 /opt/nxopa-regsys；可用 --dir 选择其他目录。
EOF
}
github_url() {
  local prefix="${NXOPA_GITHUB_PREFIX:-}"
  if [[ -n "$prefix" && ! "$prefix" =~ ^https?://[A-Za-z0-9._:-]+(/[A-Za-z0-9/_-]*)?/?$ ]]; then
    echo 'GitHub 加速前缀格式无效，请填写不含账号、查询或片段的 HTTP(S) 前缀。' >&2; return 1
  fi
  if [[ -n "$prefix" ]]; then printf '%s/%s\n' "${prefix%/}" "$1"; else printf '%s\n' "$1"; fi
}

fetch_bundle() {
  local tag="$1" output="$2" repository="${NXOPA_REPOSITORY:-Albert-Li-Sz/NXOPA-RegSYS}"
  local base="${NXOPA_RELEASE_BASE_URL:-https://github.com/$repository/releases/download}" name="nxopa-regsys-$tag-install.tar.gz" expected actual entry
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '版本标签无效。' >&2; return 1; }
  command -v curl >/dev/null || { echo '缺少 curl。' >&2; return 1; }
  command -v openssl >/dev/null || { echo '缺少 openssl。' >&2; return 1; }
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "$(github_url "$base/$tag/$name")" -o "$output/$name" || return
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 "$(github_url "$base/$tag/SHA256SUMS")" -o "$output/SHA256SUMS" || return
  expected="$(awk -v name="$name" '$2==name {print $1}' "$output/SHA256SUMS")"
  actual="$(openssl dgst -sha256 "$output/$name" | awk '{print $NF}')"
  [[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] || { echo '安装包 SHA-256 校验失败。' >&2; return 1; }
  # Reject links and paths leaving the archive root before any extraction occurs.
  if tar -tvzf "$output/$name" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit !bad}'; then
    echo '安装包包含不支持的链接。' >&2; return 1
  fi
  while IFS= read -r entry; do
    case "$entry" in "nxopa-regsys-$tag/"*) ;; *) echo '安装包路径无效。' >&2; return 1 ;; esac
    case "/$entry/" in */../*|*/./*) echo '安装包路径无效。' >&2; return 1 ;; esac
  done < <(tar -tzf "$output/$name")
  tar -xzf "$output/$name" -C "$output"
  [[ -f "$output/nxopa-regsys-$tag/install.sh" && -f "$output/nxopa-regsys-$tag/deploy/lib.sh" ]] || { echo '发布包不支持新版一键入口。' >&2; return 1; }
}

copy_bundle() {
  local source="$1" destination="$2" file relative
  mkdir -p "$destination"
  # Release archives contain a whitelist and no real .env. Existing credentials remain intact.
  while IFS= read -r file; do
    relative="${file#"$source/"}"
    case "$relative" in deploy/.env|*/backups/*|*/.env) echo '拒绝覆盖实例配置。' >&2; return 1 ;; esac
    mkdir -p "$(dirname "$destination/$relative")"
    cp -p "$file" "$destination/$relative"
  done < <(find "$source" -type f)
  if [[ ! -f "$destination/deploy/.env" && -f "$destination/install/.env" ]]; then
    cp "$destination/install/.env" "$destination/deploy/.env"
    chmod 600 "$destination/deploy/.env"
    printf '已保留旧实例的项目名与密钥，配置迁移到 deploy/.env。\n'
  fi
}

latest_tag() {
  local repository="${NXOPA_REPOSITORY:-Albert-Li-Sz/NXOPA-RegSYS}" discovered location
  discovered="$(curl -fsSL --connect-timeout 10 --max-time 15 "$(github_url "https://api.github.com/repos/$repository/releases/latest")" 2>/dev/null | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"(v[0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' | head -1)" || true
  if [[ -n "$discovered" ]]; then printf '%s\n' "$discovered"; return; fi
  # Some release accelerators support github.com but do not proxy the API domain.
  location="$(curl -fsSLI --connect-timeout 10 --max-time 15 -o /dev/null -w '%{url_effective}' "$(github_url "https://github.com/$repository/releases/latest")" 2>/dev/null)" || return
  if [[ "$location" =~ /releases/tag/(v[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then printf '%s\n' "${BASH_REMATCH[1]}"; fi
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
  local choice project tag public_url gateway_port api_bind web_bind gateway_bind storage_choice storage_mode s3_endpoint s3_region s3_bucket s3_access_key s3_secret github_prefix
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
    printf '已检测到配置，将沿用项目名称、访问地址及密钥。升级请使用 ../install.sh update。\n'
    if ! confirm '按现有配置启动系统' y; then printf '已取消。\n'; return; fi
  else
    while true; do
      ask project 'Docker Compose 项目名称' 'nxopa-regsys'
      if [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then break; fi
      printf '项目名称须以小写字母或数字开头，仅含小写字母、数字、连字符和下划线。\n' >&2
    done
    ask github_prefix 'GitHub 加速前缀（例如 https://gh-proxy.org/，留空直连）' "${NXOPA_GITHUB_PREFIX:-}"
    export NXOPA_GITHUB_PREFIX="$github_prefix"
    github_url https://github.com >/dev/null || fail 'GitHub 加速前缀无效。'
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
    printf '\n1) 内置 MinIO（推荐，文件集中存储）\n2) 第三方 S3 兼容存储\n3) 本地存储（保留兼容）\n'
    while true; do
      ask storage_choice '文件存储方式' 1
      case "$storage_choice" in
        1) storage_mode=MINIO; break ;;
        2)
          storage_mode=S3
          ask s3_endpoint 'S3 端点（完整 HTTP / HTTPS 地址）'
          [[ "$s3_endpoint" =~ ^https?://[^[:space:]@?#]+$ ]] || fail 'S3 端点无效。'
          ask s3_region 'S3 区域' us-east-1
          ask s3_bucket 'S3 桶名称'
          [[ "$s3_bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail 'S3 桶名无效。'
          ask s3_access_key 'S3 Access Key ID'
          [[ "$s3_access_key" =~ ^[A-Za-z0-9_/-]+$ ]] || fail 'Access Key ID 无效。'
          printf 'S3 Secret Access Key（输入不显示）: ' >&2
          IFS= read -r -s s3_secret || fail '输入已结束。'; printf '\n' >&2
          [[ "$s3_secret" =~ ^[A-Za-z0-9_+/=-]+$ ]] || fail 'Secret Access Key 格式无效。'
          break ;;
        3) storage_mode=LOCAL; break ;;
        *) printf '请选择 1、2 或 3。\n' >&2 ;;
      esac
    done
    printf '\n内部 Caddy 提供统一 HTTP 入口。公网域名和 HTTPS 由您自己的反向代理配置，整个站点转发到此入口。\n'
    ask_port gateway_port 'Caddy 的本机 HTTP 入口端口' '8080'
    while true; do
      ask public_url '邮件与邀请链接的站点地址（HTTP / HTTPS，不参与来源限制）' "http://localhost:$gateway_port"
      if [[ "$public_url" =~ ^https?://[^[:space:]/?#@]+/?$ ]]; then
        local url_port="${public_url##*:}"
        if [[ "$url_port" =~ ^[0-9]+$ ]] && (( 10#$url_port < 1 || 10#$url_port > 65535 )); then
          printf '地址中的端口须为 1 至 65535。\n' >&2
        else
          break
        fi
      else
        printf '请填写 HTTP / HTTPS 根地址，不含账号、查询或片段。\n' >&2
      fi
    done
    printf '\n项目：%s\n安装方式：%s\n访问地址：%s\n' "$project" "$install_mode" "$public_url"
    if [[ "$install_mode" == images ]]; then printf '镜像版本：%s\n' "$tag"; fi
    if ! confirm '生成配置并开始安装' y; then printf '已取消。\n'; return; fi
    init_env
    set_env_value COMPOSE_PROJECT_NAME "$project"
    set_env_value INSTALL_MODE "$install_mode"
    set_env_value IMAGE_TAG "$tag"
    set_env_value PUBLIC_URL "$public_url"
    set_env_value NXOPA_GITHUB_PREFIX "$github_prefix"
    set_env_value STORAGE_MODE "$storage_mode"
    if [[ "$storage_mode" == S3 ]]; then
      set_env_value S3_ENDPOINT "$s3_endpoint"; set_env_value S3_REGION "$s3_region"; set_env_value S3_BUCKET "$s3_bucket"
      set_env_value S3_ACCESS_KEY "$s3_access_key"; set_env_value S3_SECRET_KEY "$s3_secret"
      unset s3_secret
    fi
    set_env_value REVERSE_PROXY_MODE gateway
    set_env_value GATEWAY_PORT "127.0.0.1:$gateway_port"
    require_config
  fi
  start_services
  if [[ "$proxy_mode" == gateway ]]; then
    gateway_bind="$(env_value GATEWAY_PORT)"
    printf '\n请将自有反向代理的整个站点转发到 http://%s，并传递 Host 和 X-Forwarded-Proto。\n示例：%s/nginx.conf.example；本机可直接访问该 HTTP 入口，公网需完成域名与 HTTPS 配置。\n' \
      "${gateway_bind:-127.0.0.1:8080}" "$install_dir"
  elif [[ "$proxy_mode" == external ]]; then
    api_bind="$(env_value API_PORT)"; web_bind="$(env_value WEB_PORT)"
    printf '\n请配置自有反向代理：/api/ → http://%s（保留 /api/ 路径）；其余请求 → http://%s。\n示例：%s/nginx.conf.example；仅健康检查通过不表示反向代理已就绪。\n' \
      "${api_bind:-127.0.0.1:3000}" "${web_bind:-127.0.0.1:8081}" "$install_dir"
  fi
  printf '\n服务健康检查通过。配置的访问地址：%s\n' "$(env_value PUBLIC_URL)"
  if confirm '现在创建首次系统管理员（已有管理员时请选择 n）' "$admin_default"; then interactive_admin; fi
  if [[ "$existing" == false ]]; then printf '首次登录后，请在管理中心配置邮件服务，再开放公开注册。\n'; fi
  printf '安装完成。日志：bash %s/../install.sh logs\n' "$install_dir"
}

interactive_update() {
  local target_tag destination previous_config
  use_saved_environment
  require_docker
  require_config
  show_settings
  target_tag="${NXOPA_UPDATE_TAG:-$NXOPA_INSTALLER_VERSION}"
  if [[ "$install_mode" == images && ! -d "$repo_root/.git" && "${NXOPA_SKIP_RELEASE_DOWNLOAD:-}" != 1 && "${NXOPA_UPDATE_RESUME:-}" != 1 ]]; then
    target_tag="${NXOPA_UPDATE_TAG:-$(latest_tag || true)}"
    target_tag="${target_tag:-$NXOPA_INSTALLER_VERSION}"
  fi
  if [[ "${1:-}" == --yes ]]; then
    target_tag="${NXOPA_UPDATE_TAG:-$(env_value IMAGE_TAG)}"
    destination="${NXOPA_BACKUP_DIR:-$install_dir/backups}"
    backup "$destination"
  elif [[ "${NXOPA_UPDATE_RESUME:-}" != 1 ]]; then
    if [[ "$install_mode" == images ]]; then ask_tag target_tag "$target_tag"; fi
    ask destination '加密备份目录' "$install_dir/backups"
    destination="$(absolute_path "$destination")"
    if ! confirm '先备份，再更新系统' n; then printf '已取消。\n'; return; fi
    backup "$destination"
  else
    destination="${NXOPA_BACKUP_DIR:-$install_dir/backups}"
  fi
  if [[ "$install_mode" == images && "$target_tag" != "$NXOPA_INSTALLER_VERSION" && "${NXOPA_SKIP_RELEASE_DOWNLOAD:-}" != 1 ]]; then
    local staged
    staged="$(mktemp -d "${TMPDIR:-/tmp}/nxopa-release.XXXXXX")"
    if ! fetch_bundle "$target_tag" "$staged"; then rm -rf "$staged"; fail '新版材料下载失败，原配置与服务保持可用。'; fi
    copy_bundle "$staged/nxopa-regsys-$target_tag" "$repo_root"
    # Execute the immutable staged script, rather than overwrite a live Bash input stream.
    export NXOPA_ROOT="$repo_root" NXOPA_UPDATE_TAG="$target_tag" NXOPA_UPDATE_RESUME=1 NXOPA_BACKUP_DIR="$destination" NXOPA_TEMP_STAGE="$staged"
    exec bash "$staged/nxopa-regsys-$target_tag/install.sh" update
  fi
  previous_config="$(mktemp "$install_env.before-update.XXXXXX")"
  cp "$install_env" "$previous_config"
  if [[ "$install_mode" == images ]]; then set_env_value IMAGE_TAG "$target_tag"; fi
  if ! require_config || ! start_services; then
    cp "$previous_config" "$install_env"; chmod 600 "$install_env"; rm -f "$previous_config"
    fail '更新未完成，原配置已保留。若迁移已执行，降级前请恢复升级前备份。'
  fi
  rm -f "$previous_config"
  printf '更新完成。访问地址：%s\n备份目录：%s\n' "$(env_value PUBLIC_URL)" "$destination"
}

interactive_uninstall() {
  local choice project deletion destination remaining_volumes volume
  use_saved_environment
  require_docker
  require_config
  show_settings
  project="$(env_value COMPOSE_PROJECT_NAME)"; project="${project:-nxopa-regsys}"
  printf '1) 卸载容器，保留数据（默认）\n2) 永久删除当前项目的数据卷\n'
  while true; do ask choice '卸载方式' 1; case "$choice" in 1|2) break ;; *) printf '请选择 1 或 2。\n' ;; esac; done
  if [[ "$choice" == 2 ]]; then
    ask deletion "确认删除请输入 DELETE $project"
    if [[ "$deletion" != "DELETE $project" ]]; then printf '确认不匹配，已取消。\n'; return; fi
  elif ! confirm '卸载容器并保留数据' n; then printf '已取消。\n'; return
  fi
  if confirm '卸载前生成加密备份' y; then
    ask destination '加密备份目录' "$install_dir/backups"
    backup "$(absolute_path "$destination")"
  fi
  if [[ "$choice" == 2 ]]; then
    compose down --volumes --remove-orphans
    remaining_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
    while IFS= read -r volume; do if [[ -n "$volume" ]]; then docker volume rm "$volume"; fi; done <<< "$remaining_volumes"
  else compose down --remove-orphans; fi
  printf '卸载完成。配置与备份保留：%s\n' "$install_env"
}

main() {
  local script_root action target_root staged initial_tag material_tag
  script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [[ "${1:-}" == --dir || "${1:-}" == --github-prefix ]]; do
    if [[ "$1" == --github-prefix ]]; then
      export NXOPA_GITHUB_PREFIX="${2:?加速前缀缺失}"
      github_url https://github.com >/dev/null || exit 1
      shift 2; continue
    fi
    case "${2:?安装目录缺失}" in /*) NXOPA_ROOT="$2" ;; *) NXOPA_ROOT="$PWD/$2" ;; esac
    [[ "$NXOPA_ROOT" != / ]] || { echo '不能使用根目录作为安装目录。' >&2; exit 1; }
    export NXOPA_ROOT; shift 2
  done
  action="${1:-}"
  case "$action" in help|-h|--help) usage; exit 0 ;; esac
  target_root="${NXOPA_ROOT:-$script_root}"
  if [[ -z "${NXOPA_GITHUB_PREFIX+x}" && -f "$target_root/deploy/.env" ]]; then
    NXOPA_GITHUB_PREFIX="$(awk -F= '$1=="NXOPA_GITHUB_PREFIX" {sub(/^[^=]*=/, ""); print; exit}' "$target_root/deploy/.env")"; export NXOPA_GITHUB_PREFIX
  fi
  material_tag="$(awk -F= '$1=="IMAGE_TAG" {print $2; exit}' "$target_root/deploy/.env.example" 2>/dev/null || true)"
  if [[ ! -f "$target_root/deploy/lib.sh" || ( "$material_tag" != "$NXOPA_INSTALLER_VERSION" && "${NXOPA_SKIP_RELEASE_DOWNLOAD:-}" != 1 ) ]]; then
    target_root="${NXOPA_ROOT:-${NXOPA_INSTALL_DIR:-/opt/nxopa-regsys}}"
    if [[ -z "${NXOPA_GITHUB_PREFIX+x}" && -z "${NXOPA_RELEASE_BASE_URL:-}" ]]; then
      printf 'GitHub 加速前缀（如 https://gh-proxy.org/，留空直连）: ' >&2
      IFS= read -r NXOPA_GITHUB_PREFIX || { echo '输入已结束。' >&2; exit 1; }
      export NXOPA_GITHUB_PREFIX
      github_url https://github.com >/dev/null || exit 1
    fi
    [[ "$target_root" != / && "$target_root" == /* ]] || { echo '安装目录须为非根目录的绝对路径。' >&2; exit 1; }
    staged="$(mktemp -d "${TMPDIR:-/tmp}/nxopa-release.XXXXXX")"
    initial_tag="${NXOPA_VERSION:-$(latest_tag || true)}"
    initial_tag="${initial_tag:-$NXOPA_INSTALLER_VERSION}"
    if ! fetch_bundle "$initial_tag" "$staged"; then rm -rf "$staged"; exit 1; fi
    if [[ -f "$target_root/install.sh" && -f "$target_root/deploy/.env" ]]; then
      bash "$target_root/install.sh" backup "$target_root/backups"
    elif [[ -f "$target_root/install/install.sh" && -f "$target_root/install/.env" ]]; then
      INSTALL_ENV_FILE="$target_root/install/.env" bash "$target_root/install/install.sh" backup "$target_root/backups"
    fi
    copy_bundle "$staged/nxopa-regsys-$initial_tag" "$target_root"
    export NXOPA_ROOT="$target_root" NXOPA_TEMP_STAGE="$staged"
    exec bash "$staged/nxopa-regsys-$initial_tag/install.sh" "$@"
  fi
  export NXOPA_ROOT="$target_root"
  # shellcheck source=deploy/lib.sh
  source "$target_root/deploy/lib.sh"
  if [[ -n "${NXOPA_TEMP_STAGE:-}" ]]; then trap 'case "$NXOPA_TEMP_STAGE" in "${TMPDIR:-/tmp}/nxopa-release."*) rm -rf -- "$NXOPA_TEMP_STAGE" ;; esac' EXIT; fi
  if [[ -z "$action" ]]; then
    printf '1) 安装 / 启动\n2) 更新\n3) 卸载\n4) 状态\n0) 退出\n'
    local menu
    ask menu '请选择操作' 1
    case "$menu" in 1) action=install ;; 2) action=update ;; 3) action=uninstall ;; 4) action=status ;; 0) exit 0 ;; *) fail '选择无效。' ;; esac
  else shift; fi
  case "$action" in
    install) interactive_install; exit 0 ;;
    update) interactive_update "$@"; exit 0 ;;
    uninstall) interactive_uninstall; exit 0 ;;
    init) init_env; exit 0 ;;
    up) init_env ;;
  esac
  case "$action" in up|pull|admin|config|status|logs|stop|down|backup|restore|restore-url|compose) ;; *) usage; exit 2 ;; esac
  require_docker
  require_config
case "$action" in
  up)
    start_services
    echo '服务已启动。首次安装请执行 bash install.sh admin 创建系统管理员。'
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
      CONTEST_COMPOSE_OVERRIDE="$override" CONTEST_COMPOSE_PROXY="$proxy_override" \
      CONTEST_COMPOSE_PLATFORM="$platform_override" \
      CONTEST_COMPOSE_PROXY_PLATFORM="${proxy_override:+$proxy_platform_override}" \
      bash "$repo_root/scripts/restore.sh" "$(absolute_path "$input")"
    ;;
  restore-url)
    url="${1:?请提供 HTTPS 公网地址}"
    compose exec -T api pnpm restore:public-url "$url"
    ;;
  compose) compose "$@" ;;
esac

exit 0
}
main "$@"
