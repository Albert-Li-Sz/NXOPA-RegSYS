# API、Webhook 与 MCP

HTTP 接口说明由实际 NestJS 路由与共享 Zod 契约生成。开发环境的 Swagger 位于 `/api/docs`，JSON 位于 `/api/docs-json`；生产环境关闭这两个入口。源码快照见 [openapi.json](api/openapi.json)，共享类型见 `packages/contracts/src/index.ts`。

```bash
pnpm generate:client
```

此命令生成 `apps/web/src/generated/api.d.ts`。浏览器统一通过 `apps/web/src/api.ts` 处理 CSRF、幂等键、请求合并、身份变化和用户提示；生成类型供契约检查及外部客户端使用。

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
| `/api/v1/integrations`  | 平台字段模板与历史撤权待办                            |
| `/api/v1/admin`         | 用户权限、字段库、站点设置、Token、任务与审计         |

HTTPS 浏览器会话 Cookie 为 `__Host-cc_session`；显式 HTTP 入口使用 `cc_session`。拒绝同名重复 Cookie，HTTPS 不接受旧名字回退。从 `GET /api/v1/auth/me` 获取 CSRF，写操作发送 `X-CSRF-Token`。写入版本化资源时传 `version`；旧版本返回 409。写请求可传 `Idempotency-Key`，同一用户对相同 URL、方法、正文的重试返回原结果；幂等结果和业务写入在一个 PostgreSQL 事务提交，结果静态加密。

所有金额接口继续使用整数分，例如 `feeCents: 12345` 对应界面 123.45 元。核账不能修改凭证申报金额，兼容参数 `amountCents` 若传入必须与申报值一致；确认到账必须有交易参考号，参考号经 NFKC、首尾空白、内部空白及大小写规范化后在活动内不可重复入账，支付渠道不参与去重。同一财务账户的附件内容摘要只能用于一张有效凭证（拒绝后可重新提交），申请人和上传者不能核账自己的凭证；累计退款超过应收费用的后续退款须由不同管理员批准和完成，并记录第二复核人；拒绝退款须填 `reason`。冲正须由原核账人之外的管理员操作。

JSON 请求上限 5 MiB；头像、凭证、普通附件分别在缓冲前限制为 5／10／50 MiB。上传最多每账号并行 2 个、全局 8 个、每账号每分钟 60 次；累计存储默认普通账号 1 GiB、管理员 10 GiB，可通过 `UPLOAD_QUOTA_MB` 覆盖。竞赛后台统计与导出使用完整权限和筛选条件，不随当前页变化。准考证批量下载使用 POST /api/v1/admissions/batch，正文选择 ids 或 registrationIds，单次最多 1000 张；模板预览每账号每分钟最多 10 次。

### 分页与筛选

列表显式传入 `page` 或 `pageSize` 时返回共享 `PageResult<T>`：`{items,total,page,pageSize}`。`page` 从 1 开始、最多 5000，且 `page × pageSize` 不超过 100000；`pageSize` 只接受 20／50／100，默认 20。活动、附件、邮件通知、登录会话、审计、任务、用户、授权邀请、报名、工单和财务历史均支持后端分页；权限与搜索／状态／时间条件同时作用于总数和列表。报名按每个竞赛的首次提交编号升序排列，草稿放在末尾，再按创建时间和 ID 排序。

管理活动列表使用 `GET /contests?all=true&managed=true&page=1&pageSize=20`，仅返回当前管理员有查看权限的活动；`search` 匹配活动标题和赛季。每项额外返回 `registrationCounts: {official,unofficial}`，按有效成员人数而非报名单数统计，范围为有报名编号的已提交或待补正记录，不含草稿、撤回和删除记录。

`GET /files` 接受 `search`（文件名）、`contestId` 或 `registrationId`，分页总数保持原附件权限范围。`GET /notifications/mail?resourceId=…` 按创建时间及 ID 降序合并任务与未派发事件，分页和重发继续检查资源权限，不开放其他用户的通知。

