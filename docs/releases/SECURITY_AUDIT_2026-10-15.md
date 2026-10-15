# 安全审计报告 — Contest Center (NXOPA-RegSYS)

- **审计对象**: `/Users/albert_li/data/Code/Contest_Center` @ `8e9fca5` (分支 `codex/activity-workflows`)
- **审计日期**: 2026-10-15
- **审计方式**: 只读代码审计 + 本地只读验证（5 个并行专项子审计 + 主审计员交叉复核）
- **代码规模**: 约 30,700 行 TS/TSX，170 个 API 路由，可执行测试 13 个（单元）
- **未修改任何文件**: 审计前后 `git status --porcelain` 均为 0 行，HEAD 未变

> **重要说明**: 本报告中的所有 "已复核确认" 标记表示主审计员已直接阅读源码或对运行中的开发实例做了只读探测后确认。标记为 "子代理报告" 的条目仅来自子代理，未经独立复核。凡与子代理结论不一致处，本报告以主审计员复核结果为准（见 §8）。

---

## 1. 执行摘要

系统整体工程质量**明显高于同类项目平均水平**：Prisma 参数化查询全覆盖（无一处 SQL 字符串拼接）、零 `child_process` 调用、文件上传做内容嗅探白名单、存储对象名强校验（无路径穿越）、LaTeX 渲染沙箱隔离完善、Vue 前端仅一处 `v-html` 且经 DOMPurify + `html:false` 双重防护、CI 第三方 Action 全部 SHA 锁定、`.env` 从未进入 git 历史。

**但存在 4 个必须优先修复的高危问题**，其中 2 个是完整的资金/账户接管攻击链：

| 类别 | 关键结论 |
|---|---|
| 资金完整性 | **1 名拥有 FINANCE 权限的竞赛管理员可独自把任意金额写入账本再以退款形式提走**（无金额上限、无二次审批） |
| 会话安全 | **登录 CSRF 可强制受害者会话切换**（CSRF 校验在无会话时被跳过） |
| 内网边界 | **Webhook 默认允许访问内网/回环地址**（SSRF 防护默认关闭），可冲数据库、MinIO、云元数据端点 |
| 账号接管 | **高级管理员可直接改写任意普通用户邮箱并触发找回密码，完成接管** |

另有 12 项中危、约 20 项低危/提示项。**未发现**远程未认证代码执行、SQL 注入、命令注入、路径穿越或存储型 XSS。

---

## 2. 风险总览

| 严重程度 | 数量 | 说明 |
|---|---|---|
| Critical | 0 | — |
| **High** | **6** | 见 §3 |
| Medium | 12 | 见 §4 |
| Low | 14 | 见 §5 |
| Nit | 6 | 见 §5 |

---

## 3. 高危问题 (High)

### H-1 · 竞赛管理员可无上限虚增账本并以退款套现

**位置**: `apps/server/src/finance.ts:177`（`amountCents` 覆盖）、`finance.ts:191`、`finance.ts:197-209`、`finance.ts:294`、`apps/server/src/security.ts:43-49`

`cents` 定义为 `z.number().int().positive().max(100_000_000)`（`finance.ts:17`，即 100 万元），而 `confirm()` 允许审核人用它**替换**凭证申报金额：

```ts
// finance.ts:174-177
decision: z.enum(['CONFIRMED', 'REJECTED']),
reason: z.string().max(3000).default(''),
amountCents: cents.optional(),          // 审核人可任意指定

// finance.ts:191
const amount = b.amountCents ?? v.amountCents;
// finance.ts:197-209 —— 直接以该金额入账
amountCents: amount, sourceId: `voucher:${id}`,
await balanceChange(tx, r, amount);
```

`refundDecision` 完成后唯一的金额校验是余额充足（`finance.ts:294`）：

```ts
if (x.amountCents > r.netPaidCents) throw new BadRequestException('余额不足');
```

`requireManager(u, r.contestId, 'FINANCE')`（`finance.ts:186`、`finance.ts:289`）只校验权限，**没有任何"操作人不得为申请人/凭证上传人"的自审检查**（`grep -n "u.id === " finance.ts` 无结果）。

**攻击链（单个拥有 FINANCE 权限的管理员即可完成，无需第二人）**：
1. 为自己名下报名上传一张 0.01 元凭证；
2. `POST /finance/:id/vouchers/:vid/review {decision:'CONFIRMED', amountCents:100000000}` → 净到账 +100 万元；
3. 申请人侧发起退款 → 同一人 `{decision:'APPROVED'}` 再 `{decision:'COMPLETED', reference:'x'}` → 账本支出 100 万元。

**修复**:
- 入账金额必须取自 `voucher.amountCents`；若确实需要人工调整，上限不得超过申报金额，且要求 `isSystemAdmin`；
- 引入**双人复核**：确认金额 ≠ 申报金额、或退款金额超过 `feeCents` 时，必须由不同主体审批（记录 `confirmedBy` 并校验其不等于 `ownerId`/上传人）；
- 审计日志 `VOUCHER_REVIEW` 增加申报金额与实际入账金额的差值字段。

---

### H-2 · 登录 CSRF：无会话时 CSRF 校验被完全跳过

**位置**: `apps/server/src/auth.ts:76-83`（`checkCsrf`）、`auth.ts:103-109`（Cookie 属性）、`apps/server/src/api.ts:330-336`（登录路由）

```ts
// auth.ts:76-83
export async function checkCsrf(req: AuthRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (
    req.sessionId &&                                    // ← 无会话时整个校验被跳过
    !same(String(req.headers['x-csrf-token'] ?? ''), hmac(config.encryptionKey, req.sessionId))
  )
    throw new ForbiddenException('CSRF 校验失败，请刷新页面');
}
```

```ts
// auth.ts:103-109
res.cookie('cc_session', token, { httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: 7 * 86400000, path: '/' });
```

`SameSite=Lax` 允许**跨站顶层 POST** 携带 Cookie，但攻击者无法伪造 `x-csrf-token`（它是 `hmac(key, sessionId)`，攻击者不知道 victim 的 sessionId）。因此攻击者选择**不带 Cookie** 的路径：当受害者当前**未登录**（或攻击者引导其先清除 Cookie）时，跨站表单提交到达服务端时 `req.sessionId` 为 `undefined`，CSRF 检查直接跳过，而 `/api/v1/auth/login` 本身不需要会话。

