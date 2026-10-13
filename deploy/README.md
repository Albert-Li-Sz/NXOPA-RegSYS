# 一键部署

V0.2.2 使用仓库根目录的单一入口 `install.sh`，支持安装、更新、卸载和日常维护。旧 `install` 目录不再使用；Compose 配置、示例及辅助函数放在 `deploy`，不需要逐个运行脚本。宿主机需要 Docker、Compose 2.24.4 以上、Bash、OpenSSL、curl 和 tar，无需 Node.js、pnpm、PostgreSQL 或 LaTeX。

## 首次安装

```bash
curl -fsSL https://raw.githubusercontent.com/Albert-Li-Sz/NXOPA-RegSYS/main/install.sh -o install.sh
bash install.sh
```

单文件入口自动下载最新稳定安装包并核对 `SHA256SUMS`，默认目录 `/opt/nxopa-regsys`。可以指定目录：

```bash
bash install.sh --dir /opt/my-registration
```

菜单提供安装、更新、卸载与状态；也可执行 `bash install.sh install`。向导选择项目名、镜像版本、Caddy 的本机端口与邮件链接的站点地址，生成随机数据库密码和 32 字节加密密钥，保存为权限 `600` 的 `deploy/.env`，启动后交互创建管理员。密码输入不显示，正式实例不创建演示账号。

从 Release 下载的 `nxopa-regsys-v0.2.2-install.tar.gz` 也可核验后解压，在解压目录运行 `bash install.sh`。发布安装包默认镜像模式。完整源码仓库还支持源码构建。

## 更新与卸载

```bash
bash /opt/nxopa-regsys/install.sh update
bash /opt/nxopa-regsys/install.sh uninstall
```

更新交互选择固定版本和备份目录，先生成加密备份，再更新镜像及所需安装材料、执行迁移并等待健康检查。下载、校验或备份失败会中止；启动失败保留原配置。已经执行的数据库迁移不自动回滚，降级前恢复升级前备份。

卸载默认只移除当前项目的容器和网络，保留所有数据卷，重新安装可恢复。永久删除必须准确输入 `DELETE 项目名`，只清理此项目的卷。配置和备份保留，旧备份解密需要原加密密钥。

已有 v0.1.x 实例在原安装包根目录运行新入口，或用 `--dir` 指向原根目录。单文件启动会先调用旧安装器备份，并将原 `install/.env` 复制到 `deploy/.env`；项目名、密钥和数据卷保持一致。不要为旧实例生成新密钥。既有 `external` 双上游或公网 `caddy` 模式继续保留。源码部署更新前先取得完整新版源码。

## 反向代理

默认官方 Caddy 提供 `127.0.0.1:8080` HTTP 单一入口，`/api/` 在内部转发到 API，其余请求转发到前端。不占用公网 80/443，不申请证书，PostgreSQL 5432 与 Redis 不映射宿主机端口。

`PUBLIC_URL` 仅用于邮件和邀请链接，支持 HTTP/HTTPS；不作为请求来源白名单，访问域名不必与它一致。域名、HTTPS、访问限制由自己的反向代理配置。登录后的写操作仍使用会话 CSRF 令牌。

```dotenv
PUBLIC_URL=https://reg.example.org
REVERSE_PROXY_MODE=gateway
GATEWAY_PORT=127.0.0.1:8080
ALLOW_PRIVATE_INTEGRATIONS=true
```

新安装默认允许内网 Hydro/DOMjudge；已有配置若明确为 `false`，按需改为 `true` 后重新启动。邮件、站点公网地址和 GitHub 登录设置可在管理中心保存。

外层 Nginx 将整个站点转发到 Caddy，完整示例为 [nginx.conf.example](nginx.conf.example)：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

宿主机 Nginx/OpenResty（或 host 网络容器）使用上述地址。bridge 网络代理容器加入项目 `edge` 网络，改为 `http://caddy:80`。保持内部入口回环绑定。Caddy 保留外层协议，API 的 Cookie 随实际 HTTP/HTTPS 设置。

## 维护命令

```bash
bash install.sh config
bash install.sh status
bash install.sh logs api worker
bash install.sh admin
bash install.sh backup /secure/backups
bash install.sh restore /secure/backups/backup.ccbak
bash install.sh restore-url https://reg.example.org
bash install.sh compose ps
```

多个实例用 `INSTALL_ENV_FILE=/absolute/path/.env` 选择配置。`init` 保留已有文件，`up` 按配置构建或拉取，`update --yes` 按已保存版本先备份再更新。不要公开 `.env` 或完整 `compose config`，其中包含密钥。

业务镜像为 `ghcr.io/albert-li-sz/nxopa-regsys-{api,worker,web,latex}:v0.2.2`，支持 amd64/arm64。PostgreSQL 17.6 和 Caddy 2.10.2 按 Docker 服务端架构固定官方运行摘要，避免不完整镜像代理要求索引中的证明配置。保持原数据库版本和卷名；`content descriptor ... not found` 时检查具体镜像及镜像代理，不能把拉取失败当成安装完成。

## 账号与报名

用户通过邮箱或 GitHub 登录。参赛前需要填写学号、姓名、班级、学院、性别；邮箱账号还需完成邮箱验证。系统管理员在“用户权限”编辑用户标签，支持按标签筛选用户和竞赛报名。

每场竞赛按首次成功提交生成从 1 开始的编号，草稿暂不编号。补正、重新提交或取消保留原编号；审核列表和 CSV 导出按编号从小到大展示。升级会为历史已提交记录按首次提交时间补齐编号，保留原 UUID。

GitHub 登录在“管理中心 → GitHub 登录”配置 OAuth App 的 Client ID、Client Secret 与回调地址。回调默认为当前域名的 `/api/v1/auth/github/callback`。密钥加密保存，不返回浏览器。同邮箱已有账号需先用本站密码登录后主动绑定；不会自动合并账号。只有已验证的 GitHub 邮箱可以创建账号。协议参考 [GitHub 官方流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) 和 [Auth.js GitHub provider](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/github.ts)。

可选环境初始值：`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_CALLBACK_URL`。后台保存后使用数据库设置。GitHub Enterprise 可同时配置 `GITHUB_OAUTH_BASE_URL` 和 `GITHUB_API_BASE_URL`，普通 GitHub 保留默认值。