```text
GET /api/v1/admin/audit?page=2&pageSize=50&search=<对象ID>&status=REVIEW
GET /api/v1/registrations?page=1&pageSize=20&contestId=<UUID>&participationType=UNOFFICIAL
GET /api/v1/registrations/:id/finance/invoices?page=1&pageSize=20
```

时间筛选为带时区 ISO `from`／`to`。状态键按列表使用 `status`、`review`、`kind`；完整参数见 OpenAPI。报名可使用 `eligible`、`participationType`、`search`、`tag`，统计与 CSV 接收同样筛选。`GET /registrations/:id?history=false` 返回财务合计但不附带历史数组，历史分别从 `finance/vouchers`、`finance/ledger`、`finance/refunds`、`finance/invoices` 读取。

未显式分页的旧调用继续返回原数组；报名 `cursor=<上一页最后一项ID>` 按报名列表相同顺序、最多 500 条，用于导出和既有集成。`GET /registrations/export?contestId=…` 需要 REGISTRATIONS 权限，每位有效成员一行，成员、队伍、报名及老师的每个当前或历史字段各占一列；多名老师依次编号。费用列只向 FINANCE 管理员开放，以元保留两位小数，仅每份报名第一行填写，避免汇总重复。CSV 使用 UTF-8 BOM、标准引号转义及公式前缀防护，单次最多 10000 位成员、500 列、25 MiB，超出时整次拒绝；导出筛选及数量写入审计。

浏览器写请求在登录前也校验 Origin／Fetch Metadata；自动允许实际同源、环境 `PUBLIC_URL` 和数据库当前公网地址，额外来源由 `TRUSTED_MANAGEMENT_ORIGINS` 显式设置。会话为 HTTPS 时使用 Secure Cookie，SameSite=Lax 保持 OAuth 回跳。幂等结果保留 24 小时；浏览器合并同一份未完成写请求，网络失败后的短期重试沿用原键，成功后的主动新操作使用新键。

### 永久删除、独立财务与审核

`POST /registrations/:id/cancel` 保留原路径，正文为 `{version}`，仅创建者可用；`DELETE /registrations/:id` 正文为 `{version,reason}`，需要该活动的 REGISTRATIONS 权限且原因非空。两者返回 `{deleted:true,registrationId,financeAccountId}`，没有财务数据时 `financeAccountId` 为 `null`。删除后旧报名详情返回 404；旧幂等请求不会重放报名资料快照。

`GET /finance/accounts?role=mine` 返回当前账号的独立财务账户；管理员按 `contestId` 查询需要 FINANCE 权限，均支持分页与活动标题搜索。`GET /finance/accounts/:id` 返回余额、财务策略、单据和 `canEdit/canManage`。账户 ID 沿用原报名 UUID，因此旧 `/registrations/:id/finance/{collection}` 和 `/finance/:id/{vouchers,refunds,invoices}` 接口继续解析；删除后仅创建者与 FINANCE 管理员可访问，报名管理员权限不等同于财务权限。删除不自动退款，不允许向已经删除的报名新增收款凭证，既有待核凭证可继续处理。

财务详情的 `policy` 保留原计费及退款策略，`invoicePolicy` 返回当前活动的开票开关、票种和必填资料，用于开票表单并与提交接口保持一致。财务通知在事务内确定收件人，生成独立邮件事件并链接 `/finance/:id`；删除报名不会取消已排队的财务邮件，删除后新增退款、开票申请仍可正常通知。

上传报名附件及创建关联工单与报名删除共用报名锁，取得锁后重新检查报名和访问权限。财务附件不能从独立工单或其他活动重新绑定；创建、回复工单也不能移动其他活动的私有附件。普通未绑定个人上传仍可用于本人的合法申请。

工单写请求的幂等重放使用与普通工单详情相同的访问校验；撤销 SUPPORT 权限后，即使仍保留 VIEW 等其他活动权限，也不能借相同幂等键读取旧工单响应。

