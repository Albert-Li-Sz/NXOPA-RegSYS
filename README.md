# 南晓开放原子社在线报名系统 · Contest Center

可自托管的中文竞赛报名系统，采用 Vue 3、Element Plus、NestJS、Prisma 7、PostgreSQL、Redis/BullMQ 和隔离的 XeLaTeX 编译容器。支持个人与团队报名、指导老师、审核、线下财务、工单、准考证、Hydro / DOMjudge 联动，以及联合注册 API 和只读 MCP。

- [Docker Compose 安装包与步骤](install/README.md)
- [V0.1 发布、Docker 镜像与安装附件](https://github.com/Albert-Li-Sz/NXOPA-RegSYS/releases/tag/v0.1.0)
- [部署与日常维护](docs/DEPLOYMENT.md)
- [在线配置教程（GitHub Pages）](https://albert-li-sz.github.io/NXOPA-RegSYS/)
- [带截图的配置教程（PDF）](output/pdf/configuration-guide.pdf)、[LaTeX 源码](docs/CONFIGURATION_GUIDE.tex)、[源码与截图打包](output/pdf/configuration-guide-source.zip)
- [API、Webhook 与 MCP 接入](docs/API.md)
- [评测平台接入与独立验收实例](docs/INTEGRATIONS.md)
- [LaTeX 模板与准考证](docs/ADMISSIONS.md)
- [验收报告](docs/ACCEPTANCE.md)
- [增强功能验收报告](docs/ENHANCEMENT_ACCEPTANCE.md)
- [Hydro 0.2.0 插件与校验文件下载](https://albert-li-sz.github.io/NXOPA-RegSYS/#hydro-plugin)
- [原始业务规则](PROJECT_PLAN.md)、[结构设计](docs/ARCHITECTURE.md)

## 启动正式实例

推荐使用 `install` 目录的独立安装入口。宿主机需要 Docker Compose、Bash 和 OpenSSL，Node.js / pnpm 随镜像安装。

从 V0.1 Release 下载的安装包默认拉取 GHCR 预构建镜像，支持 amd64 / arm64；无需业务源码。完整仓库默认从源码构建，也可在 `install/.env` 设置 `INSTALL_MODE=images` 与 `IMAGE_TAG=v0.1.0` 使用发布镜像。

```bash
bash install/install.sh init
# 公网部署按 install/README.md 修改 install/.env 的域名与端口
bash install/install.sh up
bash install/install.sh admin
```

本机试用打开 <http://localhost:8080>；公网部署使用配置的 HTTPS 域名。初始化命令交互输入管理员邮箱和密码；首次创建后使用邮箱或 `administrator` 登录。正式容器固定为 production 模式，初始化不会创建演示账号，也不会覆盖已有账号。数据库迁移在 API 启动前自动执行。已有根目录 Compose 部署仍可沿用原入口和配置；默认安装项目名 `nxopa-regsys` 与旧项目 `contest-center` 使用不同数据卷，迁移入口时按安装说明保留原项目名和密钥。

PostgreSQL、Redis 和 Caddy 各自直接使用官方镜像；Vue 前端、NestJS API、Worker 和 XeLaTeX 分别运行在独立容器。只有 Caddy 公开端口，通过内网转发前端与 API；数据库和队列位于独立私有网络。各服务与数据卷说明见 [安装说明](install/README.md)。

## 本地开发与演示

```bash
pnpm install --frozen-lockfile
pnpm setup
pnpm dev
# 在另一个终端创建虚构的开发演示数据
pnpm seed
```

首页 <http://localhost:5173> 为独立介绍页，点击“进入报名系统”时未登录会跳转登录，成功后返回 <http://localhost:5173/contests>；竞赛详情链接同样保留原页面和参数。社团与集训队 Logo 使用提供的原图。账号仅支持邮箱注册与账号密码登录；Hydro / DOMjudge 的实例凭据、比赛绑定和同步设置位于“管理中心 → 评测平台”。SMTP 位于系统管理员的“管理中心 → 邮件设置”，支持保存、检测和向当前管理员发送测试邮件。

API 文档 <http://localhost:3000/api/docs>，Mailpit <http://localhost:58025>。开发数据库与正式 Compose 使用独立卷。

| 用户名            | 身份                     |
| ----------------- | ------------------------ |
| admin             | 系统管理员               |
| manager           | 六场示例竞赛的竞赛管理员 |
| alice、bob、carol | 参赛者                   |
| teacher           | 指导老师                 |

开发演示密码统一为 `DemoContest2026!`，邮箱为对应用户名的 `@example.test`。`pnpm seed` 在 production 模式会拒绝执行。

## 验证命令

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
pnpm test:enhancements
pnpm test:admissions
pnpm test:e2e
pnpm test:auth
pnpm test:mail
pnpm test:mcp
pnpm test:load
```

额外的 `test:oj`、`test:boundaries`、`test:deployment` 及其依赖和执行顺序见验收报告。浏览器测试优先使用本机 Chrome；其他环境先运行 `pnpm exec playwright install chromium`。

## 编译配置教程

教程使用 XeLaTeX、ctex / Fandol 中文字体和实际页面截图。已有截图可直接编译；需要更新截图时，在本地开发环境启动系统并准备演示账号，再执行第一条命令。截图使用虚构配置，不展示密码或原始授权链接。

```bash
pnpm exec tsx scripts/capture-configuration-guide.ts
# 先完成相应独立平台增强验收，再捕获评测系统实际页面
pnpm exec tsx scripts/capture-enhancement-guide.ts DOMJUDGE
pnpm exec tsx scripts/capture-enhancement-guide.ts HYDRO
bash scripts/build-configuration-guide.sh
```

输出为 `output/pdf/configuration-guide.pdf`、含 LaTeX 源码与截图的 ZIP，以及文件摘要清单。仅编译无需运行截图命令。

## 教程网站与 GitHub Pages

在线教程位于 <https://albert-li-sz.github.io/NXOPA-RegSYS/>，包含章节导航、实际页面截图、原图查看、配置示例复制，以及 PDF / LaTeX / 截图和 Hydro 插件下载。网页正文从 `docs/CONFIGURATION_GUIDE.tex` 构建，章节与截图数量自动生成，样式和交互源文件位于 `docs/site/`。工作流检查教程摘要清单，并从同一提交按白名单打包版本化／稳定插件包及 SHA-256。

```bash
pnpm docs:build
pnpm docs:dev
```

本地预览：<http://localhost:5184/NXOPA-RegSYS/>。构建仅使用 Node.js 内置模块，产物位于 `dist/docs-site`。修改教程后重新编译 PDF，再推送到 `main`；[Pages 工作流](.github/workflows/pages.yml)自动构建和发布教程。GitHub 仓库的 Pages 发布源使用 **GitHub Actions**，也可在 Actions 手动运行“发布配置教程”。

预览启动后，可在另一终端执行 `pnpm docs:test` 检查章节、手机布局、截图查看、命令复制和下载文件。`DOCS_TEST_URL=https://albert-li-sz.github.io/NXOPA-RegSYS/ pnpm docs:test` 可检查线上教程；测试只读取静态网页和公开文件。

GitHub Pages 托管配置教程；报名服务通过 Docker Compose 部署。项目私有环境文件、运行数据、缓存和临时编译目录均排除于 Git。

## 工程目录

```text
apps/web                 官网、账号中心和管理界面
apps/server              NestJS API、事务业务服务、独立 Worker、Prisma 迁移
apps/mcp-adapter          只读 stdio MCP
packages/contracts       表单、计费、资格规则与联合注册共享契约
packages/connectors      Hydro、DOMjudge 适配器
plugins/hydro-contest-center  Hydro 5.0.7 桥接插件
infra                    Compose、Caddy、LaTeX Runner 和独立 OJ 实例
install                  正式安装 Compose、配置示例、安装维护脚本与说明
scripts                  初始化、开发启动、备份恢复与 OJ 构建
tests                    单元、真实数据库、浏览器和外部接口验收
```

每份报名产生一张准考证，团队成员共用；上传凭证后必须由管理员核实实际到账。老师解除关联后即时失去访问和代办权限。本站与评测平台使用独立密码。首版使用线下收款、线下退款记录和上传发票；在线支付、电子发票服务、多租户和机器人写操作保留扩展接口。

账号可公开使用邮箱注册，也可接受管理员发出的账号邀请。管理员在 **管理后台 → 用户权限** 生成指定账号 / 邮箱的授权链接，接收者登录、验证邮箱并点击确认后，才能成为系统管理员、指定竞赛管理员或指导老师。撤销权限立即生效，旧链接不能恢复授权。首次管理员仍由初始化命令创建。[邀请操作与验收](docs/AUTHORIZATION_INVITATIONS.md)。

邀请权限验收：`pnpm test:invitations`；界面验收：`pnpm exec playwright test tests/e2e/authorization.spec.ts`。两项使用隔离开发实例及虚构数据，需要 API、PostgreSQL、Redis、Worker、Mailpit 和官网运行。