**攻击**: 攻击者页面自动提交 `<form action="https://host/api/v1/auth/login" method="POST">` 携带攻击者自己的凭据 → 受害者浏览器被静默写入攻击者的 `cc_session`。受害者后续在"自己"的账号里提交的实名信息、身份证件、缴费凭证全部落入攻击者账号。

**修复**（任一即可，建议都做）:
- 对**所有非 GET 请求**校验 `Origin`/`Sec-Fetch-Site`，不依赖会话是否存在；
- `cc_session` 改为 `sameSite: 'strict'`（本项目全部为同源 SPA 请求，风险低）；
- 登录/注册等无会话端点改用一次性 pre-auth token（double-submit）。

---

### H-3 · Webhook SSRF：内网防护默认关闭

**位置**: `apps/server/src/config.ts:18`、`apps/server/src/security.ts:108`、`apps/server/src/integrations.ts:829-837`、`apps/server/src/worker.ts:343-362`

```ts
// config.ts:18 —— 默认 true，即默认不做任何地址检查
allowPrivate: (process.env.ALLOW_PRIVATE_INTEGRATIONS ?? 'true') === 'true',
```

```ts
// security.ts:102-119 —— allowPrivate 为 true 时直接返回，不做任何私网判断
export async function safeUrl(raw: string) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new BadRequestException('仅支持 HTTP(S) 地址');
  if (config.production && u.protocol !== 'https:') throw new BadRequestException('生产环境外部连接需要 HTTPS');
  if (!config.allowPrivate) { /* 仅此时才检查 127./10./192.168./169.254./0./172.16-31./::1/fc/fd/fe80 */ }
  return u;
}
```

```ts
// integrations.ts:829-837
async webhook(u: Principal, body: unknown) {
  const b = z.object({ contestId: z.string().uuid().optional(), url: z.url() }).parse(body);
  if (b.contestId) requireManager(u, b.contestId, 'INTEGRATIONS');   // 竞赛级权限即可
  else requireSystemAdmin(u);
  await safeUrl(b.url);                                              // 默认放行一切地址
  ...
}
```

```ts
// worker.ts:346-361 —— worker 侧再次 safeUrl（同样放行），然后 POST
await safeUrl(hook.url);
const response = await fetch(hook.url, {
  method: 'POST', headers: { 'X-ContestCenter-Signature': `sha256=${signature}`, ... },
  body, redirect: 'error', signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
```

已复核确认：`config.allowPrivate` 默认 `true`（`config.ts:18`），`.env.example:16` 与 `deploy/.env.example:50` 均发布 `ALLOW_PRIVATE_INTEGRATIONS=true`；`deploy/compose.yaml:28-29` 为 api/worker 注入 `host.docker.internal:host-gateway`，因此容器内可直接访问宿主机回环服务。

**影响**: 拥有任一竞赛 `INTEGRATIONS` 权限的管理员可让 worker 从**内网信任边界内部**向任意地址发起 POST，目标可为 `http://postgres:5432/`、`http://minio:9000/`、`http://api:3000/...`、宿主机 `host.docker.internal:<port>` 或云元数据地址（169.254.169.254）。响应状态码会写入 `job.error`（`Webhook HTTP <status>`），构成可用/不可用端口判定。请求体为固定 JSON，不构成数据外泄通道。

**修复**:
- **不要复用** `ALLOW_PRIVATE_INTEGRATIONS` 这个"内网竞赛平台联动"开关来给 Webhook 放行；
- 在 `worker.ts` 投递前对 Webhook URL 使用独立策略：拒绝 RFC1918、回环、链路本地、`host.docker.internal`、以及云元数据网段（不依赖 `allowPrivate`）；
- 或在创建 Webhook 时要求系统管理员审批，并对出站流量做统一出口代理。

---

### H-4 · 高级管理员可改写任意用户邮箱并接管账号

**位置**: `apps/server/src/people.ts:517-611`（`PUT /admin/users/:id` 路径）

`people.ts:520-542` 的校验只阻止编辑持有**活跃 SYSTEM/SENIOR 授权**的目标用户（且要求操作者是系统管理员），但**不限制修改普通用户的 `email`**。修改邮箱后调用 `POST /auth/forgot` 即可把重置链接发到攻击者控制的地址，完成对任意普通用户（含所有学生、教师账号及其报名/缴费数据）的接管。

该操作会写入审计日志，属于"有痕迹但无阻拦"的风险。

**修复**: 修改他人邮箱应要求二次确认（例如同时要求系统管理员 + 目标用户当前邮箱确认，或走独立的邮箱变更审核流程），并对 `PUT /admin/users/:id` 中邮箱变更单独记录高优先级审计事件与告警。

---

### H-5 · 源码部署携带固定管理员口令

**位置**: `apps/server/src/seed.ts:11-12`、`seed.ts:32`

```ts
// seed.ts:11-12
if (config.production || process.env.NODE_ENV !== 'development')
  throw new Error('Demo seed is restricted to NODE_ENV=development');
// seed.ts:32
passwordHash: await hash('DemoContest2026!', { type: argon2id }),
```

已复核确认 guard 要求 `NODE_ENV` **恰好**为 `development`（未设置也会拒绝），且 `deploy/compose.yaml:16` 硬编码 `NODE_ENV: production`，因此**打包发布路径是安全的**。

**残留风险**: `.env.example:1` 发布 `NODE_ENV=development`。任何从源码部署（staging、自托管、CI 演示）保留该值并执行 `pnpm seed` 的环境，都会得到一个**口令公开可查的远程系统管理员**账号 `admin`。

**修复**: seed 增加显式开关（如 `SEED_DEMO=1`），或改为随机生成口令并仅打印一次；同时对非回环 `DATABASE_URL` 直接拒绝执行。

---

### H-6 · 未认证的 argon2id 哈希导致资源耗尽

**位置**: `apps/server/src/auth.ts:323-331`（`consume`）、`api.ts:355-357`（`POST /auth/reset`）