报名详情补充 `displayState`、`actions`、审核历史和最近提交修订。`actions` 包含编辑、本人资料、提交、撤回、取消、管理员删除、首次审核 `review`、修改已有审核 `amendReview`、报名方财务申请 `requestFinance`、查看平台凭据 `credentials`（兼容字段，恒为 false；平台同步已移除），另有 `editReason`；写接口仍重新检查版本与权限。管理编辑不授予代提交、撤回提交或代申请财务的权限；管理员同时是该报名创建者或关联老师时，按其报名方身份保留相应操作。撤回仅用于待审核且未到账报名。个人入口查询显式使用 `role=mine`，不会因管理员身份扩大范围。`review=DRAFT|CORRECTION` 分别筛选草稿与补正，`review=PENDING` 仅包含已提交待审报名。搜索包含活动标题、队名和姓名。

`GET /registrations/review-queue?contestId=…` 沿用当前列表筛选并返回全部匹配已提交报名的 `{ids}`，不受分页限制，默认待审核；仅 REGISTRATIONS 管理员可用。首次审核支持连续处理，已经审核的记录使用独立“修改审核”入口，不进入连续审核操作。审核正文仍为 `{version,decision,reason,participationType?}`，退回、拒绝及修改已有审核必须有原因，PAYMENT_FIRST 只阻止未付清时通过。尚未修改资料的补正记录可直接改为通过或拒绝；报名方已修改但尚未重新提交的资料不能被审核。版本冲突返回 409；客户端保留意见供刷新核对。

独立财务账户的 `canEdit` 表示报名方申请权限，`canManage` 表示 FINANCE 处理权限；管理员不能仅凭管理授权代替报名方上传缴费凭证、申请退款或开票。报名删除后申请权限仅保留给创建者。账簿项补充 `reversed`，已冲正的收款不再展示重复冲正操作；分页、筛选后的记录同样按完整账簿判断。未发放的 READY 准考证需要 ADMISSIONS 权限才能下载，VIEW 权限不能提前下载。

### 活动预设与排考

竞赛配置支持 `examSites: [{id?,name,address,enabled}]`，最多 100 个、名称不能重复。创建时可省略 `id`，修改时保留服务端返回的编号；列表顺序为显示顺序。更新配置省略整个 `examSites` 字段会保留已有考点，传空列表则尝试删除全部考点。已关联报名或考场的考点不可删除，可设为 `enabled:false` 停止新选择；停用不会清除已有选择。

报名保存支持 `examSiteId`（UUID 或 null），不传则保留原选择。未配置考点的活动无需选择；配置考点后提交报名必须选择本活动开放的考点，团队共用一个考点。停用前已提交的选择可保留，尚未提交的草稿须改选。更换考点沿用资料修改与重新提交流程，并清空该报名原座位、撤销旧准考证。报名详情和提交快照包含 `examSite`；管理名单和 CSV 导出支持 `examSiteId` 筛选，CSV 包含考点与地址。

考场保存增加 `examSiteId`，已配置考点时须关联本活动的考点。自动分配、手动排座和 CSV 导入均限制在报名所选考点内；有座位的考场需先清空再更改所属考点。准考证地点优先使用所选考点名称与地址，排座模式额外包含考场地点；考点名称或地址变更会使原准考证失效，需重新生成。

`GET /integrations/revocations` 不传 `contestId` 时仅全局管理员可查询全部待办，包括已删除活动的记录；指定 `contestId` 时仍需该活动的 INTEGRATIONS 权限。活动删除后保留远端目标快照，管理员仍可调用 `POST /integrations/revocations/:id/complete` 登记人工处理结果，删除活动不表示已经在远端撤权。

`DELETE /contests/:id` 正文为 `{version}`，仅系统管理员和高级管理员可调用。仅无报名（含草稿）、无独立财务账户的活动可删除，有关联记录返回 400，版本冲突返回 409，已经删除返回 404；成功返回 `{deleted:true,contestId}`。管理列表和管理员活动详情补充 `deletion: {allowed,reason}`，写接口仍在事务及活动锁内重新检查。删除清理表单版本、考场和平台关联，撤销活动授权、邀请及 Webhook，将共享令牌和平台允许列表中的该活动移除；仅绑定该活动的令牌会被撤销。已有文件改为上传者私有文件，工单解除活动关联继续保留。创建报名、上传活动文件和创建关联工单与删除活动共用活动锁，避免并发留下无归属记录。

