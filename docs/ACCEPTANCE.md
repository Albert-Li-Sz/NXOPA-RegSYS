# MVP 验收报告

2026-10-12 九项增强、完整业务回归、两平台真实联动、100 并发负载、生产备份恢复及新版教程的本轮结果见 [增强功能验收](ENHANCEMENT_ACCEPTANCE.md)。以下保留各次历史验收范围。

验收日期：2026-10-11，Asia/Shanghai。源码、五个数据库迁移、依赖锁文件、生产 Docker Compose、管理员初始化、演示数据、Hydro 插件和接口文档均已交付。下列结果来自本机实际执行；PostgreSQL、Redis、两种 OJ、邮件收件箱和 XeLaTeX 均实际启动，未以接口模拟替代 OJ 注册。

本轮独立首页、账号范围及管理员平台配置调整见 [更新验收](BRANDING_UPDATE.md)。以下负载、PDF、财务和备份结果为前一轮完整 MVP 验收；本轮重测页面、认证与 OJ 联动，并单独保留结果。

2026-10-12 新增 URL 账号邀请与角色授权确认，当前共六个数据库迁移。操作说明与本轮权限、并发、邮箱、浏览器和容器验收单独记录于 [邀请授权验收](AUTHORIZATION_INVITATIONS.md)，不将历史 OJ、负载和备份结果表述为本轮重测。

## 2026-10-12 登录入口、系统邮件设置与配置教程更新

本次更新为竞赛列表和详情增加登录检查；未登录时跳转登录，成功后保留原路径与页签参数。独立首页继续公开展示。只读竞赛 API 仍保持公开，报名资料和管理接口遵守原有权限规则。

系统管理员可在“管理中心 → 邮件设置”配置服务器、端口、连接加密、认证和发件人，保存后检测连接并向当前管理员发送测试邮件。密码加密存储，留空保留、不回传；后台配置优先于初始环境配置，每次发送读取当前配置，无需重启。版本冲突返回 409，测试邮件使用持久化 Outbox / Worker，支持幂等提交与状态查询。竞赛管理员与普通用户无法读取或修改该配置。

同步按钮统一为“同步比赛账号”，本地验收实例名称和字段类型、作用域、任务说明改为中文。Hydro、DOMjudge 品牌和接口字段键名保持原协议值。

| 本次检查           | 实际结果与证据                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工程检查           | 类型检查、生产构建、格式检查和 4 项单元规则通过；[工程记录](acceptance/system-settings-checks.json)                                                                                          |
| 系统邮件配置       | 9 组真实 PostgreSQL / Redis / 认证 SMTP 检查通过，覆盖秘密不回传、留空保留、热更新、并发版本、重复测试、错误认证、加密要求、停用与过期任务；[邮件记录](acceptance/system-settings-mail.json) |
| 桌面与手机页面     | 8 项浏览器检查通过，无失败、跳过或重试；覆盖登录回跳、后台配置、实际邮件任务、权限、中文同步提示和既有平台创建绑定；[浏览器记录](acceptance/system-settings-browser.json)                    |
| 认证及链接授权回归 | 3 组邮箱验证 / 找回密码和 14 组邀请权限检查通过；[认证记录](acceptance/system-settings-auth.json)、[邀请记录](acceptance/system-settings-invitations.json)                                   |
| 生产 Compose       | 5 组检查通过：实际容器 Worker 投递至 Mailpit、API / Worker 重启后配置保留、构建产物登录回跳与受保护的后台连接检测；[容器记录](acceptance/system-settings-production.json)                    |
| 配置教程           | XeLaTeX 编译 13 页、14 张真实页面截图；逐页渲染检查中文、截图清晰度、分页和代码，日志无溢出或缺字警告；[教程检查](acceptance/system-settings-guide.json)                                     |

邮件验收使用本地 Mailpit，包括启用认证的独立测试实例；未声称已完成外部邮箱服务的公网投递验收。本轮未重跑完整 OJ 账号创建、负载和备份恢复，以下历史结果仍保留原验收时间。

教程交付：[配置教程 PDF](../output/pdf/configuration-guide.pdf)、[LaTeX 源码](CONFIGURATION_GUIDE.tex)、[源码与截图 ZIP](../output/pdf/configuration-guide-source.zip)。截图使用虚构配置，不展示密码、插件密钥或原始授权 URL。[桌面邮件页](acceptance/system-settings-mail-desktop.png)、[手机邮件页](acceptance/system-settings-mail-mobile.png)、[手机登录入口](acceptance/system-settings-login-mobile.png)同时归档。

