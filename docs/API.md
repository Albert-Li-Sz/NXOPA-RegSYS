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

列表显式传入 `page` 或 `pageSize` 时返回共享 `PageResult<T>`：`{items,total,page,pageSize}`。`page` 从 1 开始，`pageSize` 只接受 20／50／100，默认 20。活动、附件、邮件通知、登录会话、审计、任务、用户、授权邀请、报名、工单和财务历史均支持后端分页；权限与搜索／状态／时间条件同时作用于总数和列表。报名按每个竞赛的首次提交编号升序排列，草稿放在末尾，再按创建时间和 ID 排序。

管理活动列表使用 `GET /contests?all=true&managed=true&page=1&pageSize=20`，仅返回当前管理员有查看权限的活动；`search` 匹配活动标题和赛季。每项额外返回 `registrationCounts: {official,unofficial}`，按有效成员人数而非报名单数统计，范围为有报名编号的已提交或待补正记录，不含草稿、撤回和删除记录。

`GET /files` 接受 `search`（文件名）、`contestId` 或 `registrationId`，分页总数保持原附件权限范围。`GET /notifications/mail?resourceId=…` 按创建时间及 ID 降序合并任务与未派发事件，分页和重发继续检查资源权限，不开放其他用户的通知。

```text
GET /api/v1/admin/audit?page=2&pageSize=50&search=<对象ID>&status=REVIEW
GET /api/v1/registrations?page=1&pageSize=20&contestId=<UUID>&participationType=UNOFFICIAL
GET /api/v1/registrations/:id/finance/invoices?page=1&pageSize=20
```

时间筛选为带时区 ISO `from`／`to`。状态键按列表使用 `status`、`review`、`kind`；完整参数见 OpenAPI。报名可使用 `eligible`、`participationType`、`search`、`tag`，统计与 CSV 接收同样筛选。`GET /registrations/:id?history=false` 返回财务合计但不附带历史数组，历史分别从 `finance/vouchers`、`finance/ledger`、`finance/refunds`、`finance/invoices` 读取。

未显式分页的旧调用继续返回原数组；报名 `cursor=<上一页最后一项ID>` 按报名列表相同顺序、最多 500 条，用于导出和既有集成。CSV 遍历全部筛选报名，采用 UTF-8 BOM 并转义公式前缀。

### 永久删除、独立财务与审核

`POST /registrations/:id/cancel` 保留原路径，正文为 `{version}`，仅创建者可用；`DELETE /registrations/:id` 正文为 `{version,reason}`，需要该活动的 REGISTRATIONS 权限且原因非空。两者返回 `{deleted:true,registrationId,financeAccountId}`，没有财务数据时 `financeAccountId` 为 `null`。删除后旧报名详情返回 404；旧幂等请求不会重放报名资料快照。

`GET /finance/accounts?role=mine` 返回当前账号的独立财务账户；管理员按 `contestId` 查询需要 FINANCE 权限，均支持分页与活动标题搜索。`GET /finance/accounts/:id` 返回余额、财务策略、单据和 `canEdit/canManage`。账户 ID 沿用原报名 UUID，因此旧 `/registrations/:id/finance/{collection}` 和 `/finance/:id/{vouchers,refunds,invoices}` 接口继续解析；删除后仅创建者与 FINANCE 管理员可访问，报名管理员权限不等同于财务权限。删除不自动退款，不允许向已经删除的报名新增收款凭证，既有待核凭证可继续处理。

报名详情补充 `displayState`、`actions`、审核历史和最近提交修订。`actions` 包含编辑、本人资料、提交、撤回、取消、管理员删除、首次审核 `review`、修改已有审核 `amendReview`、报名方财务申请 `requestFinance`、查看平台凭据 `credentials`，另有 `editReason`；写接口仍重新检查版本与权限。管理编辑不授予代提交、撤回提交或代申请财务的权限；管理员同时是该报名创建者或关联老师时，按其报名方身份保留相应操作。撤回仅用于待审核且未到账报名。个人入口查询显式使用 `role=mine`，不会因管理员身份扩大范围。`review=DRAFT|CORRECTION` 分别筛选草稿与补正，`review=PENDING` 仅包含已提交待审报名。搜索包含活动标题、队名和姓名。

`GET /registrations/review-queue?contestId=…` 沿用当前列表筛选并返回全部匹配已提交报名的 `{ids}`，不受分页限制，默认待审核；仅 REGISTRATIONS 管理员可用。首次审核支持连续处理，已经审核的记录使用独立“修改审核”入口，不进入连续审核操作。审核正文仍为 `{version,decision,reason,participationType?}`，退回、拒绝及修改已有审核必须有原因，PAYMENT_FIRST 只阻止未付清时通过。尚未修改资料的补正记录可直接改为通过或拒绝；报名方已修改但尚未重新提交的资料不能被审核。版本冲突返回 409；客户端保留意见供刷新核对。

