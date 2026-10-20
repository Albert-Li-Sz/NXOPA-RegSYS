# 部署与维护

新部署推荐使用 [一键安装说明](../deploy/README.md)：无需在宿主机安装 Node.js / pnpm，独立生成 `deploy/.env`，并提供启动、管理员初始化和加密备份恢复命令。安装包默认由内部 Caddy 提供 `127.0.0.1:8080` HTTP 入口，自有代理将整个站点转发到该入口并负责公网 HTTPS，示例见 `deploy/nginx.conf.example`。所有安装镜像固定版本标签，PostgreSQL 和 Caddy 同时按 Docker 服务端选择平台，不使用 `@sha256`。本文的根目录 Compose 命令继续供已有 Caddy 部署使用；两个入口默认项目名和数据卷不同，切换入口时须保留原项目名、数据库密码与加密密钥。

## 配置

`pnpm setup` 创建权限为 600 的 `.env` 并生成 32 字节随机 `ENCRYPTION_KEY`。密钥用于加密邮件密码、OJ 密码、Webhook 密钥、幂等结果和备份；请将它与备份分别保存。源码目录包含依赖锁文件和版本化数据库迁移。第七、八个迁移增加参赛性质、组织资料、发票快照、学校映射、平台绑定版本、查询索引与映射外键；旧报名默认为正式参赛，历史表单、发票与远端 ID 保留。

| 变量                                | 用途                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| POSTGRES_PASSWORD                   | 正式 Compose 数据库密码；上线前替换开发默认值                          |
| DEPLOY_PUBLIC_URL                   | 正式站点初始地址，默认 `http://localhost:8080`；用于邮件与邀请链接     |
| PUBLIC_URL                          | 原生开发站点初始地址，默认 `http://localhost:5173`                     |
| SITE_ADDRESS                        | Caddy 地址，本地为 `:80`；HTTPS 部署改为实际域名                       |
| HTTP_PORT、HTTPS_PORT               | 默认 8080 / 8443；使用公网域名自动签证书时改为 80 / 443                |
| SMTP_HOST、SMTP_PORT                | 邮件服务器；正式 Compose 可用 DEPLOY_SMTP_HOST / DEPLOY_SMTP_PORT 覆盖 |
| SMTP_SECURE                         | SMTPS 465 设置 true；STARTTLS 587 使用 false                           |
| SMTP_USER、SMTP_PASSWORD、SMTP_FROM | 邮件认证和发件人                                                       |
| ENCRYPTION_KEY                      | 64 位十六进制密钥；需要保持不变才能读取既有凭据与备份                  |
| ALLOW_PRIVATE_INTEGRATIONS          | 默认 true；如需禁止内网实例显式设置 false                              |

正式部署环境固定 production，Cookie 使用 HttpOnly、SameSite=Lax，HTTPS 请求设置 Secure。写请求检查 CSRF；API Token 与浏览器会话分别授权。Caddy 为唯一公开入口，数据库、Redis、API、Worker 与编译器均无宿主机公开端口。

PostgreSQL、Redis 和 Caddy 分别直接使用官方 `postgres:17.6-alpine`、`redis:7.4.5-alpine`、`caddy:2.10.2-alpine` 镜像。前端 `web`、API、Worker 和 LaTeX 各自运行在业务容器内；前端只包含 Vue 构建产物，Caddy 通过只读挂载 `infra/caddy/Caddyfile` 代理 `web:8080` 与 `api:3000`。网络分为前端入口 `edge`、后端出站 `app` 和私有数据库 `data`，前端不连接数据库网络、不读取后端秘密。

线上 `.env` 示例片段：

```dotenv
DEPLOY_PUBLIC_URL=https://contest.example.org
SITE_ADDRESS=contest.example.org
HTTP_PORT=80
HTTPS_PORT=443
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_FROM=Contest Center <noreply@example.org>
ALLOW_PRIVATE_INTEGRATIONS=true
```

实际密码保存在本机 `.env`，不写入源码。正式环境的OJ / Webhook 连接要求 HTTPS。私有网络的 HTTP OJ 可通过同机 HTTPS 代理接入。演示数据库固定使用开发密码与独立端口，与正式数据库互不共用。

## 初次启动

```bash
docker compose up -d --build
docker compose ps
docker compose run --rm api pnpm bootstrap:admin
curl --fail http://localhost:8080/api/v1/health
```

初始化任务先为两个私有卷设置 UID 1000 所有权，再执行 Prisma migration deploy。API 和 Worker 使用非 root 用户。管理员初始化命令交互输入邮箱与隐藏密码；自动安装也可通过 `ADMIN_EMAIL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` 环境变量提供，避免把密码写入命令参数或 shell 历史。