开发环境复现：`pnpm test:mail`、`pnpm exec playwright test tests/e2e/platform-settings.spec.ts tests/e2e/system-settings.spec.ts tests/e2e/site.spec.ts --grep 'public landing|administrator saves SMTP|contest administrators cannot|desktop home|mobile layout|admin and contest configuration|system administrator configures|contest administrator binds'`。生产隔离实例使用 `TEST_URL=http://localhost:8080 pnpm exec tsx tests/integrations/system-settings-deployment.ts`，需要已有部署验收专用管理员文件和本地 Mailpit。只在隔离实例执行这些写入验收。

## 运行环境与交付物

### GitHub Pages 配置教程

教程网站源文件位于 `docs/site/`，正文由 `scripts/build-docs-site.mjs` 从已有 LaTeX 教程构建。网页含 12 个配置章节、14 张实际页面截图、章节定位、高清原图查看、配置示例复制，以及 PDF / LaTeX / 截图下载；[在线教程](https://albert-li-sz.github.io/NXOPA-RegSYS/)。

使用真实浏览器在 `/NXOPA-RegSYS/` 子路径完成 6 组检查：正文与模板变量、全部图片和脚本路径、章节导航与剪贴板、截图弹窗、三种下载文件 SHA-256、390 像素手机目录及无横向溢出。见 [教程浏览器记录](acceptance/pages-browser.json)、[桌面截图](acceptance/pages-desktop.png)、[邮件章节截图](acceptance/pages-mail.png)、[手机截图](acceptance/pages-mobile.png)。网页构建只依赖 Node.js 内置模块；发布由 `.github/workflows/pages.yml` 执行，推送教程相关变更至 `main` 后自动部署。

已保留目标仓库原有 MIT License 与初始提交，将项目推送至 `Albert-Li-Sz/NXOPA-RegSYS` 的 `main`。GitHub Actions [发布运行](https://github.com/Albert-Li-Sz/NXOPA-RegSYS/actions/runs/38166631827)构建与部署均成功；线上 `build-info.json` 对应提交 `772de76a072a4ed94761a14391a4886a6c1e0696`，公开地址返回 HTTP 200。公开网站重复完成全部 6 组浏览器检查，三种下载文件的 SHA-256 与本地交付物完全相同，无脚本错误或资源请求失败；[发布记录](acceptance/pages-deployment.json)、[线上浏览器记录](acceptance/pages-live-browser.json)、[线上桌面](acceptance/pages-live-desktop.png)、[线上手机](acceptance/pages-live-mobile.png)。仓库排除了私有环境配置、运行数据库与存储、测试凭据文件、依赖和临时编译目录。

本机 Node.js 24.18.0、pnpm 11.25.0、Docker Engine 29.8.2；Docker Desktop 分配 8 CPU、约 8 GiB 内存。生产镜像使用 Node.js 24.12.0、PostgreSQL 17.6、Redis 7.4.5、Caddy 2.10.2；Prisma 固定 7.10.0。官网使用 Vue 3 / TypeScript / Element Plus，API 与 Worker 独立运行。开发、正式 Compose 和两个 OJ 的数据库卷独立。

| 交付物                               | 位置                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| 启动入口与开发账号                   | [README](../README.md)                                                             |
| 正式部署、初始化、更新及加密备份恢复 | [部署说明](DEPLOYMENT.md)                                                          |
| OpenAPI、共享契约、Webhook 与 MCP    | [接口说明](API.md)、[OpenAPI JSON](api/openapi.json)                               |
| Hydro 插件与 DOMjudge 适配器         | [接入说明](INTEGRATIONS.md)、[插件源码](../plugins/hydro-contest-center/README.md) |
| 准考证配置与隔离规则                 | [准考证说明](ADMISSIONS.md)                                                        |
| 原始验收结果、截图与 PDF             | [证据目录](acceptance/manifest.json)                                               |

Hydro 可安装包由 `pnpm package:hydro` 生成，当前为 `dist/hydro-contest-center-0.1.0.tgz`，仅包含正式插件的源码、清单与说明。证据目录不包含环境密钥、会话、API Token、OJ 密码或真实个人资料；所有报名与附件使用虚构验收数据。

## 功能与边界验收

| 检查组              | 结果      | 实际覆盖与证据                                                                                                                                                                                |
| ------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型检查            | 通过      | 六个工作区包及 tests / scripts 的 TypeScript 检查                                                                                                                                             |
| 生产构建            | 通过      | API / Worker、官网和共享包构建；Docker API / 官网镜像构建成功                                                                                                                                 |
| 单元规则            | 4 项通过  | 报名时间边界、净收款资格与明确拒绝、中文转义及团队循环、禁止原始变量与原型访问                                                                                                                |
| 真实数据库业务      | 14 项通过 | 原子幂等、个人 / 团队、邀请确认、老师代办与即时解除、审核与资料版本、财务、工单、准考证；[business.json](acceptance/business.json)                                                            |
| 浏览器流程          | 10 项通过 | 独立首页入口、桌面 / 手机、筛选、账号、管理员平台配置、免费个人赛、邀请与代填团队、两种缴费顺序、老师、管理后台和真实 ZIP 下载；无失败、跳过或 flaky；[browser.json](acceptance/browser.json) |
| 邮件与认证          | 3 项通过  | Mailpit 实际收件、一次性邮箱验证、密码找回与旧会话撤销，以及第三方认证旧接口全部 404；[auth.json](acceptance/auth.json)                                                                       |
| 开放接口与任务边界  | 9 项通过  | 字段与竞赛范围、真实远端回调核验、Token 撤销、HMAC Webhook 失败恢复、编译隔离及超时、Worker 心跳、照片与座位版本；[boundaries.json](acceptance/boundaries.json)                               |
| 准考证批量接口      | 6 项通过  | 两份完整 PDF ZIP、逐文档权限、超限拒绝与去重、当前版本解析、同步 Token 不能读编译日志、自动审核竞赛被明确拒绝后撤销资格；[admissions-batch.json](acceptance/admissions-batch.json)            |
| 只读 stdio MCP      | 通过      | 实际 SDK 客户端发现 5 个工具、查询报名 / 财务 / 工单、字段过滤与越权拒绝；[mcp.json](acceptance/mcp.json)                                                                                     |
| 生产 Compose 与恢复 | 6 项通过  | 初始化登录、无演示账号、私有附件和中文 PDF、四服务重启持久化、损坏备份拒绝、实际恢复数据库 / 账簿 / 文件 / 会话；[deployment.json](acceptance/deployment.json)                                |

报名提交保存表单、人员和计费策略快照；旧版本并发更新实际返回 409，关键资料变更撤销资格和旧准考证，未改变内容的保存保持版本和资格。团队老师确认后可修改与提交；解除关联后访问和代办实际返回 403。个人与团队均只产生一份当前准考证，团队三位成员共用一份。

[工程检查输出](acceptance/checks.json)保留类型检查、构建、单元测试和格式检查结果；[验收环境](acceptance/environment.json)记录实际版本与资源配置。

财务验收覆盖按报名单及按人数计费、审核优先和缴费优先、上传凭证不取得资格、部分到账、重复核账不重复入账、预缴后拒绝报名、实际线下退款及幂等、开票申请、管理员上传和作废发票。账簿净额与报名资格相互核对。

## 两种 OJ 的真实验收

Hydro 与 DOMjudge 依次运行，避免与生产 / 开发系统同时争用验收机内存。两者均完成账号创建、目标竞赛参赛关联读取确认、实际认证、重复同步去重，以及远端已经提交但本站收到失败后的恢复。

| 平台     | 固定版本 | 实际认证与参赛检查                                                             | 结果                                               |
| -------- | -------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| Hydro    | 5.0.7    | POST /login 获得会话；带会话读取目标域的比赛，验证 UserContext 与 tsdoc.attend | [hydro.json](acceptance/hydro.json) 全部通过       |
| DOMjudge | 9.0.1    | 新账号 HTTP Basic 认证 /api/user，读取可访问竞赛列表及目标队伍关联             | [domjudge.json](acceptance/domjudge.json) 全部通过 |

DOMjudge 9.0.1 从官方发布归档实际构建，SHA-256 为 `3d46b31c296581833ac9f8e9b249d929fc28710e834b1cec68723791a2dceb97`。适配器使用该版本的 snake_case 写字段，创建后再次读取核验。Hydro 使用正式桥接插件；创建验收比赛的辅助路由只存在于本地 fixture，不包含在交付 tgz 中。

两种适配器当前声明创建、结果读取和连接探测能力。本站资格撤销后停止账号交付；已经创建的远端账号由 OJ 管理员处理停用，首版没有自动停用或更新远端资料。

## 中文 PDF 与页面检查

实际 XeLaTeX 生成中文个人和三人团队 PDF，各为一页；提取文本检查人数、中文、`& % _ #` 等转义，渲染后目视检查。照片模板使用受授权的 PNG 文件，实际 PDF 包含一个图片对象；座位更新重新生成新文档版本。检查模板更新后旧文件失效、未发放与越权下载被拒绝，以及编译失败记录可查询。

- [个人准考证 PDF](acceptance/individual.pdf)、[团队准考证 PDF](acceptance/team.pdf)、[文本与页数检查](acceptance/pdf-layout.json)。
- [独立桌面首页](acceptance/landing-desktop.png)、[独立手机首页](acceptance/landing-mobile.png)、[竞赛列表桌面](acceptance/home-desktop.png)、[竞赛列表手机](acceptance/home-mobile.png)、[报名详情](acceptance/registration-desktop.png)、[工单详情](acceptance/support-desktop.png)。

浏览器桌面宽 1280、手机宽 390；分别验证两列与单列卡片，手机文档宽度不超过 391 像素。截图关闭组件入场动画，确保状态标签完整展示。空搜索、未知路由和登录页实际检查。

编译隔离检查读取实际容器配置，并通过恶意模板确认禁止 shell 执行、不同任务的 700 私有目录互不可读。失控 TeX 在资源限制内结束；[隔离结果](acceptance/isolation-text.txt) 为 `SHELL-DISABLED`、`ISOLATED`。编译容器无网络、只读根目录，独立任务 UID，不挂载业务附件卷或 Docker socket。

## 一万份报名 / 100 并发

[原始负载结果](acceptance/load.json)记录真实 PostgreSQL 数据集：10,000 用户、10,000 份报名和 10,000 参赛人，准备耗时 5,392 ms。执行 1,000 次已认证请求、100 并发，混合为报名列表（每页 500 条）334 次、报名详情 333 次、竞赛详情 333 次。

| 指标                               | 实际结果        |
| ---------------------------------- | --------------- |
| 请求总耗时                         | 7,385 ms        |
| 吞吐                               | 135.4 请求 / 秒 |
| P50                                | 657.4 ms        |
| P95                                | 1,264.4 ms      |
| P99                                | 1,471.2 ms      |
| 最大响应时间                       | 1,500.2 ms      |
| HTTP / 断言错误                    | 0               |
| 全竞赛统计、分页读取、CSV 导出数量 | 均为 10,000     |

本轮验证本机开发 API 与真实数据库的读取负载，包含一次完整统计、分页和 CSV 数量核对；未将其表述为公网延迟或 100 并发写入能力。测试最后清除专用负载数据。当前官网主入口 JS 约 966 kB，构建提示分包优化；后续可按管理页面和 Element Plus 组件拆分。

## 复现顺序

只在隔离开发 / 验收实例执行这些脚本；它们会创建、修改虚构账号、报名和财务记录。保持 `pnpm dev`、开发 Worker 和 LaTeX 容器运行。

```bash
pnpm install --frozen-lockfile
pnpm setup
pnpm dev                 # 独立终端，启动真实数据库、Redis、Mailpit、编译器、API、Worker、官网
pnpm seed                # 另一个终端
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration    # 写入后续测试共用的 .runtime/acceptance-context.json
pnpm test:admissions
pnpm test:e2e
pnpm test:auth
pnpm test:mcp
pnpm test:load
```

OJ 使用 [接入说明](INTEGRATIONS.md) 启动。先启动 Hydro 执行 `OJ_TYPE=HYDRO pnpm test:oj`，再运行 `OJ_TYPE=HYDRO pnpm test:boundaries`；然后停止 Hydro、启动 DOMjudge，执行 `OJ_TYPE=DOMJUDGE pnpm test:oj`。也可让边界测试使用已完成注册且仍在运行的 DOMjudge。

生产持久化验收需要独立正式 Compose 数据库，开发 Mailpit 仍需运行：

```bash
DEPLOY_SMTP_HOST=host.docker.internal DEPLOY_SMTP_PORT=51025 docker compose up -d --build
TEST_URL=http://localhost:8080 pnpm test:deployment
pnpm format:check
```

部署测试生成私有 `.runtime/deployment-credentials.json`，通过正式初始化命令创建专用管理员，真实停止和重启服务，创建加密备份、拒绝损坏归档，修改报名后恢复并核对原版本、净收款、文件和会话。它不能针对已有正式业务数据执行。重新跑业务测试会替换后续测试共用的 fixture ID，随后应重新跑其依赖项。

## 正式上线需要配置的外部服务

本次交付为本地完整 MVP，生产 Compose 和持久化流程已实际验收。公开域名与 HTTPS 证书、真实 SMTP 投递、组织已有 OJ 的权限和比赛配置，需要上线时提供相应域名与服务凭据；本次使用 Mailpit 和独立 OJ 实例验证协议与流程。

默认线下收款、线下退款记录和管理员上传发票。在线支付、电子发票服务、多租户、共享本站 / OJ 密码，以及机器人写操作不在本轮范围内。
