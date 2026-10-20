# 评测平台导入文件

从 v0.7.1 起，本站移除 Hydro / DOMjudge 实例、服务凭据、比赛绑定、远端学校映射、自动同步、同步重试和回调。管理员使用“平台导出中心”或“活动管理 → 平台文件导出”下载 ZIP，在目标平台手动导入。无需给本站提供 OJ 管理员密码或安装本站桥接插件。

## 生成导入包

活动设置开启“平台文件导出”，平台基础字段模板选择 Hydro 最新版或 DOMjudge 9.x。模板收集代表单位、成员和可选平台字段；已有报名缺少完整代表单位时，补正、提交并重新审核。代表单位与成员个人学校分开保存。

导出权限为该活动的 `INTEGRATIONS`。系统仅导出已取得参赛资格的报名，草稿、未通过审核、费用未完成、取消的记录不进入文件。可排除非正式报名，也可把本次全部队伍设为非正式。后续新增或变更报名需重新导出、导入。

ZIP 包包含 `teams.json`、`credentials.csv` 和 `README.txt`；DOMjudge 另外包含 `groups.json`、`organizations.json`、`accounts.json`。同一报名、同一平台复用账号和密码，密码在数据库中加密保存，比赛凭据与本站登录独立。JSON 直接序列化，不经过 Excel / pandas，队名为 `NULL`、中文、空的第二／第三成员都能保留。导出的凭据表含明文密码，请仅交给评测管理员并妥善分发。

一个报名对应一个平台队伍和一个比赛账号。已分配一个座位时使用“考场名-座位号”，否则使用可选队伍编号／座位，再缺省时使用报名编号；加活动前缀后写入目标平台，避免跨比赛座位重名。同一活动座位重复或一个团队分配了多个个人座位时会拒绝导出，请先统一平台队伍使用的座位。

## Hydro 最新版：Onsite Toolkit JSON