首次登录后可管理竞赛；以参赛身份报名时先在账号中心完善学号、姓名、班级、学院和性别。账号支持四类身份并存；系统管理员在“用户权限”生成账号或角色邀请 URL，指定账号 / 邮箱、身份、有效期及竞赛，接收者登录、验证邮箱并确认后获得权限。公开邮箱注册继续开放。原有角色保留；首次管理员由初始化命令建立。邮件在“管理中心 → 邮件设置”配置，Hydro / DOMjudge 的实例与比赛绑定通过“管理中心 → 评测平台”配置；竞赛管理员只可操作获授权的实例与竞赛。带截图的操作教程见 [PDF](../output/pdf/configuration-guide.pdf)，可编辑的 [LaTeX 源码](CONFIGURATION_GUIDE.tex) 与截图一并提供。

## 后台邮件设置

系统管理员可配置启用状态、主机、端口、连接加密、服务器认证、用户名、密码 / 授权码以及发件地址和名称。提供立即加密、强制升级加密和不加密三种连接模式；不加密用于本地测试。首次未保存时继承上述环境变量，保存后数据库配置优先，Worker 每个邮件任务读取最新配置，无需重启。`SMTP_SECURITY=TLS/STARTTLS/NONE` 可明确设置初始模式；兼容原有 `SMTP_SECURE`。Compose 中的主机名是容器可访问的地址，本机 Mailpit 示例使用 `host.docker.internal`，不能填写容器自己的 `localhost`。

密码以 AES-256-GCM 加密，不返回浏览器。留空保留密码；更换认证用户名需重新填写，关闭认证并保存清除密码。修改检查配置版本，冲突返回 409；审计记录不含密码或密文。站点公开接口不会返回邮件配置，竞赛管理员与参赛者不能访问邮件配置或测试接口。

保存后先检测连接，再发送测试邮件，接收者固定为当前管理员。测试经持久化 Outbox / Worker 发送，可查询状态；检测通过与服务器接受邮件之后，还需在收件箱检查实际送达。失败原因使用中文并隐藏服务器原始认证信息。关闭邮件服务后发送任务失败，管理员启用服务后可在“任务”页重试。

邮件配置保存在通用 Setting 表中并包含在数据库备份。数据库、缓存、私有存储及加密密钥继续使用部署环境变量；公网地址可在后台维护。

## 公网地址与域名迁移

系统管理员在“管理中心 → 全局设置”填写根路径地址、核对链接预览并保存。API 与 Worker 每次生成或发送链接时读取数据库的有效地址，用于验证邮箱、找回密码、账号与角色授权、成员与老师邀请、工单通知。未保存时继承环境变量。保存检查版本并记录审计，拒绝账号密码、额外路径、查询参数、片段和非法端口。浏览器写操作允许实际同源、环境初始地址和当前有效公网地址；其他管理来源在 `TRUSTED_MANAGEMENT_ORIGINS` 中用逗号列出。TLS、域名与访问控制由反向代理负责。

上线时配置域名 A／AAAA 解析、Caddy 的 `SITE_ADDRESS` 和 80／443 端口。更换域名前先完成新域名解析、反向代理及证书，并实际验证登录，然后保存后台公网地址。已经发出的旧链接不会改写，迁移期间继续代理旧域名。

公网地址使用 HTTPS 时，会话及 OAuth 状态 Cookie 强制使用 Secure；浏览器也应通过 HTTPS 访问。内网 HTTP 部署继续支持 HTTP 地址。登录前的写入检查来源，登录后的写入另检查会话 CSRF。若链接地址填错，在保留原数据库连接和加密密钥的运行环境执行：

```bash
# 原生部署
pnpm restore:public-url https://reg.example.org
# Docker 部署
docker compose exec api pnpm restore:public-url https://reg.example.org
```

恢复命令保留其他设置、递增版本并记录 `SITE_URL_RECOVERY` 审计，不清空数据库。恢复地址允许根路径 HTTP／HTTPS。

## 运行与更新

```bash
docker compose logs --tail 100 api worker
docker compose logs --tail 100 caddy web
docker compose up -d --build
```

此前 `web` 同时运行 Caddy 的部署升级后，官方 `caddy` 容器接管原端口和证书卷，`web` 只运行页面服务。保持项目名和 `.env` 不变，先备份再执行上述更新命令，保留数据库、附件和证书；无需重新初始化管理员。

第 5 个迁移将站点名称改为“南晓开放原子社在线报名系统”，保留主色，停用旧第三方认证配置并撤销没有本站密码的旧会话；历史身份数据保留。旧账号可通过邮箱找回密码建立本站密码。

更新前运行备份。数据库迁移只向前执行，回退需要旧源码、对应镜像和更新前备份。后台“任务”页面提供 Worker 心跳、Outbox 积压、失败次数和重试；`/api/v1/admin/metrics` 对系统管理员提供同样数据。

Worker 从 PostgreSQL Outbox 派发任务，Redis 仅承载调度队列；数据库任务记录保留结果、失败原因与尝试次数。失败最多自动尝试四次，管理员可重新触发。中断超过五分钟的 RUNNING 任务会恢复到待执行；远端注册、核账、准考证生成按资源与版本去重。

## 加密备份与恢复

