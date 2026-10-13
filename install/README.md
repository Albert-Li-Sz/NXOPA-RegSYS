# Docker Compose 安装

本目录部署“南晓开放原子社在线报名系统”。支持源码构建和拉取发布镜像两种模式。源码模式需要保留完整仓库，不能只复制 `install`；Release 安装包包含镜像模式所需的配置和维护脚本，无需业务源码。宿主机只需要 Docker、Compose 插件、Bash、OpenSSL；从仓库下载时另需 Git，无需安装 Node.js、pnpm、数据库或 LaTeX。

V0.1.4 的镜像标签为 `v0.1.4`，支持 amd64 / arm64。镜像模式通过 `compose.images.yaml` 覆盖构建配置；后续启动、管理员初始化、日志、备份和恢复继续使用同一个 `install.sh`。

## 交互式安装、更新与卸载

在 `install` 目录执行以下命令，无需手动编辑首次安装配置：

```bash
bash install.sh
bash update.sh
bash uninstall.sh
```

三个入口均支持 `--help`，也可从任意目录通过完整路径运行。默认读取脚本目录的 `.env`；多个实例使用 `INSTALL_ENV_FILE=/absolute/path/.env` 选择各自配置。`lib.sh` 是三个入口共同使用的辅助文件，复制安装材料时须一并保留。

- `install.sh`：检查 Docker / Compose，选择项目名、发布镜像或源码构建、固定镜像版本，浏览器访问地址，以及前端和 API 的本机上游端口。随机生成数据库密码与加密密钥，将配置保存为权限 `600` 的文件；等待服务健康，再交互输入管理员用户名、邮箱与两次隐藏密码。首次安装默认使用发布镜像且不安装 Caddy。前端与 API 仅监听 `127.0.0.1`，由用户自己的反向代理提供同域入口及 HTTPS。已有配置会沿用原项目、地址与密钥，已有数据卷但没有配置时拒绝重新生成密钥。
- `update.sh`：显示当前实例，镜像模式交互输入目标版本；源码模式使用已取得的新版完整源码。确认后先按原配置生成加密备份，再拉取或构建、迁移并等待健康检查。备份失败会中止升级，拉取或启动失败会保留原配置；如果数据库迁移已经执行，降回旧版前需先恢复升级前备份。
- `uninstall.sh`：默认删除当前项目的容器和网络，保留全部数据卷，可再次安装恢复。选择永久删除数据时必须准确输入 `DELETE 项目名`；默认建议先加密备份，备份失败会中止卸载。安装配置和备份始终保留，因为旧备份解密需要原加密密钥。脚本不删除其他项目、共享镜像或宿主机 Docker。

原有 `bash install.sh init/up/admin/backup/restore/...` 命令保持可用，适用于既有维护流程和自动化部署。

从 v0.1.1 或更早版本升级时，尚未使用的邮箱验证与密码重置链接会失效，用户需要重新申请。已有登录会话、报名、财务和附件保留。保持原项目名与密钥，将 `IMAGE_TAG` 改为 `v0.1.4` 后执行 `bash install.sh update`，该命令先备份再升级。

基础设施直接使用官方镜像，业务分别构建和运行：

| 服务         | 镜像 / 构建目标                      | 职责                                 |
| ------------ | ------------------------------------ | ------------------------------------ |
| `postgres`   | `postgres:17.6-alpine` 官方镜像      | PostgreSQL 数据库，持久卷保存数据    |
| `redis`      | `redis:7.4.5-alpine` 官方镜像        | BullMQ 队列与缓存，启用 AOF 持久化   |
| `web`        | `infra/Dockerfile` 的 `web` 目标     | Vue 生产页面和静态资源，独立只读容器 |
| `api`        | `infra/Dockerfile` 的 `runtime` 目标 | NestJS 业务 API                      |
| `worker`     | `infra/Dockerfile` 的 `worker` 目标  | 邮件、平台同步、PDF 和导出任务       |
| `initialize` | 与 API 相同的运行镜像                | 一次性数据库迁移和私有卷权限初始化   |
| `latex`      | `infra/latex-runner`                 | 无网络的 XeLaTeX 编译沙箱            |

默认部署不包含 Caddy，也不占用 80 / 443。前端上游为 `127.0.0.1:8081`，API 上游为 `127.0.0.1:3000`。用户自己的反向代理必须将 `/api/` 转发到 API（保留完整路径），其余请求转发到前端，并使用同一域名。前端只保存构建后的页面，不持有数据库、Redis 或加密密钥，也不挂载报名附件。