```ts
// auth.ts:323-331
async consume(body: unknown, purpose: string) {
  const b = z.object({
    token: z.string().min(30).max(100),
    password: purpose === 'RESET' ? passwordSchema : z.string().optional(),
  }).parse(body);
  const pw = purpose === 'RESET' ? await hash(b.password!, { type: argon2id }) : undefined;  // ← 先哈希
  return db.$transaction(async (tx) => {
    const record = await tx.emailToken.findUnique({ where: { id: sha(b.token) } });            // ← 后校验 token
    if (!record) throw new BadRequestException('链接已失效');
```

已复核确认：`consume` 在任何 token 校验之前就执行 argon2id（64 MiB 内存 / t=3 / p=4），而 `POST /api/v1/auth/reset` **没有** `rateLimit` 调用——`grep -rn "rateLimit(" apps/server/src/*.ts` 的全部 10 个调用点中不包含 reset（`register-code`/`register`/`login`/`verify`/`forgot`/`close-code`/`email-code`/`feishu-login`/`api`/`mail-retry` 均已限流）。

**攻击**: 伪造 30+ 字符的 `token` + 合法长度的 `password`，即可让服务端做一次 64 MiB 的 argon2id 计算。并发洪泛会占满 Node 的 libuv 线程池（阻塞所有其他登录/改密哈希）、并快速耗尽 `deploy/compose.yaml:132` 的 1 GB 容器内存。

**修复**: 先查 `emailToken`，仅在命中且未过期/未使用时才计算哈希；并为 `/auth/reset`、`/auth/verify` 增加 `rateLimit('reset:'+req.ip, 5)`。

---

## 4. 中危问题 (Medium)

### M-1 · 公网暴露完整 API 文档（已实测确认）

`apps/server/src/main.ts:128` 无条件挂载 `SwaggerModule.setup('api/docs', app, document)`。

**实测**（对运行中的开发实例只读探测）:
```
200  /api/docs          ← Swagger UI 页面
200  /api/docs-json     ← 完整 OpenAPI 规范
     → 170 个 operation，141 个 path，含全部 /admin/* 端点与请求/响应 schema
401  /api/v1/admin/storage   ← 业务端点鉴权本身是正确的
```
Swagger 中间件注册于全局 `main.ts:104` 中间件之前，未受任何鉴权保护。`infra/caddy-gateway/Caddyfile:17` 的 `@api path /api/*` 会把它转发到 API。

**修复**: 用 `if (!config.production)` 包裹（与同文件 `main.ts:129` 对 `openapi.json` 的处理保持一致），或加系统管理员鉴权中间件。

---

### M-2 · 竞赛管理员可导出全量 PII CSV，无权限区分、无审计、无行数上限

**位置**: `apps/server/src/api.ts:499-567`

```ts
// api.ts:505-506
const u = user(r);
requireManager(u, id);            // 默认权限 'VIEW'
```
`manages(u, contestId, 'VIEW')`（`security.ts:37-40`）对任何持有该竞赛授权的管理员都为真——`authorization.ts:121` 在创建 CONTEST 级授权时强制注入 `VIEW`。导出内容包含成员姓名、**邮箱**、`JSON.stringify(p.answers)`（自定义字段，常含学号/身份证/手机号）、`feeCents`、`netPaidCents`（`api.ts:544-562`），且**不写入 audit 事件**、**无行数上限**。

**已复核确认的优点**: CSV 公式注入已防护（`api.ts:513` 对 `= + - @ \t \r` 前缀加 `'`）。

**修复**: 导出要求显式权限（新增 `EXPORT`，或要求 `REGISTRATIONS` + 财务列另需 `FINANCE`）；调用 `audit()` 记录导出人与行数；限制单次导出行数。

---

### M-3 · 凭证重复入账（无唯一约束 + NULL 唯一索引失效）

**位置**: `apps/server/src/finance.ts:139`、`finance.ts:204`、`apps/server/prisma/schema.prisma:342-369`

`PaymentVoucher` **完全没有唯一约束**（`schema.prisma:342-356`），`reference` 为可选（`finance.ts:139`），唯一的数据库护栏是：

```prisma
// schema.prisma:364-369
channelReference String?
@@unique([contestId, channelReference])
```

PostgreSQL 视 NULL 互不相等，因此该唯一索引**对空 reference 完全失效**：

```ts
// finance.ts:204
channelReference: v.reference ? `${v.channel}:${v.reference}` : null,   // reference 省略时写入 NULL
```

**实测确认索引策略**: `apps/server/prisma/migrations/202610110001_initial/migration.sql:537` 创建的是普通唯一索引（非 `NULLS NOT DISTINCT`）。**线上数据佐证**: 对运行中的开发库只读查询 `LedgerEntry` 得 112 行，其中 **88 行的 `channelReference` 为 NULL** —— 即绝大多数账本行不受该唯一索引保护。

**攻击**: 同一张凭证附件可被 `bindFile` 反复绑定到多个凭证（`files.ts:405` 只校验归属，不校验"已用于其他凭证"），或提交两张都不填 `reference` 的凭证 → 管理员确认两次 → `balanceChange` 执行两次 → 净到账翻倍 → 可转为退款。

**修复**: `reference` 对 CONFIRMED 凭证设为必填；为 `PaymentVoucher` 增加 `@@unique([registrationId, attachmentId])`；或建部分唯一索引 `... WHERE kind='PAYMENT' AND amountCents > 0`，并在确认时检查同一附件是否已有 PAYMENT 记录。

---

### M-4 · 幂等机制形同虚设且永不清理

**位置**: `apps/server/src/idempotency.ts:25-34`、`idempotency.ts:96`、`apps/web/src/api.ts:18`、`apps/web/src/request-id.ts:2-10`

```ts
// idempotency.ts:25-34
const key = req.headers['idempotency-key'];
if (req.method === 'GET' || !req.principal || !key || req.path.includes('/auth/') || ...) return next.handle();
```
- 无 `Idempotency-Key` 头时**整个拦截器直接跳过**；
- 而自带前端每次请求都生成**新的随机 UUID**：`'Idempotency-Key': requestId()`，`requestId()` = `crypto.randomUUID()` → 用户双击提交产生两个不同 key，去重永不生效；
- `IdempotencyRecord`（`schema.prisma:580-588`）**没有过期列**，除报名删除外无任何清理逻辑 → 无界增长，且缓存结果可被永久复用。

