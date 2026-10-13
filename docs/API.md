# API、Webhook 与 MCP

HTTP 接口说明由实际 NestJS 路由与共享 Zod 契约生成，运行中的 Swagger 位于 `/api/docs`，JSON 位于 `/api/docs-json`。源码快照见 [openapi.json](api/openapi.json)，共享类型见 `packages/contracts/src/index.ts`。

```bash
pnpm generate:client
```

此命令生成 `apps/web/src/generated/api.d.ts`。`generated-client.ts` 提供使用 openapi-fetch 的类型化浏览器客户端，附加 CSRF 与幂等键；前端页面的请求服务统一处理用户提示。

## 业务接口

| 前缀                    | 能力                                                  |
| ----------------------- | ----------------------------------------------------- |
| `/api/v1/auth`          | 邮箱注册与验证、密码 / GitHub 登录、会话与资料        |
| `/api/v1/contests`      | 官网列表、状态、配置与版本化字段                      |
| `/api/v1/registrations` | 草稿、邀请、老师关联、提交、审核、取消和完整 CSV 导出 |
| `/api/v1/invitations`   | 指定接收者的链接预览、明确确认与邀请撤销              |
| `/api/v1/finance`       | 凭证、核账、冲正、退款、发票                          |
| `/api/v1/support`       | 系统 / 竞赛工单、附件与回复                           |
| `/api/v1/admissions`    | 模板、预览、生成、发放、PDF 与批量 ZIP                |
| `/api/v1/integrations`  | 平台配置、绑定、探测、同步与账号交付                  |
| `/api/v1/admin`         | 用户权限、字段库、站点设置、Token、任务与审计         |

浏览器会话 Cookie 为 `cc_session`。从 `GET /api/v1/auth/me` 获取 CSRF，写操作发送 `X-CSRF-Token`。写入版本化资源时传 `version`；旧版本返回 409。写请求可传 `Idempotency-Key`，同一用户对相同 URL、方法、正文的重试返回原结果；幂等结果和业务写入在一个 PostgreSQL 事务提交，结果静态加密。

JSON 请求上限 5 MiB，附件上限 10 MiB。竞赛后台统计与导出使用完整权限和筛选条件，不随当前页变化。准考证批量下载使用 POST /api/v1/admissions/batch，正文选择 ids 或 registrationIds，单次最多 1000 张。

### 分页与筛选

列表显式传入 `page` 或 `pageSize` 时返回共享 `PageResult<T>`：`{items,total,page,pageSize}`。`page` 从 1 开始，`pageSize` 只接受 20／50／100，默认 20。审计、任务、用户、授权邀请、报名、工单和财务历史均支持后端分页；权限与搜索／状态／时间条件同时作用于总数和列表。报名按每个竞赛的首次提交编号升序排列，草稿放在末尾，再按创建时间和 ID 排序。

```text
GET /api/v1/admin/audit?page=2&pageSize=50&search=<对象ID>&status=REVIEW
GET /api/v1/registrations?page=1&pageSize=20&contestId=<UUID>&participationType=UNOFFICIAL
GET /api/v1/registrations/:id/finance/invoices?page=1&pageSize=20
```

时间筛选为带时区 ISO `from`／`to`。状态键按列表使用 `status`、`review`、`kind`；完整参数见 OpenAPI。报名可使用 `eligible`、`participationType`、`search`、`tag`，统计与 CSV 接收同样筛选。`GET /registrations/:id?history=false` 返回财务合计但不附带历史数组，历史分别从 `finance/vouchers`、`finance/ledger`、`finance/refunds`、`finance/invoices` 读取。

未显式分页的旧调用继续返回原数组；报名 `cursor=<上一页最后一项ID>` 按报名列表相同顺序、最多 500 条，用于导出和既有集成。CSV 遍历全部筛选报名，采用 UTF-8 BOM 并转义公式前缀。

### 公网地址、竞赛与发票

`GET /api/v1/site` 返回当前 `publicUrl` 与配置 `version`；系统管理员 `PUT /api/v1/admin/site` 保存新地址并检查版本。地址允许根路径 HTTP／HTTPS；API 与 Worker 动态读取，只用于生成链接，不作为登录来源白名单。TLS、域名与访问控制由反向代理负责；登录后的写请求仍检查 CSRF。CLI `pnpm restore:public-url https://reg.example.org` 提供恢复并记录审计。