活动配置新增 `kind: ACTIVITY|COMPETITION`、`modules: {admissions,rooms,integrations}` 和 `seatingMode: REGISTRATION|PERSON`。新通用活动缺省关闭三个模块，人工审核、免费、个人报名且不关联老师；修改已有活动时保留明确提交的原配置。关闭已启用模块需提交 `confirmModuleChanges:true`，后端同步禁止相关操作，保留排考和字段数据，使相关准考证及本地账号交付失效。

| 方法与路径                                 | 用途                                           |
| ------------------------------------------ | ---------------------------------------------- |
| GET `/contests/:id/rooms`                  | 考场、座位及 `seatingVersion`                  |
| POST `/contests/:id/rooms`                 | 新增名称、可选编号、地点、容量、顺序及启用状态 |
| PUT / DELETE `/contests/:id/rooms/:roomId` | 带考场 `version` 更新或删除                    |
| POST `/contests/:id/seating/preview`       | 按报名 ID 预览自动或明确座位，不写入           |
| POST `/contests/:id/seating/commit`        | 同一请求加预览返回的版本，事务内再次校验并写入 |
| POST `/contests/:id/seating/clear`         | 带 `seatingVersion`，可选 `roomId` 清空        |

以上需要 ADMISSIONS 权限及启用考场。排考请求包含 `registrationIds`、可选 `replace`（默认保留已有座位），手工安排附加 `assignments: [{registrationId,personId?,roomId,seat}]`。提交必须带预览的 `seatingVersion`、`registrationVersions`；容量、重复、跨活动、非资格报名和资料变化会整批拒绝。数据库具有考场／座号及报名／排考单位唯一约束。

考场新增可空的 `code`，创建／更新接受、查询返回。支持字母、数字、下划线和连字符，最多 20 字符；去除首尾空格后转为大写，同活动内非空编号唯一。更新省略 `code` 保留原值，空字符串或 `null` 清空；旧考场迁移后为 `null`，不根据名称推测。编号修改沿用考场 `version`、排考版本及准考证失效流程。

`GET /integrations/revocations?contestId=…` 查询远端撤权待办，`POST /integrations/revocations/:id/complete` 由管理员实际处理远端后标记完成并审计，两者需要 INTEGRATIONS 权限。待办仅保存平台目标和远端编号，不保留报名快照或账号密码。

`GET /automation/v1/finance` 的 `registrations` 与 `receivableCents` 仅计算当前报名；`netReceivedCents` 汇总包括已删除报名在内的独立财务余额，`financialAccounts` 为独立账户数。调用仍需 `finance:read` 和竞赛范围。

### 公网地址、竞赛与发票

`GET /api/v1/site` 返回当前 `publicUrl` 与配置 `version`；系统管理员 `PUT /api/v1/admin/site` 保存新地址并检查版本。地址允许根路径 HTTP／HTTPS；API 与 Worker 动态读取用于生成链接，同时作为浏览器写入的允许来源之一。TLS、域名与访问控制由反向代理负责；登录后的写请求仍检查 CSRF。CLI `pnpm restore:public-url https://reg.example.org` 提供恢复并记录审计。

竞赛新增 `descriptionFormat: TEXT|MARKDOWN`；旧数据保持 `TEXT`。规则新增 `allowUnofficial`、版本化 `platformProfiles`、`invoiceTypes: NORMAL|SPECIAL` 和 `invoiceRequiredFields`。报名新增 `participationType: OFFICIAL|UNOFFICIAL` 与 `organization: {name,shortName,country,icpcId?}`；旧报名默认正式，字段向后兼容。提交锁定资料快照，关键变更使审核、准考证和映射失效。非正式申请必须人工审核。

开票申请包含 `invoiceType`、`titleType: PERSON|ENTERPRISE|ORGANIZATION`、`title`、`taxId`、`amountCents`、`email`、`contactName`、`phone`、`address`、`bankName`、`bankAccount`、`remarks`。企业税号必填、专票只接受单位与税号，额外必填项使用当前竞赛配置；保存申请 `snapshot`。金额受净收款及保留开票金额约束；拒绝须说明原因，实际发票附件受报名权限保护。历史缺项保持历史展示。