本次报名流程升级会永久清理历史 `CANCELLED`、`CANCEL_REQUESTED` 报名。必须先备份，再启动新版 API / Worker：数据库迁移先建立独立财务账户、迁移四类财务单据外键并核对余额，API / Worker 在接收请求和处理任务前执行可重试的历史清理，不补发历史取消通知。清理保留财务凭证及共享文件，移除旧资料快照、邀请、准考证与任务中的报名副本。

升级后核对财务账户余额、凭证／账簿／退款／发票数量和财务附件可读性，再检查当前报名数及匿名累计计数。`pnpm test:workflow-upgrade` 会在独立数据库中建立 v0.4.0 数据、备份、执行迁移和重复清理，再实际恢复旧备份核对。永久清理后的回退必须恢复升级前数据库与文件备份，同时恢复对应代码／镜像；仅切回旧镜像不能恢复已删除报名。

```bash
bash scripts/backup.sh /srv/contest-backups
bash scripts/restore.sh /srv/contest-backups/contest-center-YYYYMMDDTHHMMSSZ.ccbak
```

备份短暂停止 API / Worker，取得同一时间段的 PostgreSQL 自定义格式 dump、私有附件和 `.env`，再用 AES-256-GCM 加密，自动保留最近 30 天备份。完成或失败后恢复服务，临时明文目录自动删除。备份与生产目录同样需要限制访问。

恢复时使用原始 `ENCRYPTION_KEY`，先完成认证解密和归档检查，数据库以单事务恢复，再恢复私有文件。原配置保存到 `.runtime/restored-environment.env` 供比较；恢复脚本不会自动覆盖当前连接配置。源文件、PDF、收款凭证、发票和已存在会话包含在备份中；Redis、运行中的编译目录不包含，任务从数据库恢复。

恢复在停止业务服务前检查外层和嵌套文件归档，拒绝越界路径、重复路径、符号／硬链接、特殊文件及损坏数据。默认限制解压总量 100 GiB、最多 100000 项。验证器在 API 镜像内运行，无需宿主机 Node.js。验证失败不会执行数据库恢复。

安全升级增加凭证附件唯一占用、退款操作人、平台同步租约及 Webhook 内网审批字段。旧财务单据与账目不自动改写；历史重复凭证生成 `VOUCHER_DUPLICATE_HISTORY` 审计，需人工对账。旧加密密文与验证码仍可读取，新密文使用版本与用途派生密钥。旧版本已销毁的非财务审计无法恢复；缺少来源信息的匿名历史取消数无法准确拆分为用户取消与管理员删除。

安装、更新和恢复使用 `IMAGE_TAG` 指定的完整版本标签（如 `v0.6.5`），不使用 `latest`、浮动小版本或 `@sha256`。从 `main` 获取的新入口兼容旧发布包，会在校验安装包后移除自动摘要覆盖并保留官方镜像原版本；新版安装与备份恢复助手不再加载遗留的 `compose.digest.yaml`。发布清单中的摘要仍用于检查五类镜像的版本、来源提交及公开可拉取性，附件 SHA256 继续验证下载完整性；这些检查不能替代独立可信的发布渠道或离线签名，详见 [安全说明](../SECURITY.md)。

在服务器的调度服务中每天调用备份脚本，示例为 `/absolute/path/scripts/backup.sh /srv/contest-backups`。本次实现没有修改宿主机的系统调度。异机恢复时保持数据库版本、源代码 / 镜像版本与加密密钥一致，并先用隔离数据库验证备份。

## 资源与隔离

验收在 8 CPU / 8 GiB 的 Docker Desktop 虚拟机完成，Hydro 与 DOMjudge 依次运行。LaTeX Runner 无网络、只读根文件系统、无 Docker socket / 生产附件挂载，内存上限 1200 MiB、单核、64 进程；每次编译使用独立 UID 和 700 私有目录，CPU 限制 30 秒、两遍各 45 秒、输出最多 10 MiB。API / Worker 的容器内存限制分别为 1000 / 700 MiB。

开发端口：官网 5173、API 3000、PostgreSQL 55432、Redis 56379、Mailpit SMTP 51025 / Web 58025。OJ 独立验收端口只绑定 localhost。

## GitHub 登录、用户标签与报名编号

管理员在“管理中心 → GitHub 登录”配置 OAuth App 的 Client ID、Client Secret 与回调地址。回调默认使用请求站点地址加 `/api/v1/auth/github/callback`，需要与 GitHub 注册的地址一致；也可设置 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_CALLBACK_URL` 作为初始配置。反向代理传递正确的 Host 与 X-Forwarded-Proto。密钥加密保存且不返回浏览器。

新账号使用 GitHub 已验证邮箱，不自动合并同邮箱的本站账号；已有账号先登录再绑定。所有参赛账号均需完成五项资料。管理员在用户列表编辑标签并筛选；报名按首次正式提交从早到晚分配每个竞赛独立编号，补正保留编号，删除后不重复使用原编号，CSV 同步导出。旧报名升级自动回填序号，旧账号缺失资料需要补填；已取消报名按上述升级规则清理。
