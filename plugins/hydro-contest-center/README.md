# Hydro Contest Center 插件 0.2.1

适配 Hydro 5.0.7。安装包仅包含 TypeScript 源码、说明、package.json 与 MIT 许可证，不含测试服务、环境文件或凭据。

[安装包、SHA-256 和图文教程](https://albert-li-sz.github.io/NXOPA-RegSYS/#hydro-plugin)

1. 下载对应 `.tgz` 与 `.sha256`，使用 `sha256sum -c`（macOS 使用 `shasum -a 256`）核验。
2. 以 Hydro 运行用户安装到 Hydro 的 Node.js 工作目录：`npm install --prefix /opt/hydro hydro-contest-center-0.2.1.tgz`。
3. 在该用户实际使用的 `~/.hydro/addon.json` 保留原插件并添加 `/opt/hydro/node_modules/hydro-contest-center`。
4. 配置 Hydro 进程环境变量 `CONTEST_CENTER_TOKEN`（至少 32 位随机密钥）和 `CONTEST_CENTER_DOMAINS`（逗号分隔允许域，默认 system）。systemd 使用 EnvironmentFile；PM2 更新环境后带 `--update-env` 重启；Docker 将变量放入容器环境并重建服务。
5. 在报名系统的管理员页面配置同一 Token、Hydro 基址、域与目标比赛 24 位 ID。先探测，再取得参赛资格并同步，最后实际登录目标比赛验收。

## 能力与路由

所有桥接路由要求 Bearer Token，限制域白名单。

- `GET /contest-center/v1/probe` 返回 Hydro 版本、插件版本及 provision/query/nickname/unofficial/contest_linkage 能力。
- `POST /contest-center/v1/provision` 创建或复用独立比赛账号，加入目标域及比赛。团队队名或个人姓名写入域 `displayName`；`unrank` 写入该比赛的参赛记录。
- `POST /contest-center/v1/result` 校验密码、源系统与报名标识、比赛关联、域昵称及非正式状态。

请求包含 `domainId`、`contestId`、`username`、`password`、`envelope`、可选 `nickname` 与布尔 `unrank`。来源标识不匹配时拒绝覆盖。用户名使用系统分配的 `cc_` 标识；重复请求复用账号和参赛记录。密码不会返回探测结果或记录日志。

## 更新说明

0.2.0 增加域昵称、比赛 unrank、完整读回验证和插件能力探测。报名系统拒绝缺少相关能力的旧插件。保持旧用户名及来源映射，不重新创建已有用户。

Hydro 昵称显示仍受原平台的私人资料权限控制；不能为展示昵称给所有用户开放私人资料权限。本站资格撤销不会自动停用远端账号，需要远端管理员按竞赛规则处理。

0.2.1 严格校验布尔字段，拒绝把字符串 `"false"` 或其他非布尔值作为非正式参赛标记，避免同步时意外改变比赛排名性质。保留 0.2.0 的能力与接口。