**已复核确认的安全部分**: 跨用户 key 冲突**不可能**——记录 id 为 `sha(actor.id + ':' + key)`（`idempotency.ts:37`），且重放分支会针对当前 principal 重新鉴权。

**修复**: 对资金/报名类变更路由改为服务端派生 key（`sha(actorId|method|route|规范化body)`）；增加 TTL 清理任务；真正的护栏仍应是操作级唯一约束（见 M-3）。

---

### M-5 · 报名无容量上限，且查重字段为死代码

**位置**: `apps/server/src/registrations.ts:763-773`、`packages/contracts/src/index.ts:249-281`、`schema.prisma:242`

`policySchema` **没有任何容量/名额字段**，`submit()` 因此无可执行对象；系统中唯一的"容量"概念是考场座位数 `ExamRoom.capacity`。

更值得警惕的是防重复机制已失效：`submit` 计算并写入 `uniqueKey`（`registrations.ts:763-773`），但**全仓库无任何读取点**（`grep -rn "uniqueKey"` 仅 4 处，全为写入或置空），且 `RegistrationPerson.uniqueKey` 无 `@@unique`（`schema.prisma:242`）。同一学号可无限次报名。

**修复**: 增加 `policy.capacity` 并在 `submit` 内、复用 `create` 已持有的 `lock(tx, contestId)`（`registrations.ts:574`）做事务内计数；为 `uniqueKey` 建部分唯一索引 `@@unique([contestId, uniqueKey]) WHERE "uniqueKey" IS NOT NULL`。

---

### M-6 · 深层分页 DoS（无业务层限流）

**位置**: `apps/server/src/pagination.ts:7-18`

```ts
const page = z.coerce.number().int().min(1).max(1000000).parse(query.page ?? 1);
return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
```
`GET /api/v1/registrations?page=1000000&pageSize=100` → `OFFSET 99,999,900`，外加一次 `count(*)`。任何已登录用户均可发起，且**业务路由完全没有限流**（`rateLimit` 仅覆盖 auth/mail-retry/feishu/api-token）。

**修复**: 改用游标分页（代码在无 page 参数时已支持），或限制 `page * pageSize <= 100_000`；补充全局限流器。

---

### M-7 · 外部 HTTP 调用被包裹在长事务与咨询锁内

**位置**: `apps/server/src/worker.ts:216-342`、`worker.ts:588-607`

`SYNC` 任务把 `connector(...).provisionRegistration(...)` 放在 `db.$transaction(..., { timeout: 120000 })` 内，同时持有 `lock(sync:…)`、`lock(registrationId)`、`lock(contestId)`。连接器调用**未设置超时**。

**影响**: 远端平台无响应时，一个 worker 槽位会占用数据库连接和这三个咨询锁长达 120 秒；`dispatch()` 每 1.5 秒重投失败任务（`attempts < 4`），远端故障可迅速耗尽连接池并阻塞同一报名上的财务/录取操作。

**修复**: 事务内仅做任务认领；远端 I/O 移出事务；进度用短事务单独持久化；为连接器加超时、并发上限与熔断。

---

### M-8 · 会话 Cookie 的 Secure 标志依赖代理头

**位置**: `apps/server/src/auth.ts:105`、`apps/server/src/main.ts:102`、`apps/server/src/feishu.ts:213`

```ts
secure: req.secure,                       // auth.ts:105
if (config.production) app.getHttpAdapter().getInstance().set('trust proxy', 1);   // main.ts:102
```
在 `REVERSE_PROXY_MODE=external` 下 API 以纯 HTTP 监听 `127.0.0.1:3000`，`req.secure` 完全取决于代理是否转发 `X-Forwarded-Proto`。代理遗漏该头（或链路超过 1 跳）时，7 天有效期的会话 Cookie 会**不带 Secure** 下发，可在明文 HTTP 上传输。

**修复**: 生产环境强制 `secure: true`；或缺失 `X-Forwarded-Proto=https` 时拒绝签发会话。

---

### M-9 · 端口绑定默认值写在环境变量值内部

**位置**: `deploy/compose.yaml:118`（同型：`:56`、`:198`）、`compose.yaml:127`、`deploy/lib.sh:85-95`

```yaml
- '${API_PORT:-127.0.0.1:3000}:3000'      # 默认安全
```
但变量名 `*_PORT` 暗示其值是裸端口。设置 `API_PORT=3000` 会静默变成 `0.0.0.0:3000`，绕过 Caddy 的 TLS 与来源处理直接暴露 API。`ask_port()`（`deploy/lib.sh:85-95`）只校验数字 1-65535，`require_config` 不校验 `host:port` 前缀。

**实测确认的额外暴露面**: 根 `compose.yaml:127`（开发栈）为 `ports: ['${HTTP_PORT:-8080}:80', '${HTTPS_PORT:-8443}:443']`，**无回环前缀，默认绑定 0.0.0.0**。这只影响开发栈，但会与 `main.ts:101-102` 的"API 只接收一跳可信代理"假设冲突。

**修复**: 改为 `'127.0.0.1:${API_PORT:-3000}:3000'`，在 `require_config` 中断言绑定前缀必须是 `127.0.0.1`/`[::1]`。

---

### M-10 · 镜像按可变标签拉取，校验和与制品同源

**位置**: `deploy/compose.images.yaml:4-19`、`install.sh:32-41`、`scripts/package-release.mjs:106-113`

所有服务仅按 `${IMAGE_TAG:-v0.5.1}` 标签固定（`postgres`/`caddy` 例外，已用 `sha256` 摘要）。`install.sh:37-41` 确实执行 SHA-256 校验，但 `SHA256SUMS` 与 tarball **从同一 base URL 获取**，只防损坏不防替换；`NXOPA_GITHUB_PREFIX` 允许第三方镜像加速器成为完全受信来源。仓库**已经**生成可信摘要数据（`scripts/package-release.mjs:106-113` 产出 `images.json`，`scripts/verify-published-images.mjs` 在 CI 中校验），但安装器从不读取。无 cosign/GPG 验证。