竞赛新增 `descriptionFormat: TEXT|MARKDOWN`；旧数据保持 `TEXT`。规则新增 `allowUnofficial`、版本化 `platformProfiles`、`invoiceTypes: NORMAL|SPECIAL` 和 `invoiceRequiredFields`。报名新增 `participationType: OFFICIAL|UNOFFICIAL` 与 `organization: {name,shortName,country,icpcId?}`；旧报名默认正式，字段向后兼容。提交锁定资料快照，关键变更使审核、准考证和映射失效。非正式申请必须人工审核。

开票申请包含 `invoiceType`、`titleType: PERSON|ENTERPRISE|ORGANIZATION`、`title`、`taxId`、`amountCents`、`email`、`contactName`、`phone`、`address`、`bankName`、`bankAccount`、`remarks`。企业税号必填、专票只接受单位与税号，额外必填项使用当前竞赛配置；保存申请 `snapshot`。金额受净收款及保留开票金额约束；拒绝须说明原因，实际发票附件受报名权限保护。历史缺项保持历史展示。

### 平台模板与学校映射

| 接口                                                               | 行为                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| GET `/api/v1/integrations/field-templates`                         | 登录后读取 Hydro 5.0.7／DOMjudge 9.0.1 基础字段及填写／生成／管理来源                             |
| GET `/api/v1/integrations/bindings/:id/metadata`                   | 获授权管理员查询目标组织与分组                                                                    |
| GET `/api/v1/integrations/bindings/:id/schools?page=1&pageSize=20` | 按实例、竞赛权限查询待确认／已确认学校                                                            |
| PUT `/api/v1/integrations/bindings/:id/schools/:schoolId`          | `version` 加 `remoteId` 选择已有组织，或 `create:true` 确认新组织；保留全称、简称、国家和 ICPC ID |

绑定新增 `version`、`importMode: FOLLOW|FORCE_UNOFFICIAL`、`includeUnofficial`、`unofficialGroupId`、`nickname`。保存时自动合并所需模板字段。学校未确认返回 `WAITING_ORGANIZATION`；关闭非正式导入返回 `SKIPPED`；缺少非正式分组返回配置待处理状态。新任务固定报名、绑定、实例和学校版本，过期任务不得覆盖最新映射。

## 账号与页面入口

首页 `/` 为独立介绍页，竞赛列表为 `/contests`。竞赛列表和详情页面要求登录，未登录时跳转 `/login?next=原页面`，登录后保留原路径与参数；公开只读竞赛元数据接口保持可读。支持本站邮箱密码与 GitHub 登录，历史通用 OAuth2/OIDC 配置继续停用。GitHub 使用专用接口；旧身份记录保留，旧账号可通过邮箱找回密码恢复，再主动绑定 GitHub。

Hydro / DOMjudge 的联动是报名资格生效后创建独立比赛账号，与本站登录分开。管理员在 `/admin` 的“评测平台”页签配置实例和比赛绑定。修改同类型实例时留空凭据保留原值；新建或更换平台类型必须提供相应凭据，旧版本修改返回 409。

## 系统邮件配置

下列接口均仅供系统管理员使用，写操作检查 CSRF 并支持请求幂等。邮件设置是版本化资源；普通站点接口不包含它。

| 接口                               | 行为                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET `/api/v1/admin/mail`           | 返回主机、端口、连接加密、认证状态、用户名、发件人、版本和来源；只返回 `passwordConfigured`，不返回密码或密文 |
| PUT `/api/v1/admin/mail`           | 使用 `MailSettingsInput` 保存；密码留空保留，关闭认证清除密码。旧版本返回 409                                 |
| POST `/api/v1/admin/mail/probe`    | 正文 `{version}`；检测已保存的连接、加密和认证，失败返回中文 400                                              |
| POST `/api/v1/admin/mail/test`     | 正文 `{version}`；向当前管理员邮箱发送持久化测试任务，返回 `{jobId,to}`，不接收任意目标邮箱                   |
| GET `/api/v1/admin/mail/tests/:id` | 查询邮件测试的状态、尝试次数、中文错误及实际使用的配置版本                                                    |

