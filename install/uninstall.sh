#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=install/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

case "${1:-}" in
  -h|--help|help)
    printf '用法：bash install/uninstall.sh\n默认卸载容器并保留数据。删除数据卷须输入 DELETE 和项目名确认；配置及备份始终保留。\n'
    exit 0 ;;
  '') ;;
  *) fail '不支持命令参数。请执行 bash uninstall.sh，或使用 --help。' ;;
esac

printf '南晓开放原子社在线报名系统 · 交互卸载\n'
use_saved_environment
require_docker
require_config
show_settings
project="$(env_value COMPOSE_PROJECT_NAME)"
project="${project:-nxopa-regsys}"
choice=''
deletion=''
printf '\n1) 卸载容器和网络，保留所有数据卷（默认）\n2) 卸载容器和网络，并永久删除数据库、附件、缓存和证书数据卷\n'
while true; do
  ask choice '卸载方式' '1'
  case "$choice" in 1|2) break ;; *) printf '请选择 1 或 2。\n' >&2 ;; esac
done
if [[ "$choice" == 2 ]]; then
  printf '将永久删除项目 %s 的数据卷。\n' "$project"
  ask deletion "确认删除请输入 DELETE $project"
  if [[ "$deletion" != "DELETE $project" ]]; then printf '确认不匹配，已取消。\n'; exit 0; fi
else
  if ! confirm '卸载系统容器并保留数据卷' n; then printf '已取消。\n'; exit 0; fi
fi
if confirm '卸载前生成加密备份（服务须处于运行状态）' y; then
  ask destination '加密备份目录' "$install_dir/backups"
  backup "$(absolute_path "$destination")"
fi
if [[ "$choice" == 2 ]]; then
  compose down --volumes --remove-orphans
  # An external-proxy migration no longer declares the old certificate volumes.
  # Explicit permanent deletion covers all volumes owned by this Compose project.
  remaining_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  while IFS= read -r volume; do
    if [[ -n "$volume" ]]; then docker volume rm "$volume"; fi
  done <<< "$remaining_volumes"
else
  compose down --remove-orphans
fi
printf '\n卸载完成。配置文件 %s 和备份目录已保留，可用于重新安装或解密恢复。\n' "$install_env"
if [[ "$choice" == 1 ]]; then printf '数据卷已保留。重新运行 bash install.sh 可恢复启动。\n'; fi