**修复**: 发布时按 `images.json` 生成 `compose.digest.yaml` 覆盖文件，用 `image: …@sha256:…` 固定；`compose pull` 后校验 `docker inspect --format '{{index .RepoDigests 0}}'`。

---

### M-11 · `restore.sh` 归档白名单是死代码（已用 bash 复现）

**位置**: `scripts/restore.sh:15-18`

```bash
tar -tzf "$stage/raw.tgz" | while IFS= read -r entry; do
  case "$entry" in database.dump|files.tgz|environment.env) ;; *) echo 'Unexpected backup entry' >&2; exit 1;; esac
done
tar -xzf "$stage/raw.tgz" -C "$stage"
```
`while read` 是管道的最后一级，运行在**子 shell** 中，`exit 1` 只终止子 shell；`set -o pipefail` 也观测不到。子代理已实际复现：异常条目被打印但管道仍返回成功，第 18 行的解压照常执行。含 `../../` 条目的归档可逃逸 `$stage`（位于仓库根目录下），写入调用者可写的任意路径。此外第 23 行以 **root** 身份解压**未校验**的嵌套 `files.tgz`（`--user root --cap-add DAC_OVERRIDE/CHOWN/FOWNER`）。

**前置条件**: 攻击者需持有 `ENCRYPTION_KEY` 才能构造通过 GCM 校验的归档 → 属于"内鬼/损坏备份破坏宿主"，非匿名攻击。

**修复**:
```bash
while IFS= read -r entry; do
  case "$entry" in database.dump|files.tgz|environment.env) ;; *) echo 'Unexpected backup entry' >&2; exit 1;; esac
done < <(tar -tzf "$stage/raw.tgz")
tar --no-same-owner --no-overwrite-dir -xzf "$stage/raw.tgz" -C "$stage"
```
并对嵌套 `files.tgz` 的成员名做同样校验、限制解压后总大小。

---

### M-12 · 报名删除会销毁非财务审计历史

**位置**: `apps/server/src/registration-removal.ts:195-204`、`registration-removal.ts:206-213`

```ts
await tx.auditEvent.deleteMany({ where: { resourceId: r.id,
  NOT: { OR: ['VOUCHER_','PAYMENT_','REFUND_','INVOICE_'].map((p) => ({ action: { startsWith: p } })) } } });
```
`REVIEW`、`REGISTRATION_EDIT`、`SUBMIT`、`WITHDRAW`、`MEMBER_EDIT` 历史被清除 —— 管理员先审核再删除，只留下 `REGISTRATION_DELETE`，审核行为不可追溯。同一处 `registration-removal.ts:209-210` 用同一条件自增两个计数器（`deletedSubmittedCount` 与 `deletedCancelledCount` 都用 `r.submittedAt ? 1 : 0`），导致 `overview.ts:62-63` 的"已取消"统计虚高。

**修复**: 保留审计行或替换为墓碑记录；计数器按 `r.status` 分支。

---

## 5. 低危与提示项

| ID | 严重程度 | 问题 | 位置 |
|---|---|---|---|
| L-1 | low | 账户枚举 + 邮件轰炸：`register/code` 返回"邮箱已注册"，`forgot` 无按账号限流 | `auth.ts:154-190`、`auth.ts:316-322` |
| L-2 | low | 登录仅有按 IP 限流（12/60s），无按账号锁定 | `auth.ts:272-284` |
| L-3 | low | SMTP host/port 未经 `safeUrl`，系统管理员可借 `POST /admin/mail/probe` 探测内网端口（错误信息区分 ETIMEDOUT/ECONNECTION/ETLS） | `mail.ts:73-96`、`packages/contracts/src/index.ts:126` |
| L-4 | low | 管理员提交的 LaTeX 预览任务无速率限制，可占满仅 2 个 worker 槽位，饿死邮件/同步/录取文档任务 | `admissions.ts:219-250`、`worker.ts:34-47,154` |
| L-5 | low | `GET /jobs/:id/download` 返回攻击者自撰 PDF 时未设 `Content-Disposition` 与 `nosniff`，在应用源上内联渲染（对比 `api.ts:736`、`api.ts:823` 的正确做法） | `api.ts:829-836` |
| L-6 | low | 上传先缓冲 50 MB 到内存，之后才按用途限制 5/10/50 MB；`POST /files` 无限流、无用户配额、被幂等拦截器显式豁免 | `api.ts:714-715`、`files.ts:62-64`、`idempotency.ts:25-34` |
| L-7 | low | 重复入账：`restore.sh` 只校验外层 3 个成员名，嵌套归档未校验（与 M-11 同源） | `restore.sh:15-23` |
| L-8 | low | 加密密钥一钥多用：同一 `ENCRYPTION_KEY` 同时用于 AES-256-GCM 与 HMAC（CSRF 令牌、验证码哈希），无 HKDF 派生、无密钥版本 | `security.ts:21-26,94-96`、`auth.ts:80,127` |
| L-9 | low | `encrypt` 输出无 AAD、无版本字节，密文未绑定记录/字段；`decrypt('a.b')` 因 `Buffer.from(undefined,'hex')` 抛 TypeError → 500 而非受控错误 | `security.ts:21-36` |
| L-10 | low | CSRF 令牌是 `hmac(key, sessionId)`、7 天恒定不轮换 | `auth.ts:85,110` |
| L-11 | low | `TRUSTED_MANAGEMENT_ORIGINS` 在 `deploy/.env.example:52`、`deploy/.env` 与配置教程中均有说明，但**全仓库无任何实现代码**（`grep` 仅命中配置与文档） | `deploy/.env.example:52` |
| L-12 | low | finance 历史查询用 `collection in models` 原型链判定，`GET /registrations/:id/finance/constructor` 触发 500 | `finance.ts:95-101` |
| L-13 | low | `files.ts:48` 把未校验的路径参数以 `${id}::uuid` 绑定 → 非 UUID 输入返回 500 而非 400 | `files.ts:46-51` |
| L-14 | low | Postgres/Redis 无内存/pids 限制且缺少日志轮转（其他服务都有 `x-logging` 锚点） | `deploy/compose.yaml:67-99` |
| L-15 | low | Caddy 两处配置均无请求体大小限制与边缘限流；整体无 HSTS/CSP（`grep` 全仓库无 `Strict-Transport-Security`/`Content-Security-Policy`） | `infra/caddy/Caddyfile:1-16`、`infra/caddy-gateway/Caddyfile:9-23` |
| L-16 | low | `initialize` 以 root 且 `cap_drop: []` 运行迁移，持有全部应用密钥 | `deploy/compose.yaml:101-105` |
| N-1 | nit | `same()` 以 `x.length === y.length &&` 短路，泄露长度相等性（6 处调用点均不可利用） | `security.ts:97-101` |
| N-2 | nit | `Content-Disposition` 用 `filename="${d.name}"` 拼接（`d.name` 受 `^[A-Z0-9-]{1,60}$` 约束，当前不可利用；Node 也拒绝头值中的 CR/LF） | `api.ts:823` |
| N-3 | nit | `enqueue()` 先查后建（`db.ts:43-57`），并发重复会以 P2002 中止整个业务事务而非返回已有任务 | `db.ts:43-57` |
| N-4 | nit | `lock()` 用 `pg_advisory_xact_lock(hashtext(id))`，所有逻辑锁共用 32 位命名空间（碰撞只造成过度串行化，不破坏互斥） | `db.ts:28-30` |
| N-5 | nit | CI 与镜像中 `npm install -g pnpm@11.25.0` 无完整性固定；运行时镜像设 `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` | `infra/Dockerfile:3,23,25`、`release.yml:48` |
| N-6 | nit | 无 Dependabot / CodeQL / `pnpm audit` / `SECURITY.md`；`minimumReleaseAgeExclude` 存在但缺 `minimumReleaseAge` | `.github/`、`pnpm-workspace.yaml:5-7` |

