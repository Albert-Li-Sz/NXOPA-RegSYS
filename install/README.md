# Docker Compose 安装

本目录部署“南晓开放原子社在线报名系统”。支持源码构建和拉取发布镜像两种模式。源码模式需要保留完整仓库，不能只复制 `install`；Release 安装包包含镜像模式所需的配置和维护脚本，无需业务源码。宿主机只需要 Docker、Compose 插件、Bash、OpenSSL；从仓库下载时另需 Git，无需安装 Node.js、pnpm、数据库或 LaTeX。

V0.1.3 的镜像标签为 `v0.1.3`，支持 amd64 / arm64。镜像模式通过 `compose.images.yaml` 覆盖构建配置；后续启动、管理员初始化、日志、备份和恢复继续使用同一个 `install.sh`。

## 交互式安装、更新与卸载

在 `install` 目录执行以下命令，无需手动编辑首次安装配置：

```bash
bash install.sh
bash update.sh
bash uninstall.sh
```

三个入口均支持 `--help`，也可从任意目录通过完整路径运行。默认读取脚本目录的 `.env`；多个实例使用 `INSTALL_ENV_FILE=/absolute/path/.env` 选择各自配置。`lib.sh` 是三个入口共同使用的辅助文件，复制安装材料时须一并保留。

- `install.sh`：检查 Docker / Compose，选择项目名、发布镜像或源码构建、固定镜像版本，以及本机 HTTP、Caddy 公网 HTTPS或已有反向代理。随机生成数据库密码与加密密钥，将配置保存为权限 `600` 的文件；等待服务健康，再交互输入管理员用户名、邮箱与两次隐藏密码。首次安装默认使用发布镜像；本机模式只监听 `127.0.0.1`，远程访问请使用 SSH 转发。已有配置会沿用原项目、地址与密钥，已有数据卷但没有配置时拒绝重新生成密钥。
- `update.sh`：显示当前实例，镜像模式交互输入目标版本；源码模式使用已取得的新版完整源码。确认后先按原配置生成加密备份，再拉取或构建、迁移并等待健康检查。备份失败会中止升级，拉取或启动失败会保留原配置；如果数据库迁移已经执行，降回旧版前需先恢复升级前备份。
- `uninstall.sh`：默认删除当前项目的容器和网络，保留全部数据卷，可再次安装恢复。选择永久删除数据时必须准确输入 `DELETE 项目名`；默认建议先加密备份，备份失败会中止卸载。安装配置和备份始终保留，因为旧备份解密需要原加密密钥。脚本不删除其他项目、共享镜像或宿主机 Docker。

原有 `bash install.sh init/up/admin/backup/restore/...` 命令保持可用，适用于既有维护流程和自动化部署。

从 v0.1.1 或更早版本升级时，尚未使用的邮箱验证与密码重置链接会失效，用户需要重新申请。已有登录会话、报名、财务和附件保留。保持原项目名与密钥，将 `IMAGE_TAG` 改为 `v0.1.3` 后执行 `bash install.sh update`，该命令先备份再升级。

基础设施直接使用官方镜像，业务分别构建和运行：

| 服务         | 镜像 / 构建目标                      | 职责                                 |
| ------------ | ------------------------------------ | ------------------------------------ |
| `postgres`   | `postgres:17.6-alpine` 官方镜像      | PostgreSQL 数据库，持久卷保存数据    |
| `redis`      | `redis:7.4.5-alpine` 官方镜像        | BullMQ 队列与缓存，启用 AOF 持久化   |
| `caddy`      | `caddy:2.10.2-alpine` 官方镜像       | 唯一公开入口，HTTPS、证书及反向代理  |
| `web`        | `infra/Dockerfile` 的 `web` 目标     | Vue 生产页面和静态资源，独立只读容器 |
| `api`        | `infra/Dockerfile` 的 `runtime` 目标 | NestJS 业务 API                      |
| `worker`     | `infra/Dockerfile` 的 `worker` 目标  | 邮件、平台同步、PDF 和导出任务       |
| `initialize` | 与 API 相同的运行镜像                | 一次性数据库迁移和私有卷权限初始化   |
| `latex`      | `infra/latex-runner`                 | 无网络的 XeLaTeX 编译沙箱            |

Caddy 通过只读挂载的 `infra/caddy/Caddyfile` 将 `/api/*` 转发到 `api:3000`，其余页面转发到 `web:8080`；Caddy 镜像不包含前端代码。前端容器只保存构建后的页面，不持有数据库、Redis 或加密密钥，也不挂载报名附件。

网络按访问关系拆分：`edge` 仅连接 Caddy 与前端，`data` 仅连接数据库、Redis 和后端；这两个网络禁止直接访问外网。`app` 为 Caddy、API、Worker 提供入口转发及 SMTP / OJ 出站访问。LaTeX 不加入任何网络。除 Caddy 外，各服务均不映射宿主机端口。

## 1. 准备服务器

建议至少 2 核 CPU、4 GiB 内存、20 GiB 可用磁盘；编译镜像需要额外磁盘空间。较多并发或同时生成准考证时建议 4 核、8 GiB 内存。Linux 服务器使用 Docker Engine，macOS / Windows 使用 Docker Desktop；Windows 命令在 WSL2 Bash 中执行。

Ubuntu / Debian 配置 Docker 官方软件源后，安装 Compose 插件：

```bash
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git openssl
docker version
docker compose version
```