导入方式依据[XCPC 校赛筹办指南的 Onsite Toolkit 章节](https://www.cnblogs.com/zerc/p/-/cpc#extra-fields)，并核对[Hydro 官方文档](https://docs.hydro.ac/zh/docs/Hydro)与[当前 Onsite Toolkit 源码](https://github.com/hydro-dev/Hydro/blob/master/packages/onsite-toolkit/index.ts)。2026-10-21 npm 发布版本为 Hydro 5.0.7、Onsite Toolkit 0.1.1；仅维护当前最新版，不再维护本站旧桥接插件。

以实际运行 Hydro 的用户安装并注册官方插件：

```bash
yarn global add @hydrooj/onsite-toolkit@latest
hydrooj addon add @hydrooj/onsite-toolkit
pm2 restart hydrooj
```

使用 systemd 或容器部署时，重启实际服务。操作用户、全局 Node 模块与 `~/.hydro/addon.json` 必须对应同一 Hydro 环境；容器内安装、注册，导入文件也需进入容器。在控制面板 → 配置管理开启 Onsite Toolkit 的 `extraFields`、`contestMode`；仅在需要机房 IP 自动登录时开启 `ipLogin`。

将 ZIP 解压并上传 `teams.json`。从比赛地址取得 24 位 ObjectId，例如 `/d/training/contest/0123456789abcdef01234567` 中的域为 `training`。**不要把本站活动 UUID 或比赛标题当作 Hydro ObjectId**。

```bash
# 参数依次是 JSON 路径、比赛 ObjectId、头像扩展名、域 ID
hydrooj cli system onsiteImport /srv/import/teams.json 0123456789abcdef01234567 webp training
# 默认域也可明确填写 system；多个比赛使用同域的逗号分隔 ObjectId
hydrooj cli system onsiteImport /srv/import/teams.json 0123456789abcdef01234567,1123456789abcdef01234567 webp system
```

以当前插件的四参数实现为准，避免照抄早期文章的三参数示例；不要在单个比赛 ID 后附加多余逗号。导入会创建／复用 `${id}@onsite.local` 对应用户，加入域和比赛，并通过 `rank` 设置是否计入正式排名。`name` 是唯一登录名，`displayName` 保留队名／姓名。`members` 只含真实成员，`coach` 为指导老师，`school` 为代表单位，`seat` 为带活动前缀的唯一座位。

已知问题与检查：

- 用户名和座位具有全局唯一性，多个比赛不要重复使用人工姓名或不带前缀的 A01。本系统生成带可读姓名／队名片段的唯一账号，复用包内 ID，勿随意改动。
- 当前插件在重导时会用文件中的 `password` 重设已存在账号密码。本站重复导出保持密码不变；远端自行改过密码后，先决定是否要覆盖。不要用会重算随机值的 Excel 公式维护比赛密码。
- 部分 XCPCIO / CCS 榜单只显示 `name`，忽略 `displayName`。本系统的 name 包含可读姓名／队名片段和唯一后缀；赛前仍需实际检查目标榜单。不要为显示昵称开放所有私人资料权限。
- `contestMode` 会限制账号功能；最新实现还会限制到导入的域。导入后实际登录检查域、比赛参赛关联、正式／非正式标记和成员资料。
- 需要 IP 登录时，用无表头的 `seat,ip` CSV，seat 必须逐字匹配导出的完整座位。运行 `hydrooj cli system setIpLogin /srv/import/seats.csv`。不支持带逗号的座位或 CSV 引号转义。
- IP 登录映射只增改，不会随名单减少自动删除；缓存也可能短暂保留旧值。使用 IP 登录前核对代理传递的真实客户端 IP，赛后手动清理旧映射并重新验证。
- 学校头像路径按学校名去除空格和中文括号生成，头像不存在不代表账号导入失败。头像扩展名参数应与实际文件一致。
- 使用 CCS 时，最终变更名单／题目后再重置、初始化 CCS。单题总时限、SPJ、CRLF/LF、外榜、打印与滚榜问题属于赛前平台验收，应按原文及官方现场赛指南另行检查。

## DOMjudge 9.x：队伍与用户导入

参照[官方文档入口](https://www.domjudge.org/documentation)及[9.0.1 官方批量导入格式](https://github.com/DOMjudge/domjudge/blob/9.0.1/doc/manual/import.rst)。使用管理员的 **Import / export → Import JSON / YAML**，解压后按以下顺序逐个选择类型和文件：

| 顺序 | 类型          | 文件               | 作用                                                |
| ---- | ------------- | ------------------ | --------------------------------------------------- |
| 1    | groups        | groups.json        | 正式和非正式分组，默认 sortorder 分别为 0、1        |
| 2    | organizations | organizations.json | 代表单位，含简称、全称和 ISO 三位国家代码           |
| 3    | teams         | teams.json         | 队伍外部 ID、组 ID、学校 ID、名称、成员、座位与地点 |
| 4    | accounts      | accounts.json      | 用户名、密码、type=team、team_id                    |

**用户文件的导入类型是 accounts，不是 users**。DOMjudge 文档中的 accounts.yaml 同样允许 accounts.json。不要把注册用户 JSON 接口、旧 accounts.tsv 或团队导入页面混用。`team_id` 对应 `teams.json` 的外部 `id`，不是 DOMjudge 数据库数字主键；`group_ids` 只包含一个分组。本系统分别生成稳定 ID 并保持关联。

如果已有分组，导出时可填写其外部 ID；导入 groups.json 会更新对应分组，请核对名称和排名顺序。相同 sortorder 会合并排名，仅给非正式组改名字不能隔离排名。完成导入后，在目标比赛设置中允许对应组参赛，核对激活时间、比赛时间、正式奖项设置；导入队伍与用户本身不自动创建比赛或授予比赛准入。

组织全称写入 formal_name，简称写入 name；成员和可选英文队名合并写入 members，避免与同一内部字段的 public_description 相互覆盖。队伍编号／座位带活动前缀，满足全局唯一性。相同代表单位的国家、简称和 ICPC 编号应一致，系统不会擅自合并冲突信息。

重复导入队伍按外部 ID 更新；9.x 账号导入对已存在的用户名／ID可能跳过或拒绝更新。修改密码、名称、队伍关联时必须查看导入结果，并在 Users 管理页核对或手动修改。使用导出的 team 账号实际登录，确认只能访问正确的队伍和比赛，再发放凭据。不能用“上传成功”代替导入结果和登录检查。

## 旧版本升级与数据边界

升级会停用旧实例和自动绑定、取消未完成 SYNC 任务、移除旧服务凭据。历史映射与人工撤权待办保留以便处理已创建的远端账号；旧接口返回 404。新导出不会沿用旧同步账号，也不会联络远端。请先备份，比赛正在使用旧账号时不要在赛中直接切换。

新的包只表达当前名单，不包含删除指令。资格撤销、取消／删除报名或停用导出模块，都不会撤销远端权限。评测管理员应对照导入名单手动处理；本站不把文件导出报告为远端导入成功。

## 本地真实平台验收

```bash
# 启动本地开发依赖、API、Worker、Web 并加载演示数据后
pnpm test:platform-exports
# Hydro 使用官方最新版和 Onsite Toolkit；无需本站桥接插件
docker compose -f infra/fixtures/hydro/compose.yaml up -d --build
# DOMjudge 固定 9.0.1 作为 9.x 兼容验收实例
pnpm fixtures:domjudge
docker compose -f infra/fixtures/domjudge/compose.yaml up -d
pnpm test:oj
```

真实验收使用本系统下载的文件，调用目标平台自己的 CLI／后台导入，再读回关联、重复导入并实际登录。fixture 只绑定 localhost，测试凭据不可用于生产。完成后用各 fixture 的 compose down -v 清理测试容器和卷。

## GitHub 账号登录

GitHub 登录与比赛平台账号独立。在 GitHub 开发者设置创建 OAuth App，授权回调填写 `https://你的站点/api/v1/auth/github/callback`；管理员在“GitHub 登录”页填 Client ID 和 Client Secret 并启用。代理正确传递 Host 与 X-Forwarded-Proto，回调地址可在后台明确指定。

实现参考 [Auth.js GitHub Provider](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/github.ts)、[GitHub OAuth Web Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) 与 [GitHub 邮箱 API](https://docs.github.com/en/rest/users/emails)。通过后端交换令牌，只使用已验证邮箱，令牌不持久化；state 单次有效并配合 PKCE。同邮箱已有账号先登录再绑定，禁止自动合并。资料完整性由本站维护，GitHub 登录后同样先完善学号、姓名、班级、学院和性别。