`edge` 连接前端，`app` 为 API / Worker 提供 SMTP / OJ 出站访问，`data` 是数据库、Redis 与后端共享的私有网络。数据库、队列、Worker、LaTeX 不映射宿主机端口；LaTeX 无网络。默认持久卷为数据库、Redis、私有文件及编译任务四个卷。

安装脚本按 Docker **服务端**的 amd64 / arm64 架构加载 `compose.amd64.yaml` / `compose.arm64.yaml`，固定官方 PostgreSQL 17.6 Alpine 的对应运行镜像摘要。数据库版本、数据目录和卷名保持不变；无需拉取多架构索引中的其他架构与证明元数据。自定义 `DOCKER_DEFAULT_PLATFORM` 时须选择 `linux/amd64` 或 `linux/arm64`。直接调用 Compose 时也须按架构加载此覆盖文件，日常维护建议使用 `install.sh`。

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

从 [V0.1 Release](https://github.com/Albert-Li-Sz/NXOPA-RegSYS/releases/tag/v0.1.4) 下载 `nxopa-regsys-v0.1.4-install.tar.gz` 和 `SHA256SUMS`，对照其中该安装包的 SHA-256：

```bash
sha256sum nxopa-regsys-v0.1.4-install.tar.gz
tar -xzf nxopa-regsys-v0.1.4-install.tar.gz
cd nxopa-regsys-v0.1.4/install
bash install.sh init
```

发布安装包的默认配置为 `INSTALL_MODE=images`，拉取以下业务镜像；PostgreSQL 和 Redis 继续使用官方镜像：

| 服务         | 发布镜像                                          |
| ------------ | ------------------------------------------------- |
| API / 初始化 | `ghcr.io/albert-li-sz/nxopa-regsys-api:v0.1.4`    |
| Worker       | `ghcr.io/albert-li-sz/nxopa-regsys-worker:v0.1.4` |
| 前端         | `ghcr.io/albert-li-sz/nxopa-regsys-web:v0.1.4`    |
| LaTeX        | `ghcr.io/albert-li-sz/nxopa-regsys-latex:v0.1.4`  |

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
IMAGE_TAG=v0.1.4
```

保留 `IMAGE_TAG` 为确定的版本，避免使用随未来发布变动的 `latest`。已有 `.env` 不含 `INSTALL_MODE` 时仍使用原来的源码模式。

默认 `COMPOSE_PROJECT_NAME=nxopa-regsys`，容器、网络和数据卷使用该前缀。根目录旧部署使用 `contest-center`，两个入口默认使用不同数据。已有正式实例要继续使用原项目名、数据库密码和加密密钥，并沿用原公网地址；不要重新初始化密钥或更换数据卷前缀。

### 配置自有反向代理（默认）

将域名解析到服务器，准备 HTTPS 证书；开放端口由用户自己的代理管理。安装器不会安装代理或申请证书。`install/.env` 示例：

```dotenv
PUBLIC_URL=https://reg.example.org
REVERSE_PROXY_MODE=external
WEB_PORT=127.0.0.1:8081
API_PORT=127.0.0.1:3000
```

`PUBLIC_URL` 填浏览器访问的完整根地址，不能带 `/api`、账号、查询或片段。前端端口只提供静态页面，不能把整个域名仅代理到前端。

安装包提供 [nginx.conf.example](nginx.conf.example)，放入 Nginx 的 `http` 配置上下文，例如 `/etc/nginx/conf.d/nxopa-regsys.conf`。替换域名、证书路径及上游端口后执行 `nginx -t`，成功后重载 Nginx。关键路由：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000;
}
location / {
    proxy_pass http://127.0.0.1:8081;
}
```

API 的 `proxy_pass` 不加末尾 `/`，避免删除 `/api/` 前缀。两个路由均须保留 Host / Origin，并传递原始 `X-Forwarded-Proto`；完整示例包含上传大小和超时配置。Nginx 若运行在另一容器中，`127.0.0.1` 指向该代理容器自身：将代理加入安装项目的 `edge` 与 `app` 网络，分别代理 `web:8080` 和 `api:3000`，不要加入 `data` 网络。

本机试用时设置 `PUBLIC_URL=http://localhost:8080`，由自己的 HTTP 代理监听 8080，仍将两个路由转发到 8081 / 3000。访问端口与两个上游端口须不同。生产登录使用 HTTPS；异地本机试用可对代理入口执行 `ssh -L 8080:127.0.0.1:8080 your-user@your-server`。

### 已有 Caddy 部署升级

v0.1.3 及更早配置带有 `SITE_ADDRESS` / `HTTP_PORT` / `HTTPS_PORT`，且没有 `REVERSE_PROXY_MODE`。安装脚本自动加载兼容文件 `compose.caddy.yaml`，继续使用原 Caddy 入口、证书卷和端口，防止更新后失去访问。新安装始终写入 `REVERSE_PROXY_MODE=external`。

切换到自有代理前先备份并准备好代理配置，然后在原 `.env` 增加 `REVERSE_PROXY_MODE=external`、`WEB_PORT` 和 `API_PORT`；保持项目名、数据库密码、加密密钥与原公网地址。执行 `bash install.sh up`，脚本移除本项目已停用的 Caddy 容器，释放其入口端口，再启动自己的代理。数据库和附件不会重新初始化，原证书卷保留。可在维护期间切换，完成后验证健康接口和登录。回退代理模式可明确设置 `REVERSE_PROXY_MODE=caddy`，沿用原三个 Caddy 变量。

根目录 `compose.yaml` 继续供已有 Caddy 部署使用；新安装使用本目录的脚本。

## 3. 启动与创建管理员

```bash
# 在 install 目录执行
bash install.sh config
bash install.sh up
bash install.sh admin
```

`up` 按模式构建业务镜像或从 GHCR 拉取指定版本，使用独立官方 PostgreSQL / Redis 容器、设置私有卷权限、执行所有 Prisma 迁移，再启动 API、Worker、前端和 XeLaTeX。安装会等待数据库、Redis、API、Worker 和前端的健康检查；自配代理须另外配置和验证。初始化容器执行完成后显示 `Exited (0)` 属于正常状态。

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

这会恢复数据库公网地址并记录审计；两个上游端口通过 `.env` 设置；代理域名与证书在用户自己的代理中设置。

## 5. 更新、日志和备份

```bash
bash install.sh logs api worker
bash install.sh logs web
bash install.sh stop
bash install.sh up
```

每个服务的 Docker 日志轮转为 10 MiB × 3 份。数据库、Redis、私有附件和编译任务使用各自的持久卷；业务容器更新不删除这些数据。LaTeX 无网络、只读根文件系统并限制资源。

源码模式更新先获取需要的源码版本，再执行 `update`；脚本先加密备份，备份失败不会继续构建或迁移。

```bash
cd ..
git pull --ff-only
bash install/install.sh update
```

镜像模式升级时下载新版本安装包中的配置和脚本，保留原 `.env` 与项目名、数据库密码、加密密钥；将 `.env` 的 `IMAGE_TAG` 改为新版本，再执行 `bash install.sh update`。脚本先备份，然后拉取和启动，不在宿主机构建。只检查镜像下载可以执行 `bash install.sh pull`。

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
| HTTPS 证书失败  | 检查自有代理的域名解析、证书、80 / 443 端口及代理日志                                |
| 页面或 API 502  | 分别检查自有代理日志、`logs web api` 和 `status`；两个上游仅绑定本机                 |
| 登录后仍未登录  | 使用 HTTPS 公网地址或本机 localhost，核对域名、Origin 和代理路径                     |
| 邮件无法发送    | 使用容器可访问的 SMTP 主机，核对 TLS、授权码，后台检测并检查真实收件箱               |
| 平台同步失败    | 后台检查绑定、插件能力、学校映射和目标比赛；修正后重试任务                           |
| 构建下载失败    | 检查服务器的镜像仓库、npm 和 Debian 软件源网络；恢复后再次运行 `up`                  |

### `content descriptor ... not found` 镜像拉取错误

已定位示例中的 `sha256:f9989be93aaf18e0f2ee8da9e8cbaedc1979c5c1aa89e1c8a0dc18524e5eb7f9` 是官方 `postgres:17.6-alpine` 多架构索引的证明元数据配置，不是数据库运行配置，也不是 Caddy。2026-10-13 对 Docker Hub 源站读取该文件返回 200；部分不完整的镜像代理仍可能返回 404。新版脚本直接选择官方对应架构的运行摘要，绕开这个额外文件，仍使用 PostgreSQL 17.6 和原数据卷。

升级安装材料时须一并替换 `lib.sh` 及两个架构覆盖文件，保留原 `.env`。运行 `bash install.sh pull` 后再执行 `bash install.sh up`。拉取按顺序执行，便于看清具体失败的镜像。若其他摘要仍返回 404，记录镜像名、Docker 版本和已配置的镜像代理；核对代理是否完整同步，必要时改用可访问的完整源。不要删除数据卷、重新生成密钥或无差别清理所有 Docker 数据。

`bash install.sh config` 只检查配置，不打印密码。`compose config` 的完整输出包含密钥，不要将其粘贴到公开日志或工单。独立安装验收可在开发机运行 `pnpm test:install`，会使用临时配置、独立 Compose 项目和数据卷。
