# 评测平台接入

平台实例保存地址与加密的服务凭据；系统管理员显式授权可使用该实例的竞赛。竞赛管理员随后绑定目标竞赛、域 / 分组 / 学校 ID，并选择自动同步或手工同步。本站报名资格变化通过 Outbox 派发任务，重复执行复用确定性用户名、加密的独立比赛密码和远端映射。

比赛账号交付通过授权浏览器接口完成并记录审计。个人比赛账号只向本人及竞赛管理员交付；团队比赛共用一个账号，向关联参赛者与获授权老师交付。资料或净到账变化撤销本站资格时，账号标记 REVOKED_LOCALLY 并停止交付；当前两个适配器不声明自动停用 / 更新能力，管理员在 OJ 中处理已经创建的账号。

## 管理后台配置

进入“管理中心 → 评测平台”。系统管理员添加 Hydro / DOMjudge 实例，填写地址、Hydro 插件 Token 或 DOMjudge API 用户名与密码，并授权允许使用该实例的竞赛。凭据加密保存且不返回浏览器；编辑时留空保留原值，切换平台类型时填写新凭据。

在同页的“比赛绑定与报名同步”选择本站竞赛和实例，填写目标比赛 ID。Hydro 填写域 ID；DOMjudge 可填写组织 ID 与一个组 ID。选择“参赛资格生效时自动同步”或手动同步，保存后可探测连接。自动同步遵守报名、老师关联、审核和净收款资格规则；手动同步与失败重试在该竞赛的报名管理中执行。探测只验证连接与平台版本，实际账号创建和参赛访问另行核验。

竞赛管理员可管理获授权竞赛的比赛绑定，无法查看或修改服务凭据；参赛者无法访问此配置。竞赛编辑页的原有联动入口继续可用。

## Hydro 5.0.7

桥接插件位于 `plugins/hydro-contest-center`，插件包由下列命令生成到 `dist`：

```bash
pnpm package:hydro
```

在 Hydro 的 Node.js 环境中安装该 tgz，然后将 `hydro-contest-center` 加入 `~/.hydro/addon.json`，设置至少 32 字符的 `CONTEST_CENTER_TOKEN` 和逗号分隔的 `CONTEST_CENTER_DOMAINS`，重启 Hydro。本站平台实例使用相同 Token，竞赛绑定设置目标域与比赛 ObjectId。

插件路由：`/contest-center/v1/probe`、`/provision`、`/result`。请求使用 Bearer Token，比较时采用固定长度 SHA-256 摘要和 timingSafeEqual；域受允许列表约束。插件通过 Hydro UserModel、DomainModel、ContestModel 创建独立比赛账号、加入目标域并参加比赛，保存源实例与报名关联以校验重复同步。

本地独立验收：

```bash
docker compose -f infra/fixtures/domjudge/compose.yaml stop
docker compose -f infra/fixtures/hydro/compose.yaml up -d --build
OJ_TYPE=HYDRO pnpm test:oj
```

实例使用 Hydro 5.0.7、MongoDB 7，端口 58888。仅本地 fixture 包含创建验收比赛的辅助插件；正式 tgz 不包含它。固定 fixture Token 和密码只用于 localhost 验收。

## DOMjudge 9.0.1

配置具有 api_reader / api_writer 角色的独立服务账号，绑定已存在的比赛。队伍写接口使用 `/api/contests/:contest/teams`，用户写接口使用 `/api/users`；JSON 字段必须为 snake_case，例如 group_ids、organization_id、display_name、team_id，team_id 使用队伍的外部 ID。完成后再次读取队伍、用户，并用新参赛账号认证 `/api/user` 和竞赛列表，验证目标竞赛可访问。

如果目标竞赛按分组限制参赛，绑定正确的 groupIds；首版 DOMjudge 配置支持一个分组。无效的组 / 组织 ID 或不可访问的比赛会留下可查询的失败任务，修正绑定后重试。只有本系统创建的确定性账号可被复用，用户名已关联其他队伍时明确失败。

独立验收镜像从官方 DOMjudge 9.0.1 发布归档和固定版本 packaging 构建；没有以 9.0.0 镜像替代版本：

```bash
docker compose -f infra/fixtures/hydro/compose.yaml stop
pnpm fixtures:domjudge
docker compose -f infra/fixtures/domjudge/compose.yaml up -d
OJ_TYPE=DOMJUDGE pnpm test:oj
```

端口 58901，MariaDB 10.11.11。发布包 SHA-256 为 `3d46b31c296581833ac9f8e9b249d929fc28710e834b1cec68723791a2dceb97`；packaging 固定在 `396fd5446c53ec9dc6d66208b41915b9cdcd1bc1`。构建脚本验证下载完整性和校验和，首次构建会安装官方构建依赖。

OJ 验收依赖本地已取得资格的报名；先运行 `pnpm test:integration`。两个 fixture 的数据库和配置卷独立，测试会创建虚构竞赛并检查真实账号登录、参赛访问、重复执行和远端提交后响应丢失的恢复。正式实例与这些测试实例互不共用。