Docker 官方软件源、安装与账号权限步骤见 [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)、[Debian](https://docs.docker.com/engine/install/debian/) 和 [Compose 插件安装](https://docs.docker.com/compose/install/linux/)。使用 Compose v2.24.4 或更新版本，以支持发布镜像配置中的构建重置与 `up --wait`。

## 2. 下载与生成配置

### 使用 V0.1 发布安装包

从 [V0.1 Release](https://github.com/Albert-Li-Sz/NXOPA-RegSYS/releases/tag/v0.1.3) 下载 `nxopa-regsys-v0.1.3-install.tar.gz` 和 `SHA256SUMS`，对照其中该安装包的 SHA-256：

```bash
sha256sum nxopa-regsys-v0.1.3-install.tar.gz
tar -xzf nxopa-regsys-v0.1.3-install.tar.gz
cd nxopa-regsys-v0.1.3/install
bash install.sh init
```

发布安装包的默认配置为 `INSTALL_MODE=images`，拉取以下业务镜像；PostgreSQL、Redis 和 Caddy 继续直接使用上表的官方镜像：

| 服务         | 发布镜像                                          |
| ------------ | ------------------------------------------------- |
| API / 初始化 | `ghcr.io/albert-li-sz/nxopa-regsys-api:v0.1.3`    |
| Worker       | `ghcr.io/albert-li-sz/nxopa-regsys-worker:v0.1.3` |
| 前端         | `ghcr.io/albert-li-sz/nxopa-regsys-web:v0.1.3`    |
| LaTeX        | `ghcr.io/albert-li-sz/nxopa-regsys-latex:v0.1.3`  |

### 使用完整源码仓库

```bash
git clone https://github.com/Albert-Li-Sz/NXOPA-RegSYS.git
cd NXOPA-RegSYS/install
bash install.sh init
```

生成 `install/.env`，包含独立随机数据库密码与 32 字节加密密钥，权限为 `600`。重复运行保留原配置与密钥，不覆盖仓库根目录用于开发的 `.env`。配置示例为 `.env.example`，实际 `.env` 不进入 Git。首次安装不要直接复制含占位符的示例，使用 `init` 生成。

完整仓库默认 `INSTALL_MODE=source`；要改用已发布镜像，在 `.env` 设置：

```dotenv
INSTALL_MODE=images
IMAGE_PREFIX=ghcr.io/albert-li-sz/nxopa-regsys
IMAGE_TAG=v0.1.3
```

保留 `IMAGE_TAG` 为确定的版本，避免使用随未来发布变动的 `latest`。已有 `.env` 不含 `INSTALL_MODE` 时仍使用原来的源码模式。

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

`up` 按模式构建业务镜像或从 GHCR 拉取指定版本，使用独立官方 PostgreSQL / Redis 容器、设置私有卷权限、执行所有 Prisma 迁移，再启动 API、Worker、前端、Caddy 和 XeLaTeX。安装会等待数据库、Redis、API、Worker、前端和 Caddy 的健康检查。初始化容器执行完成后显示 `Exited (0)` 属于正常状态。

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
# 镜像模式的直接 Compose 命令必须同时指定两个配置文件：
docker compose --env-file .env -f compose.yaml -f compose.images.yaml pull
docker compose --env-file .env -f compose.yaml -f compose.images.yaml up -d --no-build --wait --wait-timeout 240
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
bash install.sh logs caddy web
bash install.sh stop
bash install.sh up
```

每个服务的 Docker 日志轮转为 10 MiB × 3 份。数据库、Redis、私有附件和 Caddy 证书使用各自的持久卷；业务容器更新不删除这些数据。LaTeX 无网络、只读根文件系统并限制资源。

源码模式更新先获取需要的源码版本，再执行 `update`；脚本先加密备份，备份失败不会继续构建或迁移。

```bash
cd ..
git pull --ff-only
bash install/install.sh update
```

镜像模式升级时下载新版本安装包中的配置和脚本，保留原 `.env` 与项目名、数据库密码、加密密钥；将 `.env` 的 `IMAGE_TAG` 改为新版本，再执行 `bash install.sh update`。脚本先备份，然后拉取和启动，不在宿主机构建。只检查镜像下载可以执行 `bash install.sh pull`。

从此前由 `web` 容器同时提供 Caddy 和页面的版本升级时，同一命令会重建独立前端并启动新的 `caddy` 服务。入口端口、域名和已有持久卷名称不变；保留原项目名与 `.env` 后，数据库、附件和 Caddy 证书继续使用原卷。根目录 Compose 也采用相同拆分；已有根目录实例先执行 `bash scripts/backup.sh`，再执行 `docker compose up -d --build --wait --wait-timeout 240`。

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
| HTTPS 证书失败  | 检查域名解析、80 / 443 端口、`logs caddy` 及是否有错误 AAAA 记录                     |
| 页面或 API 502  | 分别检查 `logs caddy web api` 和 `status`；不要直接公开 API 或前端端口               |
| 登录后仍未登录  | 使用 HTTPS 公网地址或本机 localhost，核对域名、Origin 和代理路径                     |
| 邮件无法发送    | 使用容器可访问的 SMTP 主机，核对 TLS、授权码，后台检测并检查真实收件箱               |
| 平台同步失败    | 后台检查绑定、插件能力、学校映射和目标比赛；修正后重试任务                           |
| 构建下载失败    | 检查服务器的镜像仓库、npm 和 Debian 软件源网络；恢复后再次运行 `up`                  |

`bash install.sh config` 只检查配置，不打印密码。`compose config` 的完整输出包含密钥，不要将其粘贴到公开日志或工单。独立安装验收可在开发机运行 `pnpm test:install`，会使用临时配置、独立 Compose 项目和数据卷。