---

## 6. 依赖漏洞（`pnpm audit --prod` 实测）

命令 `pnpm audit --prod` 报告 38 条，其中**经由 `plugins/hydro-contest-center` 的可选 peerDependency `hydrooj` 传递**的 34 条（`tar`、`adm-zip`、`ip`、`uuid`、`@tootallnate/once`、`@simplewebauthn/server`）**不属于本应用生产运行时**。

真正落在应用依赖图内的 4 个模块：

| 模块 | 版本 | 可达路径 | 最高严重程度 | 说明 |
|---|---|---|---|---|
| `nodemailer` | 8.0.11 | **直接生产依赖** `apps/server>nodemailer` | high | 8 条公告（`<=10.0.5` 区间），修复版本 9.1.0 / 10.0.6+，而声明范围是 `^8.0.0` → **依赖解析永远无法修复** |
| `js-yaml` | 5.3.0 | `@nestjs/swagger>js-yaml` | moderate | 应用代码未直接使用（`grep` 无命中），仅供 Swagger 内部 |
| `deepmerge-ts` | 7.1.5 | `@prisma/client>prisma>@prisma/config>deepmerge-ts` | high | 仅经 `prisma` CLI 可达；`@prisma/client` 的 dependencies 只有 `client-runtime-utils`，`prisma` 是 peerDependency → **dev 工具链** |
| `mysql2` | 3.15.3 | `@prisma/client>prisma>mysql2` | high | 同上，dev 工具链 |

**实际可达性评估（已复核）**: nodemailer 的高危公告涉及 `message.raw`/`resolveContent` 文件访问绕过与 addressparser 的 O(n²) 复杂度。本应用**未使用** `raw`/`resolveContent`；所有收件人地址都来自数据库中的用户邮箱（写入时经 `z.email()` 校验，`auth.ts:156,195,318`、`people.ts:523`）并受 `z.email()` 长度上限约束，无法构造触发 O(n²) 所需的长地址列表。因此**当前不可利用**，但属必须处理的依赖债（若将来引入多收件人或地址列表拼接即变成真实漏洞）。

**修复**: 将 `nodemailer` 升级到 `^9.1.0`（或 10.0.9+）；把 `prisma` CLI 明确留在 devDependencies 并确认生产镜像不含它；对安全相关包改用精确版本。

---

## 7. 审计中发现的安全资产（已验证无问题）

以下为**逐项阅读源码后确认安全**的部分，供维护者了解无需返工的区域：

**注入类**
- SQL：全部 8 处原生 SQL 均为参数化 tagged template（`admin.ts:66-68`、`api.ts:307`、`mail-delivery.ts:41-46`、`contest-removal.ts:67-73`、`files.ts:46-51`、`db.ts:29`、`registration-removal.ts:84-91`）；全仓库无 `$queryRawUnsafe`/`$executeRawUnsafe`/`Prisma.raw`，无字符串拼接 SQL。
- 命令执行：`apps/server/src`、`apps/web/src`、`packages/*/src` 中**零** `child_process`/`exec`/`spawn`。
- 路径穿越：存储对象名强制 `^[A-Za-z0-9_-]{1,200}$`（`storage.ts:76-80`）且用 `randomUUID()`；spool 用 DB job UUID；`SPOOL_DELETE` 校验 `^[a-f0-9-]{36}$`；没有任何 `req.params`/`originalname` 进入文件系统路径。
- 邮件头注入：`renderMailTemplate` 剥离主题中的 `[\r\n]`（`packages/contracts/src/mail-template.ts:202`）；`fromName` 拒绝 CRLF（`index.ts:138-141`）；收件人经 `z.email()`。
- 模板注入：自定义模板引擎限制 tag 为 `^[a-zA-Z_][\w.]*$`，屏蔽 `__proto__/constructor/prototype`，拒绝 `{{{`，取值走 `Object.hasOwn`，所有值经 `texEscape`（`templates.ts:2-19,36,47-49,65`）。

**上传与文件服务**
- 服务端内容嗅探白名单（PDF/PNG/JPEG/纯文本/ZIP），头像仅限 PNG/JPEG（`files.ts:104-123`）；文件名剥离目录成分、CR/LF/NUL 并截断 200 字符（`files.ts:33-44`）。
- `/files/:id` 恒定 `attachment` + `nosniff`；`/files/public/:id` 仅当**服务端嗅探**出 `image/*` 时才 `inline`，且带 `nosniff` → HTML/SVG 无法被当作 HTML 执行，不存在存储型 XSS。
- 文件读取的五级授权矩阵（工单/报名/财务/竞赛管理员/所有者）完整（`files.ts:179-220`）。
- 归档：唯一创建点 `sendBatch` 的条目名来自 `admissionDocument.number`（`^[A-Z0-9-]{1,60}$`）→ 无 zip-slip；上传的 ZIP 从不被解压（全仓库无 unzip/adm-zip/yauzl 调用）。