`security` 为 `TLS`（立即加密）、`STARTTLS`（强制升级加密）或 `NONE`（本地不加密）。密码加密保存，审计不记录认证信息；后台设置覆盖环境初始值，每个邮件任务读取当前配置。测试任务若执行时版本已改变会拒绝发送，避免把过期配置报告为成功。

## 账号与权限邀请

公开注册保留，新增角色均须通过邀请确认。管理员在“用户权限”生成链接，指定已有账号或邮箱，选择账号邀请、系统管理员、竞赛管理员或指导老师；竞赛管理员须指定竞赛。详见 [操作与验收说明](AUTHORIZATION_INVITATIONS.md)。

| 接口                                     | 行为                                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/api/v1/admin/invitations`         | `kind` 为 `ACCOUNT` / `SYSTEM_ADMIN` / `CONTEST_ADMIN` / `COACH_ROLE`，指定 `userId` 或 `targetEmail`；竞赛授权传 `contestId`；`expiresInDays` 默认 7、范围 1–30。返回 `id`、`kind`、一次性展示的 `url`、`expiresAt`，此时无新权限 |
| GET `/api/v1/admin/invitations`          | 系统管理员查看接收者、范围、有效期和 PENDING / ACCEPTED / EXPIRED / REVOKED 状态，不返回令牌或 URL                                                                                                                                 |
| GET `/api/v1/invitations/:token`         | 登录后的指定接收者预览身份与范围，无授权副作用；已确认但权限撤销时 `authorizationActive: false`                                                                                                                                    |
| POST `/api/v1/invitations/:token/accept` | 已验证邮箱的接收者明确确认，同一事务授予身份和记录确认；同账号重试安全，返回 `redirectPath`；旧链接不恢复已撤销权限                                                                                                                |
| DELETE `/api/v1/invitations/:id`         | 系统管理员撤销未确认账号 / 授权邀请；已确认邀请返回 409，需撤销实际角色。成员 / 老师关联邀请沿用原有管理范围                                                                                                                       |
| POST `/api/v1/admin/roles`               | 正向授权兼容入口现在返回邀请 URL；`isAdmin: false` / `isCoach: false` / `contestId` + `grant: false` 立即撤销权限与相应未确认链接。一次只指定一种身份                                                                              |

`POST /auth/register` 与 `POST /auth/resend` 可传受限的 `next: /invite/:token`，邮箱验证邮件带返回路径。前端验证后返回确认页，仍需点击确认；不接受外站返回 URL。`PUT /auth/profile` 不再允许本人改变指导老师身份。

## Token 范围与字段权限

在后台创建 Token 时指定竞赛 UUID、到期时间、scope 与字段；密钥只返回一次，数据库保存 SHA-256 摘要。撤销或过期后立即返回 401。未获授权的竞赛或操作返回 403。

Scopes：`contests:read`、`registrations:read`、`finance:read`、`support:read`、`integration:read`、`integration:write`。

字段示例：`PERSON.name`、`PERSON.email`、`PERSON.school`、`COACH.name`、`COACH.email`、`TEAM.<字段键>`、`REGISTRATION.<字段键>`、`REGISTRATION.organization`、`REGISTRATION.participationType`、`SUPPORT.text`、`SUPPORT.attachments`、`FINANCE.summary`。缺省仅允许 `PERSON.name`；报名的状态、版本和资格始终作为业务元数据返回，组织、参赛性质及自定义资料按明确字段权限过滤；HTTP 查询与 MCP 使用相同权限。

## 联合注册接口 v1

| 方法与路径                                                   | 结果                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| GET `/api/integration/v1/contests`                           | Token 获授权竞赛                                                              |
| GET `/api/integration/v1/registrations?contestId=…&cursor=…` | 已取得资格、按字段权限过滤的 RegistrationEnvelopeV1                           |
| POST `/api/integration/v1/registrations/:id/provision`       | 正文 bindingId，返回持久映射 ID / Job ID                                      |
| GET `/api/integration/v1/jobs/:id`                           | 当前状态与 ProvisioningResultV1                                               |
| POST `/api/integration/v1/registrations/:id/result`          | 正文 bindingId、registrationVersion、result；读取远端核验身份及参赛关联后保存 |

Envelope 包含 schemaVersion、源实例 UUID、报名 UUID / 版本、竞赛、队名、参赛者、老师、表单快照与资格，向后兼容增加可选 `participationType` 和 `organization`。结果包含远端用户 / 队伍 ID、用户名、可选 `verification` 读回详情，以及 TEAM_CREATED、ACCOUNT_CREATED、VERIFIED、FAILED 状态。普通查询不返回 OJ 密码；授权的浏览器账号交付接口单独记录审计。

新适配器实现 `ContestPlatformConnector` 的 probe、provisionRegistration、getProvisioningResult，声明能力；可用 onProgress 持久化阶段结果。callback 不接受客户端单方面声称已验证，必须以本站保存的凭据对远端再次核验；不认识的适配器类型会拒绝执行。

## 签名 Webhook

报名资格事件以事务内 Outbox 发布，事件 ID 在失败重试中保持不变。接收方用创建 Webhook 时返回的 secret 校验：

```text
X-ContestCenter-Event: <event UUID>
X-ContestCenter-Timestamp: <Unix秒>
X-ContestCenter-Signature: sha256=<hex HMAC>
签名输入 = timestamp + "." + 原始HTTP正文
```

使用 HMAC-SHA256 和恒定时间比较，并校验接收时间偏差、按事件 ID 去重。非 2xx 响应保存失败并重试；后台显示任务错误，不将服务凭据放入错误内容。

## 只读 stdio MCP

```json
{
  "mcpServers": {
    "contest-center": {
      "command": "pnpm",
      "args": [
        "--silent",
        "--dir",
        "/absolute/path/Contest_Center",
        "--filter",
        "@contest-center/mcp-adapter",
        "start"
      ],
      "env": {
        "CONTEST_CENTER_URL": "https://contest.example.org",
        "CONTEST_CENTER_TOKEN": "从后台单独创建的查询Token"
      }
    }
  }
}
```

工具为 list_contests、list_registrations（支持 cursor）、get_registration、get_finance_summary、get_support_ticket，调用 `/api/automation/v1`，始终遵守 Token 的 scope、竞赛和字段范围。无报名提交、财务确认或其他写工具。将配置密钥保存于客户端的受控配置中。

## 新版账号、标签与报名审核

`GET /auth/me` 返回 `user.profileComplete`。`PUT /auth/profile` 接收 `{version,name,profile}`；报名要求姓名及 `profile.student_id`、`class_name`、`college` 非空，`gender` 为 `男`、`女`、`其他` 或 `不便透露`。缺项时创建 / 提交报名返回 400，已绑定账号的参赛成员也须完善资料。

| 接口（均以 `/api/v1` 为前缀）     | 行为                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| GET `/auth/providers`             | 公共登录开关；已登录时返回本人 GitHub 绑定状态                    |
| GET `/auth/github?next=/contests` | GitHub 授权开始；一次性 state 与 S256 PKCE，`next` 只接受本站路径 |
| GET `/auth/github?mode=link`      | 当前登录账号主动绑定 GitHub                                       |
| GET `/auth/github/callback`       | 后端交换令牌，查询 GitHub 用户和已验证邮箱，建立本站会话          |
| DELETE `/auth/github`             | 本人解除绑定，要求已设置本站密码，检查 CSRF                       |
| GET / PUT `/admin/github`         | 管理员读取 / 版本化保存开关与凭据，密钥只返回是否已配置           |
| GET `/admin/user-tags`            | 管理员获取已有标签用于筛选和选择                                  |
| PUT `/admin/users/:id/tags`       | 管理员发送 `{version,tags}`，去重后保存，旧版本返回 409           |

用户列表接受 `tag`；报名列表、统计和 CSV 接受 `tag` 并检查管理员管理范围。最多 20 个标签，每个不超过 40 字。

报名新增 `number: number|null`，每个竞赛从 1 开始按首次成功提交分配，`submittedAt` 保留首次提交时间。草稿不编号，并发提交不重号；重新提交、补正和取消不重新编号。历史已提交报名按首次提交的审计时间自动回填，计数器接续最大编号；CSV 首列为报名编号。
