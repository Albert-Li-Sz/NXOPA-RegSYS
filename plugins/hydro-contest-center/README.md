# Hydro Contest Center bridge

适用于 Hydro 5.0.7。安装本插件包，将 `hydro-contest-center` 加入 Hydro addon.json，设置 `CONTEST_CENTER_TOKEN`（至少 32 字符）及 `CONTEST_CENTER_DOMAINS`（默认 system，多个域使用逗号分隔），然后重启 Hydro。

Bearer 认证路由为 `/contest-center/v1/probe`、`/provision`、`/result`。通过 Hydro 模型创建独立比赛账号、加入允许域和指定比赛，并对源实例与报名关联再次核验。插件不共享本站密码，也不包含本地测试比赛创建功能。

完整配置和独立实例验收见 Contest Center 源码的 `docs/INTEGRATIONS.md`。