**前端**
- 全应用仅一处 `v-html`（`MarkdownContent.vue:16`），输入经 `markdown-it({html:false})` + `DOMPurify.sanitize({USE_PROFILES:{html:true}, FORBID_TAGS:[...], FORBID_ATTR:['style']})` 双重处理；邮件模板预览用 DOMPurify + `<iframe sandbox="">`。
- 无 `innerHTML`/`eval`/`new Function`/`document.write`；localStorage 仅存 `page-size:*` 整数，会话为 httpOnly Cookie。
- 开放重定向已防护：`githubReturnPath` `/^\/(?!\/)[^\\\r\n]*$/` 同时用于两个 OAuth 流程与前端（`github.ts:60-64`）。

**鉴权模型**
- **未发现 IDOR**：逐条追踪 api.ts 全部 170 个路由到其服务方法，确认每个资源 id 都有对应守卫（`getRegistration`/`canRead`/`canEdit`/`getFinance`/`getSupportTicket`/`requireManager`/`apiContest`/`requireAdmin`）。
- **未发现越权提权**：`AdminGrant` 是唯一权限来源且每请求重算（撤销即时生效，`attachPrincipal` → `effectiveAuthorization`）；`POST /admin/grants` 在事务内**重新校验** `requireSystemAdmin`（`authorization.ts:100,108`）；`ensurePermanentAdministrator` 防止撤销最后一名系统管理员；`PUT /admin/users/:id` 完全不接受 `isAdmin`/grants 字段；遗留的 `User.isAdmin` 列**从未被读取用于鉴权**（仅显示与写入），`RoleAssignment` 从未被读取。
- **未发现批量赋值**：所有 Prisma 写入均由已解析的字段白名单 schema 驱动；用户可控 body 无法设置 `review`/`eligible`/`netPaidCents`/`isAdmin`/`tags`/`kind`/座位。
- **座位分配无超额**：`commit` 排序后逐把锁、事务内重读、`SeatAssignment` 带 `@@unique([roomId,seat])` + `@@unique([registrationId,unitKey])`，跨事务竞争只能以 P2002 失败。
- **金额余额完整性**：`balanceChange` 在同一事务内更新账户与报名；所有减记路径都先检查余额；`reverse` 由 `sourceId @unique` + 前置 `findUnique` 双重防重放。

**基础设施与供应链**
- 无 `privileged: true`、无 `docker.sock` 挂载、无 `network_mode: host`；latex 容器为 `network_mode: none` + `read_only` + `cap_drop ALL` + `pids_limit 64`，以每任务独立 UID 运行 `xelatex -no-shell-escape`（`openin_any=p`/`openout_any=p` + RLIMIT）→ `\write18`/`\input` RCE 不可达。
- 发布 compose 中 postgres/redis/minio 不发布任何宿主端口，`data`/`edge` 网络为 `internal: true`；`contest_local_only` 无法进入打包部署（两处 compose 均用 `${POSTGRES_PASSWORD:?…}` 硬失败）。
- `install.sh` 设 `umask 077`、`deploy/.env` 为 0600、解压前拒绝符号链接与 `../`、拒绝覆盖既有 `.env`、`init_env` 用 `openssl rand -hex 32` + `set -o noclobber` 且从不重新生成密钥；无 `curl -k`/`--insecure`/`NODE_TLS_REJECT_UNAUTHORIZED`。
- 备份加密正确：AES-256-GCM + magic 作 AAD + 认证标签校验，输出 0600（`scripts/archive-crypto.ts:10-40`）。
- **Git 历史干净**：对全部 1,592 个可达对象与 4 个悬空 blob 做内容扫描，**从未提交过任何凭据**；`.env` 从未被 add（仅 `.env.example` 曾存在）；命中的 33 个 blob 全部是 `GENERATE_ON_INSTALL`/`GENERATE_WITH_PNPM_SETUP` 等占位符。
- CI 全部第三方 Action 按 commit SHA 固定；触发条件仅 tag push / main push / `workflow_dispatch`，**无 `pull_request`/`pull_request_target`** → 无 fork 泄密面；`run:` 步骤中零 `${{ }}` 插值；仅使用 job 级 `GITHUB_TOKEN`，仓库不存在 registry 发布凭据。
- 8 个 package.json 均无 `preinstall`/`postinstall`/`prepare` 钩子；`allowBuilds` 为显式白名单且屏蔽 `@scarf/scarf` 遥测。
- MCP 适配器为 stdio-only（`StdioServerTransport`，`apps/mcp-adapter/src/main.ts:53`），不监听套接字，强制要求 `CONTEST_CENTER_TOKEN`。

---

## 8. 对子代理结论的修正（主审计员复核）

审计过程中主审计员对子代理的结论做了独立复核，以下三处**修正或限定**：

1. **`X-Forwarded-For` 限流绕过（子代理判为 high，据其在 `deploy/nginx.conf.example:20` 与 `main.ts:102`）**
   **修正为 medium 且需特定拓扑**。子代理的推理有误：Caddy 的 `reverse_proxy` **无条件重写** `X-Forwarded-For` 为 `{http.request.remote.host}`（解析后的真实客户端 IP），**不会追加**客户端提供的头。因此在使用官方 Caddy 入口的部署中，客户端伪造的 XFF 会被丢弃，`trust proxy 1` 取到的正是真实 IP。
   只有当运维按 `deploy/README.md:52-64` 的**双层代理**方案部署、且外层 Nginx 使用 `$proxy_add_x_forwarded_for` 时，Caddy 的 `trusted_proxies static private_ranges` + `trusted_proxies_strict`（`infra/caddy-gateway/Caddyfile:4-5`）会把私网对端视为可信，从而取用 XFF 链中最左端的**攻击者可控**地址 → 该拓扑下限流确实可绕过。
   **实测佐证**: 对运行中的开发实例注入 `X-Forwarded-For: 198.51.100.77` 后，Redis 中限流键仍为 `rate:login:127.0.0.1`，未生成按伪造 IP 的新桶（该实例 `NODE_ENV=development`，未启用 `trust proxy`，故与生产行为不同，仅说明键的派生方式）。
   **建议**: 无论何种拓扑，`deploy/nginx.conf.example:20` 与 `deploy/README.md:60` 都应改为 `proxy_set_header X-Forwarded-For $remote_addr;`。

