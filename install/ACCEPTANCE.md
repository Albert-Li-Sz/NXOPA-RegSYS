# Docker Compose 安装验收

验收日期：2026-10-12。Docker Engine 29.8.2、Docker Compose 5.5.1。使用随机命名的独立 Compose 项目、临时配置、空 PostgreSQL / Redis 卷和未占用端口，从当前源码构建，未复用现有报名系统的数据库。测试结束后移除了专用验收容器和数据卷。

执行：`pnpm test:install`。12 项真实安装检查全部通过：

1. 从其他工作目录生成权限 `600` 的配置、随机数据库密码和加密密钥；重复初始化不改变配置。
2. 安装 Compose 正确解析源码构建目录、生产模式、PostgreSQL / Redis 内部地址；数据库 / Redis / API 无公开端口；LaTeX 无网络和只读根文件系统。
3. PostgreSQL、Redis、Caddy 直接使用官方镜像，没有业务构建步骤；前端、API、Worker、编译器独立，前端无数据库凭据，Caddy 不连接数据库网络。
4. 公网 HTTPS 地址、域名及已有反向代理的 `127.0.0.1` 端口绑定正确解析到独立 `caddy` 服务。
5. 从空数据卷完成业务镜像构建、Prisma 迁移与启动；读取实际容器的镜像名称确认官方 PostgreSQL / Redis / Caddy；六个服务健康。迁移容器仅连接私有数据网络，使用构建时安装好的依赖完成启动。
6. 通过 Caddy 获取独立前端页面；历史路由刷新返回页面，JavaScript MIME、永久缓存和 HEAD 正常；缺失资源、隐藏文件、路径穿越和不支持的请求方法被拒绝。
7. 通过安装命令创建管理员并实际登录；正式数据库无开发演示账号，未配置 SMTP 时邮件停用。
8. 生产浏览器实际进入首页、跳转登录并返回比赛列表，刷新后保持会话，未发生脚本错误。
9. 创建并提交真实免费个人报名、上传私有附件，通过数据库 Outbox、Redis / BullMQ、Worker 和隔离的 XeLaTeX 生成、发放并下载中文准考证；未登录访问附件被拒绝。
10. 重启 PostgreSQL、Redis、API、Worker 后，会话、参赛资格和附件保留。
11. 通过安装入口加密备份；取消报名后恢复备份，报名版本、资格和附件恢复；备份包含安装实例的环境配置。
12. 在容器内恢复数据库公网 URL，读回新地址；携带原部署入口 Origin 的管理写请求继续通过。

额外通过工作区类型检查、Shell 语法检查、ShellCheck、变更文件格式检查与 `git diff --check`。官方 Caddy 容器的配置校验通过；镜像构建执行了生产前端构建和后端类型检查。

现有根目录 Compose 实例也已先加密备份，再升级为相同的容器拆分。对比升级前后的用户、报名、附件、账簿、开票、准考证及平台账号映射七张表，记录数和完整行内容摘要一致；原数据库、Redis、附件和 Caddy 持久卷名称与挂载位置一致。六个服务健康，`http://localhost:8080/api/v1/health` 返回 `{"status":"ok"}`；已有管理员通过独立 Caddy 实际登录并读取管理指标。检查结果保存到本机 `.runtime/reports/container-separation.json`。

公网域名、ACME 证书签发和真实 SMTP 投递取决于部署服务器的 DNS、端口与邮箱凭据；本次未使用用户正式域名或邮箱进行验收。HTTPS 与代理配置完成了 Compose 解析检查，正式部署后按 [安装说明](README.md) 检查实际证书、登录和测试邮件。

可重复运行的测试源码位于 [tests/integrations/install.ts](../tests/integrations/install.ts)，最近一次本地检查结果位于 Git 忽略的 `.runtime/reports/install.json`。测试不将密钥、管理员密码或实际 `.env` 写入验收报告。