### 平台文件导出

POST `/api/v1/contests/:id/platform-exports`，正文 `{platform:"HYDRO"|"DOMJUDGE",includeUnofficial?:boolean,importMode?:"FOLLOW"|"FORCE_UNOFFICIAL",officialGroupId?:string,unofficialGroupId?:string}`。要求当前活动 `INTEGRATIONS` 权限且已启用 `modules.integrations`。响应为 `application/zip`，`Cache-Control:no-store`，不进入幂等结果缓存。

仅导出取得资格的当前报名，两个平台分别保存加密比赛密码；重复、并发导出保持比赛密码稳定。Hydro 的 `teams.json` 为数组，`id` 使用报名 UUID，`name` 使用个人本人／团队队长报名资料中的字符串学号（保留前导零并按 Hydro 规则规范化），`displayName` 为队名／个人姓名，只输出 `members` 数组，`rank` 为布尔值。学号缺失、格式不符或规范化后忽略大小写重名时整包拒绝。`seat` 为考场 `code` 加至少两位座位序号；未排座或未填编号时为 `""`，不回退到人工编号。非空座位冲突或多个成员座位仍拒绝导出，允许多个空座位；凭据 CSV 与 JSON 一致。按每次比赛清空 Hydro 的方式使用，不兼容旧导入账号或跨活动账号复用。

DOMjudge 账号及导出规则保持不变，默认组 ID 与队伍编号／座位使用活动前缀，正式／非正式组不得同名。单次最多 10000 条报名及 50 MB 资料。包内文件及导入步骤见 [INTEGRATIONS.md](INTEGRATIONS.md)。

GET `/api/v1/integrations/field-templates` 保留平台表单模板；内部旧模板 ID 保留以读取历史活动，界面名称为 Hydro 最新版 / DOMjudge 9.x。旧实例、绑定、学校映射、同步、凭据交付和回调接口已移除，返回 404。历史撤权待办可继续处理。

## 首页与登录

首页 `/` 为独立介绍页，竞赛列表为 `/contests`。竞赛列表和详情要求登录，登录后回到原路径。GitHub 专用登录继续可用，旧 OIDC 记录保留但不启用。

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

Scopes：`contests:read`、`registrations:read`、`finance:read`、`support:read`、`integration:read`。

字段示例：`PERSON.name`、`PERSON.email`、`PERSON.school`、`COACH.name`、`COACH.email`、`TEAM.<字段键>`、`REGISTRATION.<字段键>`、`REGISTRATION.organization`、`REGISTRATION.participationType`、`SUPPORT.text`、`SUPPORT.attachments`、`FINANCE.summary`。缺省仅允许 `PERSON.name`；报名的状态、版本和资格始终作为业务元数据返回，组织、参赛性质及自定义资料按明确字段权限过滤；HTTP 查询与 MCP 使用相同权限。

## 只读资格接口 v1

`integration:read` Token 可读取 `/api/integration/v1/contests` 与 `/api/integration/v1/registrations?contestId=…&cursor=…`，后者仅包含合格报名并按字段授权裁剪。保留 RegistrationEnvelopeV1 的源实例、报名、竞赛、人员与资格信息；远端 provision、result、jobs 写入／查询接口随同步功能移除。

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

`GET /auth/me` 返回 `user.profileComplete`。`PUT /auth/profile` 接收 `{version,name,profile}`；学生报名要求姓名及 `profile.student_id`、`class_name`、`college` 非空，`gender` 为 `男` 或 `女`；教师使用 `employee_id`、有效日期 `employed_at`、`college` 和相同的性别选项。缺项时创建 / 提交报名返回 400，已绑定账号的参赛成员也须完善资料。

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

材料分发在事务内按报名编号排序加锁，再锁定附件并核对记录，避免与报名或附件删除并发时创建无效关联；报名已删除或不在该活动内返回 400。报名保存拒绝重复成员编号；提交时工单附件或其他报名专属附件返回 403，即使上传者为当前用户也不能改变其归属。未绑定的本人私有材料仍可作为报名附件。

