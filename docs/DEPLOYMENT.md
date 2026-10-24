# 部署与维护

v1.0.0 使用 [一键安装入口](../deploy/README.md)，宿主机需要 Docker、Compose 2.24.4 以上、Bash、curl、tar 与 OpenSSL，无需安装 Node.js、pnpm、数据库或 LaTeX。安装使用五类服务的固定版本镜像，支持 amd64 和 arm64；PostgreSQL、Redis 与 Caddy 使用官方固定版本镜像。

本版按全新部署使用。已有 v0.x 实例先独立备份数据库、附件和原加密密钥，再使用新的安装目录、Compose 项目名和数据卷安装；不提供旧平台账号、已移除接口或历史报名的兼容适配，不将旧备份直接恢复到新实例。

## 安装与配置

```bash
curl --proto '=https' --proto-redir '=https' -fsSL https://raw.githubusercontent.com/Albert-Li-Sz/NXOPA-RegSYS/v1.0.0/install.sh -o install.sh
bash install.sh
```

单文件入口下载发布安装包并校验 `SHA256SUMS`。也可直接解压 Release 的安装包，在其根目录运行 `bash install.sh`。向导保存权限为 600 的 `deploy/.env`，生成数据库密码与 32 字节 `ENCRYPTION_KEY`，启动服务并初始化管理员。正式实例不会创建演示账号。

| 配置                                  | 用途                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `COMPOSE_PROJECT_NAME`                | 当前实例的容器与数据卷前缀，建立后保持不变。           |
| `PUBLIC_URL`                          | 浏览器访问的站点根地址，也是邮件与邀请链接的初始地址。 |
| `GATEWAY_PORT`                        | 内部 Caddy 的本机 HTTP 端口，默认 8080。               |
| `IMAGE_TAG`                           | 完整版本号，本版为 `v1.0.0`，不用浮动标签。            |
| `POSTGRES_PASSWORD`、`ENCRYPTION_KEY` | 随机生成并在同一实例维护时保留；不要公开配置内容。     |
| `STORAGE_MODE`                        | 新安装默认内置 MinIO，也可选择本地或第三方 S3。        |
| `TRUSTED_MANAGEMENT_ORIGINS`          | 可选的额外浏览器来源；也可在后台站点设置维护。         |

`ENCRYPTION_KEY` 用于邮件密码、独立比赛凭据、幂等结果和备份等数据的加密。备份与密钥分开保存，同一实例恢复时使用原密钥。

## 入口与管理员

默认内部 Caddy 仅在 `127.0.0.1:8080` 提供统一 HTTP 入口，自有反向代理负责公网 HTTPS，并将整个站点转发至内部入口。保留 Host、Origin 和原始协议。数据库、队列、Worker 与 LaTeX Runner 不开放公网端口；模板编译容器无网络访问。

```bash
curl --fail http://127.0.0.1:8080/api/v1/health
bash install.sh status
```

确认健康接口后，通过实际浏览器完成登录、刷新、报名、文件预览与准考证下载。站点公网地址、SMTP、文件存储、GitHub 与飞书登录在管理中心维护。正式开放注册前配置并测试邮件，确认收件箱实际收到测试邮件。

报名可以保存草稿，提交及补正重提要求本人或队长已通过实名审核且单位完整。管理员不能审批自己的实名资料；需要另一位有实名审核权限的管理员处理。团队允许成员来自不同单位，代表单位取队长审核通过的实名资料。

## 报名导出与准考证

“报名管理 → 导出名单”可选择 Excel 或 CSV，按当前完整筛选结果导出，每名选手一行。财务列另需财务权限，账号密码默认不导出。活动可选生成独立比赛账号，默认关闭；开启后为合格报名生成账号，密码稳定并默认放在准考证上。

准考证按跨页勾选或完整筛选范围处理。先生成 PDF，由管理员检查后再批量发放。任务展示逐条成功、跳过与失败结果；资料、资格或模板变化后旧文档失效。ZIP 超过容量时自动分包，临时下载包 24 小时后失效。

详情见 [报名导出与比赛账号](REGISTRATION_EXPORTS.md)、[准考证说明](ADMISSIONS.md) 和 [验收记录](REGISTRATION_EXPORTS_ACCEPTANCE.md)。

## 加密备份与恢复

在实际安装目录执行：

```bash
bash install.sh backup /srv/contest-backups
bash install.sh restore /srv/contest-backups/contest-center-YYYYMMDDTHHMMSSZ.ccbak --yes
```

备份暂停业务服务，保存数据库、部署配置、本地文件与数据库引用的 S3 对象，并使用原实例密钥加密。附件、准考证和批量 ZIP 均纳入对象备份。备份文件权限为 600。恢复前校验归档与对象摘要并建立恢复前快照；恢复失败保持业务服务停止。

S3 对象恢复为本地副本，避免依赖原存储端点；恢复后检查公网地址、邮件和存储，再按需迁移文件。不要丢弃原 `ENCRYPTION_KEY`，也不要将备份用于不同版本的数据结构。

## v1.x 维护与卸载

```bash
bash install.sh update
bash install.sh uninstall
```

维护更新先加密备份，再下载并验证材料、更新服务、执行迁移及健康检查。下载或备份失败会中止；已经执行的数据库迁移不自动回滚，回退时需要当前实例的原配置、密钥和备份。

默认卸载保留数据卷，重新安装可以继续使用同一 v1.x 实例；只有准确输入 `DELETE 项目名` 后才永久删除该项目的卷。配置与备份保留。多实例部署时使用不同的目录、Compose 项目名与本机端口。

## 验收与排障

隔离镜像验收使用：

```bash
INSTALL_TEST_MODE=images IMAGE_TAG=v1.0.0 pnpm test:install
INTERACTIVE_INSTALL_FROM=v1.0.0 INTERACTIVE_INSTALL_TO=v1.0.0 pnpm test:install-interactive
IMAGE_TAG=v1.0.0 pnpm test:install-proxy
```

这些流程验证空卷安装、登录、中文 PDF、重启持久化、加密备份恢复、当前版本重部署、卸载保留数据及 HTTPS 代理切换。完整业务回归、导出和批次验收见 README，原始结果在 `.runtime/reports/`。

页面打不开时，先检查 `status`、API 健康接口和实际失败容器日志。Caddy 的配置目录须可供 UID 1000 读取，安装器会修正当前挂载的目录与文件权限；实例密钥文件仍保持 600。邮件失败在管理中心查看 SMTP 与投递记录；内部任务失败在日志与任务中心查看对应权限内的错误并重试。
