#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=install/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

case "${1:-}" in
  -h|--help|help)
    printf '用法：bash install/update.sh\n交互选择镜像版本，先加密备份，再升级并等待健康检查。源码模式更新前须取得新版完整源码。\n'
    exit 0 ;;
  '') ;;
  *) fail '不支持命令参数。请执行 bash update.sh，或使用 --help。' ;;
esac

printf '南晓开放原子社在线报名系统 · 交互更新\n'
use_saved_environment
require_docker
require_config
show_settings
target_tag="$(env_value IMAGE_TAG)"
if [[ "$install_mode" == images ]]; then
  ask_tag target_tag "${target_tag:-$(env_value IMAGE_TAG "$install_dir/.env.example")}"
else
  printf '本次将构建当前目录的源码。请先取得新版完整源码并保留原 .env。\n'
fi
ask destination '加密备份目录' "$install_dir/backups"
destination="$(absolute_path "$destination")"
if ! confirm '先备份，再更新系统（升级期间服务可能短暂中断）' n; then printf '已取消。\n'; exit 0; fi

# Keep the prior tag and secrets recoverable even when pulling or starting the new version fails.
previous_config="$(mktemp "$install_env.before-update.XXXXXX")"
cp "$install_env" "$previous_config"
chmod 600 "$previous_config"
update_complete=false
finish_update() {
  if [[ "$update_complete" == false ]]; then
    cp "$previous_config" "$install_env"
    chmod 600 "$install_env"
    printf '更新未完成，原安装配置已保留。备份目录：%s\n如数据库迁移已经执行，请先使用 install.sh restore 恢复升级前备份，再启动旧版。\n' "$destination" >&2
  fi
  rm -f "$previous_config"
}
trap finish_update EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup "$destination"
if [[ "$install_mode" == images ]]; then set_env_value IMAGE_TAG "$target_tag"; fi
require_config
start_services
update_complete=true
printf '\n更新完成，健康检查通过。访问地址：%s\n备份目录：%s\n' "$(env_value PUBLIC_URL)" "$destination"
