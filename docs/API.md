# 网站内部接口

网站内部 API 使用登录会话及 CSRF 校验，接口说明见开发服务 `/api/docs` 与 `docs/api/openapi.json`。系统不再提供第三方 API Token、Webhook、`/api/automation/v1`、`/api/integration/v1` 或 MCP 接口。GitHub、飞书登录不受影响。

## 报名导出

`GET /api/v1/registrations/export?contestId=<UUID>&format=xlsx|csv&includeCredentials=false`

支持报名列表的筛选参数，忽略分页，要求 REGISTRATIONS 权限。默认接口格式 CSV，页面默认 Excel。账号密码默认不输出；显式开启后，仅输出已取得资格且活动启用账号功能的比赛账号。财务列另要求 FINANCE 权限。响应为文件下载，使用 private/no-store。

## 准考证批次

- `POST /api/v1/contests/:id/admission-batches/preview`：提交 action（GENERATE、RELEASE、DOWNLOAD）、scope（SELECTED + registrationIds，或 FILTERED + filters），以及可选 location、room、seat 生成参数。返回固定报名 ID 和版本的预览标识、总数、可处理数与跳过原因；15 分钟有效。
- `POST /api/v1/contests/:id/admission-batches`：提交 previewId，启动后台任务并返回 jobId、batchId。重复提交同一预览不重复启动。
- `GET /api/v1/jobs/:jobId`：查询进度、逐条结果与下载分包入口，须具有当前活动的准考证权限。
- `GET /api/v1/admission-batches/:batchId/files/:part`：下载 ZIP 分包；重新检查每份文档的当前资格、报名／模板／文档版本及权限，下载包 24 小时有效。

每个批次最多 10000 份报名，每个活动同时处理一个批次。生成任务分批入队。每个 ZIP 最多 1000 份 PDF、源文件合计最多 100 MiB，超出自动拆分。发放仅针对当前版本且已经生成完成的 PDF；重复发放不重复通知。
