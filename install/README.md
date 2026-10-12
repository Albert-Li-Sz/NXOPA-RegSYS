# Docker Compose 安装

本目录部署“南晓开放原子社在线报名系统”。需要保留完整仓库，镜像从上一层源码构建；不能只复制 `install` 文件夹。宿主机只需要 Docker、Compose 插件、Bash、OpenSSL 和 Git，无需安装 Node.js、pnpm、数据库或 LaTeX。

## 1. 准备服务器

建议至少 2 核 CPU、4 GiB 内存、20 GiB 可用磁盘；编译镜像需要额外磁盘空间。较多并发或同时生成准考证时建议 4 核、8 GiB 内存。Linux 服务器使用 Docker Engine，macOS / Windows 使用 Docker Desktop；Windows 命令在 WSL2 Bash 中执行。

Ubuntu / Debian 配置 Docker 官方软件源后，安装 Compose 插件：

```bash
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git openssl
docker version
docker compose version
```

Docker 官方软件源、安装与账号权限步骤见 [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)、[Debian](https://docs.docker.com/engine/install/debian/) 和 [Compose 插件安装](https://docs.docker.com/compose/install/linux/)。使用支持 `up --wait` 的 Compose，建议 v2.20 或更新版本。

## 2. 下载与生成配置

```bash
git clone https://github.com/Albert-Li-Sz/NXOPA-RegSYS.git
cd NXOPA-RegSYS/install
bash install.sh init
```

生成 `install/.env`，包含独立随机数据库密码与 32 字节加密密钥，权限为 `600`。重复运行保留原配置与密钥，不覆盖仓库根目录用于开发的 `.env`。配置示例为 `.env.example`，实际 `.env` 不进入 Git。首次安装不要直接复制含占位符的示例，使用 `init` 生成。

默认 `COMPOSE_PROJECT_NAME=nxopa-regsys`，容器、网络和数据卷使用该前缀。根目录旧部署使用 `contest-center`，两个入口默认使用不同数据。已有正式实例要继续使用原项目名、数据库密码和加密密钥，并沿用原公网地址；不要重新初始化密钥或更换数据卷前缀。

### 本机试用

默认配置即可：

```dotenv
PUBLIC_URL=http://localhost:8080
SITE_ADDRESS=:80
HTTP_PORT=8080
HTTPS_PORT=8443
```

本机浏览器访问 `http://localhost:8080`。生产 Cookie 带 Secure 属性；普通局域网 IP 的 HTTP 地址不适合正式登录。异地访问可通过 SSH 转发：

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server
```

然后在本机浏览器打开 `http://localhost:8080`；正式对外服务采用下方 HTTPS 配置。

### 公网域名与自动 HTTPS

先将域名 A / AAAA 解析到服务器，放通 TCP 80 / 443，并确保其他服务没有占用这两个端口。编辑 `install/.env`：

```dotenv
PUBLIC_URL=https://reg.example.org
SITE_ADDRESS=reg.example.org
HTTP_PORT=80
HTTPS_PORT=443
```

Caddy 自动申请与续期证书，证书保存在持久卷中。`PUBLIC_URL` 为系统初始公网地址与可信管理入口，须填写完整根路径地址；`SITE_ADDRESS` 填域名，不添加 `/api` 或其他路径。首次构建会下载依赖及中文 TeX 组件，需要服务器能访问镜像仓库、npm 和 Debian 软件源。

### 已有反向代理

由已有 Nginx / Caddy / 网关负责 HTTPS 时，可让本系统只在服务器本机监听 HTTP：

```dotenv
PUBLIC_URL=https://reg.example.org
SITE_ADDRESS=:80
HTTP_PORT=127.0.0.1:8080
HTTPS_PORT=127.0.0.1:8443
```

将整个域名代理到 `http://127.0.0.1:8080`，保持请求的 Host 和 Origin；页面与 `/api/*` 使用同一域名。代理不要去掉 `/api` 路径。

## 3. 启动与创建管理员

```bash
# 在 install 目录执行
bash install.sh config
bash install.sh up
bash install.sh admin
```

`up` 构建镜像、启动 PostgreSQL / Redis、设置私有卷权限、执行所有 Prisma 迁移，再启动 API、Worker、Caddy 和 XeLaTeX。安装会等待 API 的数据库 / Redis 健康检查，以及 Worker 的数据库心跳检查。初始化容器执行完成后显示 `Exited (0)` 属于正常状态。

管理员命令交互输入邮箱与隐藏密码，密码至少 10 位。默认用户名为 `administrator`，可通过邮箱或用户名登录。不会创建开发演示账号，也不会覆盖已有管理员。自动安装可向进程提供 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 和可选 `ADMIN_USERNAME`；使用临时环境或秘密管理工具提供密码，命令参数不包含密码。

```bash
bash install.sh status
curl --fail http://localhost:8080/api/v1/health
# 域名部署使用：
curl --fail https://reg.example.org/api/v1/health
```

健康接口返回 `{"status":"ok"}`。首次访问首页，点击“进入报名系统”后登录，在管理中心创建竞赛。

也可直接使用 Compose：

```bash
docker compose --env-file .env -f compose.yaml up -d --build --wait --wait-timeout 240
docker compose --env-file .env -f compose.yaml exec api pnpm bootstrap:admin
```

所有脚本支持从任意工作目录运行，例如仓库根目录的 `bash install/install.sh up`。安装脚本始终明确选择 `install/compose.yaml` 与 `install/.env`；需要独立配置文件时使用 `INSTALL_ENV_FILE=/absolute/path/.env bash install/install.sh up`。

## 4. 管理中心配置

| 位置     | 配置内容                                                                        |
| -------- | ------------------------------------------------------------------------------- |
| 全局设置 | 系统名称、公网 URL、品牌与链接预览                                              |
| 邮件设置 | SMTP 地址、端口、TLS / STARTTLS、用户名、授权码、发件人；检测连接并发送测试邮件 |
| 评测平台 | Hydro / DOMjudge 实例、凭据、域和比赛、学校映射、分组、正式 / 非正式同步规则    |
| 用户权限 | 生成账号邀请或角色授权 URL，接收者登录确认生效                                  |
| 任务     | 检查邮件、平台同步、准考证和 Webhook 的执行状态及失败重试                       |

邮件默认停用，管理员初始化不依赖邮箱服务。配置并测试 SMTP 后再开放公开注册。邮件设置和后台公网 URL 保存到数据库，API / Worker 自动读取，无需重启。

内网 OJ 接入时在 `.env` 中设置 `ALLOW_PRIVATE_INTEGRATIONS=true` 并重新执行 `up`。Docker / Linux 均提供 `host.docker.internal` 指向宿主机；容器内的 `localhost` 是容器自身，不能用来访问宿主机 SMTP / OJ。同一个外部 Docker 网络中的平台也可经正确的内部主机名接入。生产环境 OJ 接口要求 HTTPS。

详细操作和 Hydro 插件下载见 [在线教程](https://albert-li-sz.github.io/NXOPA-RegSYS/) 及 [平台接入说明](../docs/INTEGRATIONS.md)。

修改域名前先配置新域名解析、代理和证书，再在管理中心更新公网地址；期间继续保留原入口。地址填错时：

```bash
bash install.sh restore-url https://reg.example.org
```

这会恢复数据库公网地址并记录审计；入口端口和 Caddy 域名仍通过 `.env` 设置。

## 5. 更新、日志和备份

```bash
bash install.sh logs api worker
bash install.sh stop
bash install.sh up
```

每个服务的 Docker 日志轮转为 10 MiB × 3 份。数据库、Redis 和私有附件使用持久卷；LaTeX 无网络、只读根文件系统并限制资源。只有 Caddy 暴露端口，PostgreSQL、Redis 和 API 不公开宿主机端口。

更新先获取需要的源码版本，再执行 `update`；脚本先加密备份，备份失败不会继续构建或迁移。

```bash
cd ..
git pull --ff-only
bash install/install.sh update
```

```bash
# 默认备份至 install/backups，也可指定其他目录
bash install.sh backup
bash install.sh backup /srv/nxopa-backups
bash install.sh restore /srv/nxopa-backups/contest-center-YYYYMMDDTHHMMSSZ.ccbak
```

备份短暂停止 API / Worker，包含同一时段的数据库、私有附件与安装环境配置，采用 AES-256-GCM 加密。完成后恢复服务，保留最近 30 天备份。恢复会替换当前实例数据库和附件；从其他服务器恢复时必须保留原始 `ENCRYPTION_KEY`。原环境另存到仓库根目录的 `.runtime/restored-environment.env` 供比较，不会自动覆盖当前 `install/.env`。

将加密密钥和备份分别保存到服务器之外。部署后保持 `POSTGRES_PASSWORD`、`ENCRYPTION_KEY`、`COMPOSE_PROJECT_NAME` 不变：修改 `.env` 中数据库密码不会自动修改已经初始化的 PostgreSQL 密码；更换加密密钥将无法读取既有凭据和备份。停止 / 移除容器使用 `stop` / `down`，不要对有数据的实例执行 `down -v`。

## 6. 排查问题

| 现象            | 检查方法                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| Docker 无法连接 | 启动 Docker Desktop / Engine，检查 Docker socket 权限                                |
| 端口已被占用    | 修改 `.env` 的端口；本机试用同时修改 `PUBLIC_URL`，检查已有根目录 Compose 实例       |
| 初始化失败      | `bash install.sh compose logs --tail 100 initialize`，核对数据库密码、磁盘和迁移错误 |
| Worker 不健康   | 检查 `logs worker`，以及 PostgreSQL / Redis 状态；管理中心查看任务与心跳             |
| HTTPS 证书失败  | 检查域名解析、80 / 443 端口、Caddy 日志及是否有错误 AAAA 记录                        |
| 登录后仍未登录  | 使用 HTTPS 公网地址或本机 localhost，核对域名、Origin 和代理路径                     |
| 邮件无法发送    | 使用容器可访问的 SMTP 主机，核对 TLS、授权码，后台检测并检查真实收件箱               |
| 平台同步失败    | 后台检查绑定、插件能力、学校映射和目标比赛；修正后重试任务                           |
| 构建下载失败    | 检查服务器的镜像仓库、npm 和 Debian 软件源网络；恢复后再次运行 `up`                  |

`bash install.sh config` 只检查配置，不打印密码。`compose config` 的完整输出包含密钥，不要将其粘贴到公开日志或工单。独立安装验收可在开发机运行 `pnpm test:install`，会使用临时配置、独立 Compose 项目和数据卷。