独立财务账户的 `canEdit` 表示报名方申请权限，`canManage` 表示 FINANCE 处理权限；管理员不能仅凭管理授权代替报名方上传缴费凭证、申请退款或开票。报名删除后申请权限仅保留给创建者。账簿项补充 `reversed`，已冲正的收款不再展示重复冲正操作；分页、筛选后的记录同样按完整账簿判断。未发放的 READY 准考证需要 ADMISSIONS 权限才能下载，VIEW 权限不能提前下载。

### 活动预设与排考

活动配置新增 `kind: ACTIVITY|COMPETITION`、`modules: {admissions,rooms,integrations}` 和 `seatingMode: REGISTRATION|PERSON`。新通用活动缺省关闭三个模块，人工审核、免费、个人报名且不关联老师；修改已有活动时保留明确提交的原配置。关闭已启用模块需提交 `confirmModuleChanges:true`，后端同步禁止相关操作，保留排考和字段数据，使相关准考证及本地账号交付失效。

| 方法与路径                                 | 用途                                           |
| ------------------------------------------ | ---------------------------------------------- |
| GET `/contests/:id/rooms`                  | 考场、座位及 `seatingVersion`                  |
| POST `/contests/:id/rooms`                 | 新增名称、地点、容量、顺序及启用状态           |
| PUT / DELETE `/contests/:id/rooms/:roomId` | 带考场 `version` 更新或删除                    |
| POST `/contests/:id/seating/preview`       | 按报名 ID 预览自动或明确座位，不写入           |
| POST `/contests/:id/seating/commit`        | 同一请求加预览返回的版本，事务内再次校验并写入 |
| POST `/contests/:id/seating/clear`         | 带 `seatingVersion`，可选 `roomId` 清空        |

以上需要 ADMISSIONS 权限及启用考场。排考请求包含 `registrationIds`、可选 `replace`（默认保留已有座位），手工安排附加 `assignments: [{registrationId,personId?,roomId,seat}]`。提交必须带预览的 `seatingVersion`、`registrationVersions`；容量、重复、跨活动、非资格报名和资料变化会整批拒绝。数据库具有考场／座号及报名／排考单位唯一约束。

`GET /integrations/revocations?contestId=…` 查询远端撤权待办，`POST /integrations/revocations/:id/complete` 由管理员实际处理远端后标记完成并审计，两者需要 INTEGRATIONS 权限。待办仅保存平台目标和远端编号，不保留报名快照或账号密码。

`GET /automation/v1/finance` 的 `registrations` 与 `receivableCents` 仅计算当前报名；`netReceivedCents` 汇总包括已删除报名在内的独立财务余额，`financialAccounts` 为独立账户数。调用仍需 `finance:read` 和竞赛范围。

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

`POST /auth/register/code` 接受邮箱并发送十分钟有效的注册验证码，返回 `token`；`POST /auth/register` 必须提交同一邮箱、`token` 和六位 `code`，验证通过后才创建已验证账号和会话。未验证时不会创建账号。验证码仅能使用一次，重发、过期或五次尝试后不能使用。注册仍公开开放，账号邀请不是必需条件。两接口可传受限的 `next: /invite/:token`，注册后前端返回邀请确认页，仍需点击确认；不接受外站返回 URL。已有账号的 `POST /auth/resend` 仍发送带返回路径的邮箱变更验证链接。`PUT /auth/profile` 不再允许本人改变指导老师身份。

## 飞书登录与活动统计

`GET /auth/providers` 增加 `feishu.enabled`、`feishu.linked`。`GET /auth/feishu?next=…` 发起 OAuth 授权，`mode=link` 将已验证的当前账号主动绑定；`GET /auth/feishu/callback` 校验浏览器 state、单次授权码、PKCE 和当前配置指纹。飞书 v3 令牌和用户信息仅在服务端使用，不持久保存。未绑定身份得到有浏览器 Cookie 约束的十分钟注册 claim，`GET /auth/feishu/signup?claim=…` 读取建议姓名和邮箱；注册接口附加 `feishuClaim`，须同时通过本站邮箱验证码，不按联系邮箱自动合并账号。`DELETE /auth/feishu` 解除绑定。`GET/PUT /admin/feishu` 仅系统管理员可用。

`GET /overview?contestId=…` 返回 `totals`、逐活动 `activities` 和筛选 `choices`，统计限定在公开活动及当前用户获授权活动范围，隐藏活动越权查询返回 403。结果只有汇总数及公开活动字段，不含报名个人资料。

`GET/PUT /admin/mail` 保留主 SMTP 字段，并增加按顺序排列的 `fallbacks`。每个备用包含 `id`、`name`、`enabled` 和 SMTP 连接、认证、发件字段；响应用 `passwordConfigured` 替代密码。`POST /admin/mail/probe` 可附加 `providerId` 单独检测已保存备用。邮件任务结果的 `providerId`、`providerName` 和 `attempts` 记录最终使用的服务器及前序失败。