2. **Swagger 暴露（子代理判为 needs-runtime-check）**
   **已实测确认**：`/api/docs` 与 `/api/docs-json` 均返回 200 且无需认证，暴露 170 个 operation / 141 个 path，含全部 `/admin/*` 端点与 schema。子代理对 Caddy `@api path /api/*` 是否匹配 `/api/docs` 的疑问不影响结论——`/api/docs` 以子路径形式命中该匹配器。

3. **nodemailer CVE 可达性（子代理判为 medium / 可达性存疑）**
   **限定为当前不可利用的依赖债**：确认版本确为 `8.0.11` 且 `^8.0.0` 无法解析到修复版本（属实），但逐一核对全部邮件发送调用点后确认：所有收件人均来自数据库中的用户邮箱（写入路径经 `z.email()`），应用未使用 `message.raw` 或 `resolveContent()`，无法构造触发 O(n²) 复杂度所需的长地址列表。因此不应按"可被利用的高危漏洞"排期，但仍需升级。

此外，`sync`/`worker` 相关与 `finance` 相关的所有 High/Medium 结论，主审计员均已直接阅读源码复核（见 §3、§4 各条的"已复核确认"标注）。

---

## 9. 建议修复顺序

**第一批（本周内，均为高危且改动小）**
1. **H-1** 资金：`confirm` 入账金额改为取自凭证；金额不一致或超额退款强制第二审批人。
2. **H-2** CSRF：非 GET 请求一律校验 `Origin`/`Sec-Fetch-Site`；`cc_session` 改 `sameSite:'strict'`。
3. **H-6** 先校验 token 再哈希；给 `/auth/reset` 加限流。
4. **M-1** 用 `if (!config.production)` 包裹 Swagger 挂载。

**第二批（本月内）**
5. **H-3** Webhook 独立地址策略（不复用 `ALLOW_PRIVATE_INTEGRATIONS`）+ 出口代理/审批。
6. **H-4** 他人邮箱变更走独立审核 + 告警。
7. **M-3** `reference` 必填 + `PaymentVoucher` 唯一约束；修补 `LedgerEntry` 的 NULL 唯一索引。
8. **M-2** 导出权限收紧（`EXPORT`）+ 审计 + 行数上限。
9. **M-5** 增加 `policy.capacity` 并在事务内计数；为 `uniqueKey` 建部分唯一索引。
10. **M-6** 分页改为游标或限制 `page*pageSize`；补全局限流。
11. **M-8/M-9** 生产强制 `secure` Cookie；端口绑定默认值改为 `127.0.0.1:` 前缀。

**第三批（下个迭代）**
12. **M-7** worker 长事务重构（外部 I/O 移出事务 + 连接器超时/熔断）。
13. **M-10** 镜像按摘要固定 + cosign 验证。
14. **M-11** `restore.sh` 白名单改为进程替换并校验嵌套归档。
15. **M-12** 保留审计历史；修正计数器。
16. **H-5** seed 增加显式开关或随机口令。
17. 依赖升级：`nodemailer` → `^9.1.0`；`js-yaml` 随 `@nestjs/swagger` 更新。
18. **L-8/L-9** 用 HKDF 派生 `enc`/`csrf`/`otp` 子密钥，密文加版本字节与 AAD。
19. 运维：补 HSTS/CSP、Caddy 请求体上限与边缘限流、Dependabot/CodeQL、`SECURITY.md`。

---

## 10. 附录：审计方法与覆盖范围

**方法**
- 5 个并行专项子审计：① 认证/会话/授权/提权 ② 注入/SSRF/上传/归档/XSS ③ 密钥/依赖/供应链/CI ④ 基础设施/容器/网络/安装器 ⑤ 资金与容量并发/幂等。
- 主审计员独立复核：直接阅读全部 High/Medium 结论对应的源码；对本地运行中的开发实例（`NODE_ENV=development`，API 127.0.0.1:3000，Postgres 127.0.0.1:55432，Redis 127.0.0.1:56379）执行**只读** HTTP GET 探测、Redis `--scan` 键查询、Postgres `SELECT count(*)` 查询。
- 自动化检查：`pnpm typecheck`（6 个 workspace 项目全部通过）、`pnpm test`（13/13 通过）、`pnpm audit --prod`（38 条，可达性逐一分类）、git 对象级历史扫描。
- 未执行：`pnpm seed`、`db:migrate`、任何集成/E2E/负载测试（会变更数据库与 `.runtime/` 状态）、`docker compose up/down`。

**已知局限**
- 未做动态渗透测试、并发压力测试与真实浏览器利用验证；§3/§4 中的并发与 TOCTOU 结论为静态分析结论（子代理已标注 `needs-runtime-check` 的条目见对应发现）。
- 未审计外部服务（Hydro OJ、DOMjudge、飞书、GitHub）自身的安全性。
- 未枚举第三方基础镜像（`node:24.12.0-bookworm-slim`、`postgres:17.6-alpine`、`redis:7.4.5-alpine`、`caddy:2.10.2-alpine`）的 CVE 状态。
- **单元测试覆盖严重不足**：`tests/unit` 仅 3 个文件 13 个用例，未覆盖 auth/finance/authorization 任何安全关键路径；资金与鉴权逻辑仅靠 `tests/integrations/*` 在完整栈上验证。建议为 H-1、M-3、M-5、H-2 的修复补充针对性回归测试。

**审计过程副作用声明**
- 子代理③执行 `git fsck --lost-found` 时在 `.git/lost-found/` 生成了 23 个悬空对象，该目录**已删除**；`git status --porcelain` 为 0 行，HEAD 未变，工作树与索引未受影响（主审计员已复核）。
- 本报告为本次审计唯一新增文件。
