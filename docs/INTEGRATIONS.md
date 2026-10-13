# 评测平台接入

本系统在报名取得资格后创建独立比赛账号。本站密码与 OJ 密码分别管理。系统管理员在“管理中心 → 评测平台”保存实例地址、加密凭据和允许使用的竞赛；竞赛管理员仅能配置获授权竞赛的绑定、学校映射与同步，不能读取服务凭据。

详细安装步骤和实际后台截图见[在线配置教程](https://albert-li-sz.github.io/NXOPA-RegSYS/)、[PDF](../output/pdf/configuration-guide.pdf)与[LaTeX 源码](CONFIGURATION_GUIDE.tex)。

## 报名与绑定

选择 Hydro 5.0.7／DOMjudge 9.0.1 的版本化基础模板，自动合并平台必需信息。姓名、队名、联系邮箱、代表学校／单位是参赛者资料；远端 ID、独立用户名、密码由系统生成；域、目标比赛、正式／非正式分组和学校映射由管理员配置。固定映射字段不可改键名或删除，其他信息继续使用自定义字段。

团队代表单位与成员个人学校分别保存。代表单位包括全称、简称、国家 ISO 三位代码和可选 ICPC 编号。DOMjudge 的英文队名、队伍 ICPC 编号、队伍编号／座位、地点为可选基础字段。旧报名保留历史快照，启用模板后提示缺项。

“允许非正式报名”默认关闭；开启后参赛者选择、管理员审核。即使竞赛不要求正式报名人工审核，非正式申请仍必须确认。费用、老师关联、准考证规则保持一致。提交保存参赛性质、组织、人员、表单及费用快照；关键资料变更使原审核、同步映射与准考证失效，重新提交和审核后再同步。

绑定默认“跟随报名性质”并导入两类报名，也可“全部作为非正式参赛”，或关闭非正式报名导入。自动同步在资格生效时触发；手动同步在具体报名的“比赛账号”页执行。配置名称使用中文，任务可查询和重试。

## Hydro 5.0.7：下载与安装

插件 **0.2.0** 在[Pages 下载区](https://albert-li-sz.github.io/NXOPA-RegSYS/#hydro-plugin)提供版本化包、稳定入口和 SHA-256。正式包白名单为 `index.ts`、`package.json`、`README.md`、`LICENSE`，不包含验收辅助插件、密钥或运行数据。

```bash
curl -fLO https://albert-li-sz.github.io/NXOPA-RegSYS/downloads/hydro-contest-center-0.2.0.tgz
curl -fLO https://albert-li-sz.github.io/NXOPA-RegSYS/downloads/hydro-contest-center-0.2.0.tgz.sha256
sha256sum -c hydro-contest-center-0.2.0.tgz.sha256
npm install --prefix /opt/hydro hydro-contest-center-0.2.0.tgz
```

原生部署以 Hydro 实际运行用户安装，向该用户的 `~/.hydro/addon.json` 添加安装后的完整插件路径，保留其他插件，例如：

```json
["@hydrooj/ui-default", "/opt/hydro/node_modules/hydro-contest-center"]
```

给 Hydro **进程环境**配置至少 32 字符随机 Token 和逗号分隔的域白名单。用受保护的环境文件保存，本站实例填写同一个 Token。systemd 的 `EnvironmentFile`／PM2 环境必须作用于实际进程，仅在终端 export 不会更新已经运行的服务。

```dotenv
CONTEST_CENTER_TOKEN=replace_with_at_least_32_random_characters
CONTEST_CENTER_DOMAINS=system,training
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart hydro
# 使用 PM2 时按自己的进程名称执行
pm2 restart hydro --update-env
```

Docker 部署在自己的 Hydro 镜像内安装 tgz，或只读挂载插件目录；修改容器中运行用户的 addon.json，在 Compose 的 environment／受保护环境文件配置变量，再重建或重启对应服务。不要仅修改宿主机 addon.json。

```dockerfile
COPY hydro-contest-center-0.2.0.tgz /tmp/bridge.tgz
RUN npm install --prefix /opt/hydro /tmp/bridge.tgz && rm /tmp/bridge.tgz
```

本站完整示例：实例“社团 Hydro 评测平台”，基址 `https://hydro.example.org`，允许使用指定本站竞赛；绑定域 `training`，比赛 `0123456789abcdef01234567`，跟随报名性质、启用昵称、导入非正式报名。从目标比赛 URL `/d/training/contest/0123456789abcdef01234567` 读取域与 ObjectId，省略默认域时填写 `system`。

探测 `/contest-center/v1/probe` 应返回 Hydro 5.0.7、插件 0.2.0，以及 `nickname`、`unofficial`、`contest_linkage` 能力。旧插件缺失能力会明确提示升级。插件的完整路径为 `/contest-center/v1/provision`、`/contest-center/v1/result`，使用 Bearer Token 与域白名单。

团队队名／个人姓名写入目标域昵称；账号加入域与目标比赛，比赛内设置 `unrank`。重复导入复用用户名和参赛关联，更新昵称与性质并读回核验。Hydro 5.0.7 公开比赛详情的 `tsdoc` 会省略 `unrank`，不能据此判断丢失标记；插件读取实际比赛状态记录，管理员也可在参赛用户管理核对。域昵称显示遵循 Hydro 原有隐私权限。

排查：401／403 检查 Token、域白名单和进程环境；404 检查插件启用和反向代理路径；导入失败检查目标比赛、报名资格和昵称。修改配置后重新发起当前版本任务，旧版本任务不得覆盖新资料。实际验收还须使用交付的账号登录目标比赛。

## DOMjudge 9.0.1：服务账号与比赛

在 DOMjudge 后台创建独立 API 用户，启用账号并授予 `api_reader`、`api_writer`；本站参赛账号固定使用 `team` 角色。原生与 Docker 部署都填写可访问的基址，正式使用反向代理 HTTPS 地址。密码加密保存，编辑同类实例时留空保留。

用 API 服务账号读取外部 ID，避免混用数据库数字主键：

```bash
# curl 会交互询问密码，不把密码写入命令历史
curl --user reg_bridge https://domjudge.example.org/api/contests
curl --user reg_bridge https://domjudge.example.org/api/organizations
curl --user reg_bridge https://domjudge.example.org/api/contests/training-2026/groups
```

完整示例：实例“社团 DOMjudge 评测平台”，基址 `https://domjudge.example.org`；绑定目标 `training-2026`、正式组 `official`、非正式组 `unofficial`，跟随报名性质、导入两类报名。在 DOMjudge 建立正式组排名顺序 0、非正式组排名顺序 1，并让目标比赛允许这两个组。**不同排名顺序分别排名，相同顺序会合并**；仅命名“非正式”不能隔离排名。奖项按比赛和分组在远端配置，非正式组按主办方要求不发正式奖项，本系统不自动更改奖项。参见[官方分组规则](https://github.com/DOMjudge/domjudge/blob/9.0.1/doc/manual/scoring.rst)。

## DOMjudge：学校、队伍、账号的完整关联

1. 参赛者填写代表单位；新学校允许正常提交报名，平台同步暂缓并显示“等待学校确认”。
2. 管理员打开绑定的“学校映射”，选择已有组织，或确认全称、简称、国家（中国 `CHN`）、可选 ICPC 编号并创建组织。`formal_name` 对应全称，`name` 对应简称。确认后恢复已经请求的同步。
3. 创建或更新队伍：中文队名写入 `name`／`display_name`，英文队名与成员姓名合并写入 `public_description`，同时提供 `members`。9.0.1 将这两个输入映射到同一公开说明字段，合并写入可避免成员被覆盖；读取非严格格式的队伍信息核验实际保存值。学校写入 `organization_id`，性质决定 `group_ids`。可选 ICPC ID、编号／座位与地点依据[9.0.1 导入格式](https://github.com/DOMjudge/domjudge/blob/9.0.1/doc/manual/import.rst)。
4. 创建账号并绑定队伍外部 ID，填写队名／姓名和联系人邮箱，固定 `team` 角色。
5. 读回账号、队伍、学校与分组，再使用参赛账号认证 `/api/user` 和 `/api/contests`，确认实际目标比赛访问。

组织写接口 `/api/organizations`；队伍写接口 `/api/contests/:contest/teams`；用户写接口 `/api/users`。JSON 使用 snake_case，例如 `group_ids`、`organization_id`、`display_name`、`team_id`。DOMjudge 9.0.1 单队伍只用一个分组。队伍编号／座位要求全局唯一，冲突会显示占用队伍，不能在不同比赛重复填写同一个编号。

新远端队伍标识按“绑定＋报名”生成，历史映射保留原 ID。重复导入按外部 ID 更新同一队伍，远端创建后响应丢失可恢复。共享历史队伍的跨比赛映射暂停更新并提示管理员处理。该版本账号名称／邮箱自动更新受限；出现差异时明确列出需人工修改的值，在 DOMjudge 用户后台修改后再同步，不将未更新的资料报告为成功。

排查：401／403 检查 API 用户角色与启用状态；学校未确认先完成映射；分组无法参加目标比赛检查比赛允许组、激活时间和队伍所属组；部分失败查看阶段映射和任务原因，修复后按当前版本同步。POST 成功不能代替最终读回与登录验证。

## 版本、恢复与账号交付

任务固定报名、绑定、实例和学校映射版本。Worker 在远端操作前后及持久化阶段均检查版本；过期任务失败且不能覆盖最新映射。数据库 Outbox、确定性用户名与独立密码配合阶段结果记录，支持并发与失败恢复。

个人比赛账号仅向本人及管理员交付；团队共用一个账号，向关联参赛者和获授权老师交付，读取记录审计。本站资格失效后停止交付，标记本地撤销；两个适配器不声明远端自动停用能力，已创建的远端账号需由评测管理员处理。

## 独立真实平台验收

先启动开发服务，运行 `pnpm test:integration`、`pnpm test:enhancements`。两套实例依次启动，数据卷独立；固定 fixture 凭据仅用于 localhost。

```bash
docker compose -f infra/fixtures/domjudge/compose.yaml stop
docker compose -f infra/fixtures/hydro/compose.yaml up -d --build
OJ_TYPE=HYDRO pnpm test:oj
OJ_TYPE=HYDRO pnpm test:oj-enhancements
OJ_TYPE=HYDRO pnpm test:oj-recovery

docker compose -f infra/fixtures/hydro/compose.yaml stop
pnpm fixtures:domjudge
docker compose -f infra/fixtures/domjudge/compose.yaml up -d
OJ_TYPE=DOMJUDGE pnpm test:oj
OJ_TYPE=DOMJUDGE pnpm test:oj-enhancements
OJ_TYPE=DOMJUDGE pnpm test:oj-recovery
```

Hydro 5.0.7／MongoDB 7 使用端口 58888，正式插件包不含创建验收比赛的辅助插件。DOMjudge 9.0.1／MariaDB 10.11.11 使用端口 58901；镜像由官方 9.0.1 发布归档构建，归档 SHA-256 `3d46b31c296581833ac9f8e9b249d929fc28710e834b1cec68723791a2dceb97`，packaging 固定 `396fd5446c53ec9dc6d66208b41915b9cdcd1bc1`。恢复测试通过转发真实 OJ 的 HTTP 请求、丢弃一次远端成功响应，确认自动重试不重复创建用户和队伍。

## GitHub 账号登录

GitHub 登录与比赛平台账号独立。在 GitHub 开发者设置创建 OAuth App，授权回调填写 `https://你的站点/api/v1/auth/github/callback`；管理员在“GitHub 登录”页填 Client ID 和 Client Secret 并启用。代理正确传递 Host 与 X-Forwarded-Proto，回调地址可在后台明确指定。

实现参考 [Auth.js GitHub Provider](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/github.ts)、[GitHub OAuth Web Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) 与 [GitHub 邮箱 API](https://docs.github.com/en/rest/users/emails)。通过后端交换令牌，只使用已验证邮箱，令牌不持久化；state 单次有效并配合 PKCE。同邮箱已有账号先登录再绑定，禁止自动合并。资料完整性由本站维护，GitHub 登录后同样先完善学号、姓名、班级、学院和性别。
