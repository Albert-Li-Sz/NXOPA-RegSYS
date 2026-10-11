# 部署与维护

## 配置

`pnpm setup` 创建权限为 600 的 `.env` 并生成 32 字节随机 `ENCRYPTION_KEY`。密钥用于加密邮件密码、OJ 密码、Webhook 密钥、幂等结果和备份；请将它与备份分别保存。源码目录包含依赖锁文件和六个版本化数据库迁移。第六个迁移新增账号 / 授权邀请的接收者、竞赛范围、确认时间及查询索引，保留既有账号、角色与关联记录。

| 变量                                | 用途                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| POSTGRES_PASSWORD                   | 正式 Compose 数据库密码；上线前替换开发默认值                          |
| DEPLOY_PUBLIC_URL                   | 正式站点完整地址，默认 `http://localhost:8080`，也是邮件链接的基址     |
| PUBLIC_URL                          | 原生开发 API 的站点地址，默认 `http://localhost:5173`                  |
| SITE_ADDRESS                        | Caddy 地址，本地为 `:80`；HTTPS 部署改为实际域名                       |
| HTTP_PORT、HTTPS_PORT               | 默认 8080 / 8443；使用公网域名自动签证书时改为 80 / 443                |
| SMTP_HOST、SMTP_PORT                | 邮件服务器；正式 Compose 可用 DEPLOY_SMTP_HOST / DEPLOY_SMTP_PORT 覆盖 |
| SMTP_SECURE                         | SMTPS 465 设置 true；STARTTLS 587 使用 false                           |
| SMTP_USER、SMTP_PASSWORD、SMTP_FROM | 邮件认证和发件人                                                       |
| ENCRYPTION_KEY                      | 64 位十六进制密钥；需要保持不变才能读取既有凭据与备份                  |
| ALLOW_PRIVATE_INTEGRATIONS          | 本机独立 OJ 验收为 true；允许连接内网实例时显式保留此值                |

正式部署环境固定 production，Cookie 使用 HttpOnly、Secure、SameSite=Lax。写请求检查 CSRF；API Token 与浏览器会话分别授权。Caddy 为唯一公开入口，数据库、Redis、API、Worker 与编译器均无宿主机公开端口。

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
ALLOW_PRIVATE_INTEGRATIONS=false
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

首次登录后创建、配置并发布竞赛。账号支持四类身份并存；系统管理员在“用户权限”生成账号或角色邀请 URL，指定账号 / 邮箱、身份、有效期及竞赛，接收者登录、验证邮箱并确认后获得权限。公开邮箱注册继续开放。原有角色保留；首次管理员由初始化命令建立。邮件在“管理中心 → 邮件设置”配置，Hydro / DOMjudge 的实例与比赛绑定通过“管理中心 → 评测平台”配置；竞赛管理员只可操作获授权的实例与竞赛。带截图的操作教程见 [PDF](../output/pdf/configuration-guide.pdf)，可编辑的 [LaTeX 源码](CONFIGURATION_GUIDE.tex) 与截图一并提供。

## 后台邮件设置

系统管理员可配置启用状态、主机、端口、连接加密、服务器认证、用户名、密码 / 授权码以及发件地址和名称。提供立即加密、强制升级加密和不加密三种连接模式；不加密用于本地测试。首次未保存时继承上述环境变量，保存后数据库配置优先，Worker 每个邮件任务读取最新配置，无需重启。`SMTP_SECURITY=TLS/STARTTLS/NONE` 可明确设置初始模式；兼容原有 `SMTP_SECURE`。Compose 中的主机名是容器可访问的地址，本机 Mailpit 示例使用 `host.docker.internal`，不能填写容器自己的 `localhost`。

密码以 AES-256-GCM 加密，不返回浏览器。留空保留密码；更换认证用户名需重新填写，关闭认证并保存清除密码。修改检查配置版本，冲突返回 409；审计记录不含密码或密文。站点公开接口不会返回邮件配置，竞赛管理员与参赛者不能访问邮件配置或测试接口。

保存后先检测连接，再发送测试邮件，接收者固定为当前管理员。测试经持久化 Outbox / Worker 发送，可查询状态；检测通过与服务器接受邮件之后，还需在收件箱检查实际送达。失败原因使用中文并隐藏服务器原始认证信息。关闭邮件服务后发送任务失败，管理员启用服务后可在“任务”页重试。

此配置保存在通用 Setting 表中，包含在数据库备份，当前更新无需新增数据库迁移。站点公开地址、数据库、缓存、私有存储及加密密钥继续使用部署环境变量。

## 运行与更新

```bash
docker compose logs --tail 100 api worker
docker compose up -d --build
```

第 5 个迁移将站点名称改为“南晓开放原子社在线报名系统”，保留主色，停用旧第三方认证配置并撤销没有本站密码的旧会话；历史身份数据保留。旧账号可通过邮箱找回密码建立本站密码。

更新前运行备份。数据库迁移只向前执行，回退需要旧源码、对应镜像和更新前备份。后台“任务”页面提供 Worker 心跳、Outbox 积压、失败次数和重试；`/api/v1/admin/metrics` 对系统管理员提供同样数据。

Worker 从 PostgreSQL Outbox 派发任务，Redis 仅承载调度队列；数据库任务记录保留结果、失败原因与尝试次数。失败最多自动尝试四次，管理员可重新触发。中断超过五分钟的 RUNNING 任务会恢复到待执行；远端注册、核账、准考证生成按资源与版本去重。

## 加密备份与恢复

```bash
bash scripts/backup.sh /srv/contest-backups
bash scripts/restore.sh /srv/contest-backups/contest-center-YYYYMMDDTHHMMSSZ.ccbak
```

备份短暂停止 API / Worker，取得同一时间段的 PostgreSQL 自定义格式 dump、私有附件和 `.env`，再用 AES-256-GCM 加密，自动保留最近 30 天备份。完成或失败后恢复服务，临时明文目录自动删除。备份与生产目录同样需要限制访问。

恢复时使用原始 `ENCRYPTION_KEY`，先完成认证解密和归档检查，数据库以单事务恢复，再恢复私有文件。原配置保存到 `.runtime/restored-environment.env` 供比较；恢复脚本不会自动覆盖当前连接配置。源文件、PDF、收款凭证、发票和已存在会话包含在备份中；Redis、运行中的编译目录不包含，任务从数据库恢复。

在服务器的调度服务中每天调用备份脚本，示例为 `/absolute/path/scripts/backup.sh /srv/contest-backups`。本次实现没有修改宿主机的系统调度。异机恢复时保持数据库版本、源代码 / 镜像版本与加密密钥一致，并先用隔离数据库验证备份。

## 资源与隔离

验收在 8 CPU / 8 GiB 的 Docker Desktop 虚拟机完成，Hydro 与 DOMjudge 依次运行。LaTeX Runner 无网络、只读根文件系统、无 Docker socket / 生产附件挂载，内存上限 1200 MiB、单核、64 进程；每次编译使用独立 UID 和 700 私有目录，CPU 限制 30 秒、两遍各 45 秒、输出最多 10 MiB。API / Worker 的容器内存限制分别为 1000 / 700 MiB。

开发端口：官网 5173、API 3000、PostgreSQL 55432、Redis 56379、Mailpit SMTP 51025 / Web 58025。OJ 独立验收端口只绑定 localhost。