`POST /admin/mail/templates/:key/test` 提交当前已保存版本 `version`，向当前管理员发送测试邮件；`GET /admin/mail/templates/tests/:id` 查询状态。模板支持条件区块和变量校验，验证类邮件不能停用或删除验证码。版本冲突或格式错误保留客户端草稿。

## 用户详情与账号操作

`GET /admin/students`、`GET /admin/students/:id` 与相同结构的 `/admin/teachers` 支持分页、搜索和参与记录；教师包括指导报名。竞赛管理员的学生与教师视图权限限制到授权竞赛，不能修改账号。

`GET /admin/users/:id` 返回用户详情及 `canEdit` / `canDelete`。`PUT /admin/users/:id` 接受 `version`、`name`、`username`、`email`、`profile`、`tags`，更新实名档案并取消待处理的旧资料申请；邮箱变更会撤销登录并要求重新验证。`PUT /admin/users/:id/ban` 接受 `version`、`banned` 和可选 `reason`，封禁立即撤销会话并禁止密码、GitHub 登录及旧验证链接。系统与高级管理员可编辑、封禁普通账号；高级管理员不能操作全局管理员。

`DELETE /admin/users/:id` 仅系统管理员可调用，正文为 `version` 和 `confirmation: "删除账号"`。释放邮箱和用户名，撤销会话、绑定和授权，保留参赛历史并记录审计。不能通过此接口删除自己，最后一名永久系统管理员不能被停用。

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

报名新增 `number: number|null`，每个竞赛从 1 开始按首次成功提交分配，`submittedAt` 保留首次提交时间。草稿不编号，并发提交不重号；重新提交、补正不重新编号，永久删除后不重复使用原编号。历史已提交报名按首次提交的审计时间自动回填，计数器接续最大编号；CSV 首列为报名编号。

## V0.3 账号、授权、存储和邮件

用户 `kind` 为 STUDENT / TEACHER，`grants` 返回有效管理授权与到期时间；`isAdmin` 为系统管理员或高级管理员的兼容字段，核心设置使用 `isSystemAdmin` 检查。管理员授权 API 为 GET / POST `/admin/grants`、DELETE `/admin/grants/:id`，用户可通过 DELETE `/auth/grants/:id` 卸任。级别 SYSTEM / SENIOR / CONTEST；竞赛授权传 `permissions` 与 `contestId`，可传 `expiresAt`。邀请新增 SENIOR_ADMIN、grantExpiresAt 与 permissions。

GET / POST `/auth/identity`、GET `/admin/identities`、POST `/admin/identities/:id/review` 完成实名审核；GET `/admin/students` 与详情按 STUDENTS 权限筛选竞赛。POST `/auth/verify-code`、`/auth/reset-code` 使用六位验证码，注销通过 POST `/auth/closure-code` 与 DELETE `/auth/account`（confirmation、password 或 code）完成。GET `/admissions/mine` 返回本人的有效已发放准考证。

GET / PUT `/admin/storage`、POST `/admin/storage/test`、POST `/admin/storage/migrate` 配置、实测和迁移存储。POST `/files` 的 purpose 可为 PRIVATE / PERSONAL / AVATAR / TEAM / CONTEST_PUBLIC / CONTEST_PRIVATE，结合 registrationId / contestId / ticketId；GET `/files` 查询，DELETE `/files/:id` 删除，POST `/contests/:id/files/distribute` 分发指定 registrationIds。公开文件 GET `/files/public/:id`，私有文件下载仍校验会话及授权。附件页面中的 PDF 预览通过相同接口读取，使用临时 Blob URL 和 PDF.js 在页面内展示，支持翻页、缩放和加密文档密码输入，不生成额外公开链接，关闭预览后释放临时 URL 和阅读器资源。PDF.js 所需字体、CMap、WASM 和许可随前端构建一并打包。

GET `/auth/sessions?page=1&pageSize=20` 返回当前账号尚未过期的登录会话及总数，默认每页 20 条，支持 20／50／100，其他 pageSize 返回 400。旧调用不传分页参数时返回最多 20 条的数组。会话撤销后，页面刷新当前页；最后一页为空时自动回到前一页。

GET `/auth/identity` 保留状态、实名资料和 `requests` 数组结构，返回当前账号的完整审核历史，按创建时间和 ID 降序排列；不再截取最近 20 条。个人中心对该数组使用 20／50／100 项分页，不会包含其他账号的审核记录。

GET `/contests/:id/public-teams` 与 `/export` 不要求登录，按竞赛 publicRosterEnabled、publicRosterReviews 筛选并仅输出公示字段。PUT `/registrations/:id/public-rank` 配置排名。GET `/admin/mail/templates`、PUT `/admin/mail/templates/:key` 设置邮件完整格式；GET `/notifications/mail?resourceId=UUID` 查看投递状态，POST `/notifications/mail/:id/retry` 重发失败业务邮件，均验证资源访问权限。详细操作见 [平台功能说明](PLATFORM_GUIDE.md)。