考场保存仍校验版本；内容完全相同时不递增排考版本或使准考证失效。排考提交比较实际座位变化，仅对发生变化的报名更新座位并撤销旧准考证。

GET `/auth/sessions?page=1&pageSize=20` 返回当前账号尚未过期的登录会话及总数，默认每页 20 条，支持 20／50／100，其他 pageSize 返回 400。旧调用不传分页参数时返回最多 20 条的数组。会话撤销后，页面刷新当前页；最后一页为空时自动回到前一页。

GET `/auth/identity` 保留状态、实名资料和 `requests` 数组结构，返回当前账号的完整审核历史，按创建时间和 ID 降序排列；不再截取最近 20 条。个人中心对该数组使用 20／50／100 项分页，不会包含其他账号的审核记录。

GET `/contests/:id/public-teams` 与 `/export` 不要求登录，按竞赛 publicRosterEnabled、publicRosterReviews 筛选并仅输出公示字段。PUT `/registrations/:id/public-rank` 配置排名。GET `/admin/mail/templates`、PUT `/admin/mail/templates/:key` 设置邮件完整格式；GET `/notifications/mail?resourceId=UUID` 查看投递状态，POST `/notifications/mail/:id/retry` 重发失败业务邮件，均验证资源访问权限。详细操作见 [平台功能说明](PLATFORM_GUIDE.md)。

## v0.6.7 权限与流程补充

报名详情返回 `canReadFinanceDetails`。财务明细、附件及历史需财务授权或本人参与关系，普通查看与报名审核授权只保留费用及净到账摘要。平台文件只描述当前名单，远端账号需手动撤权；历史 RemoteRevocation 待办保留，SUPERSEDED 的历史记录不能重复标记完成。

## v0.8.0 审计修复接口

- `POST /auth/reauth/code` 向当前已验证邮箱发送验证码；`POST /auth/reauth` 接受当前 `password` 或六位 `code`，在当前会话建立五分钟的敏感操作验证。
- `PUT /auth/profile` 的新邮箱写入 `pendingEmail`，经原有 `/auth/verify` 或 `/auth/verify-code` 验证后才切换登录邮箱；`forgot` 和两种密码重置入口只接受已验证的当前邮箱。
- `GET /admin/webhooks?contestId=...` 返回不含 secret 的列表；`PUT /admin/webhooks/:id` 接受 `version`、`enabled`、`rotateSecret`、`revokePrivate`；`DELETE` 同样要求版本。新 secret 只在创建或轮换响应返回。
- API Token 返回 `createdBy`；签发人失去有效 SYSTEM 授权后 Token 不可使用，Token 到期时间不晚于签发人的当前授权到期时间。升级前无法追溯签发人的 Token 自动撤销。私网 Webhook 的审批人须持续具有 SYSTEM 授权，关闭活动外部联动后停止投递。
- `GET /finance/:id/reconciliation` 提供历史疑似重复到账与账簿；完成必要冲正后，通过 `POST` 同路径提交 `reason` 完成对账。仅系统管理员可通过 `POST /finance/:id/attribution` 为缺失来源的历史单据登记 `kind`（vouchers/refunds/invoices）、`recordId`、`createdBy` 和核实说明 `reason`，不能改写已有归属。
- 排考上限 200 份报名；生成上限 100 份，每活动最多 200 个待处理编译任务。批量排考、生成、ZIP、平台导出、认证、上传、邀请、通知及任务重试使用自身状态机处理重试，排除在通用幂等缓存之外。其余已缓存写请求在重放前重新鉴权。
- 外部查询契约声明 `contestId` 和 `cursor`；finance 与 integration 注册列表要求 contestId。令牌为不透明随机值，限流返回真实 HTTP 429。
- VIEW 只允许活动概要；报名个人资料与附件按业务权限或参与关系授权。审计列表及总数使用同一权限过滤，财务、准考证和系统配置事件分别受相应权限约束。
