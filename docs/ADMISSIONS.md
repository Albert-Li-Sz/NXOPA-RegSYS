# LaTeX 准考证

个人报名一人一张、团队报名全队一张。准考证引用提交资料快照、报名版本、模板版本和文档版本；资料、资格或模板变更后，旧文件停止下载。系统管理员维护全局模板，竞赛管理员覆盖本竞赛模板；最新生效竞赛模板优先于全局模板。

## 模板语法

编辑器显示字段列表、允许插入变量并生成示例预览。模板只允许双大括号变量、each 循环和 if 条件；值统一转义 `# $ % & _ { } ~ ^ \`。禁止原始三大括号、原型字段、任意模板 include 与 JavaScript。模板长度、节点数、深度和循环次数有限制。

```latex
\documentclass[UTF8,fontset=fandol]{ctexart}
\usepackage{graphicx}
\begin{document}
{{contest.title}} 准考证
编号：{{admission.number}}
时间：{{contest.startsAt}}
考点：{{admission.location}}
考场 / 座位：{{admission.room}} / {{admission.seat}}
{{#if team.name}}队名：{{team.name}}{{/if}}
{{#each team.members}}
{{this.name}}：{{this.answers.school}}
{{#if this.assets.photo}}\includegraphics[width=20mm]{ {{this.assets.photo}} }{{/if}}
{{/each}}
\end{document}
```

个人变量为 `participant.name`、`participant.answers.<字段键>`；队伍成员位于 `team.members`，老师位于 `coaches`，循环中通过 `this` 读取。队伍 / 报名单答案位于 `registration.answers.team.<键>`、`registration.answers.registration.<键>`。比赛时间按 Asia/Shanghai 展示。

照片字段提供 `participant.assets.<字段键>` / `this.assets.<字段键>`，是任务内的安全文件名。Worker 只复制当前报名已绑定且类型为 PNG/JPEG 的照片，最多 30 张、合计 25 MiB；编译器不直接访问原附件卷。示例预览不带真实照片，使用 if 条件处理空素材。

## 编号、座位与生成

竞赛可在活动设置中配置多个考点，让选手报名时选择。准考证的 `admission.location` 自动采用所选考点名称与地址，启用排考后还会包含考场地点；模板也可分别使用 `registration.examSite.name` 和 `registration.examSite.address`。更改考点名称或地址会撤销旧准考证；报名改选考点会同时清空原座位，需完成重新提交与排考后再生成。

启用“考场与座位”时，先维护考场、容量和顺序，再手动、自动或导入排考；预览通过后才能提交。默认个人一人一座、团队一队一座，也可按成员排考，同队安排在同一考场；团队共用一张准考证并汇总成员座位。页面下载的新版 CSV 使用 `registrationId,personId,room,seat`，`room` 为考场名称。容量、重复座位及全部记录版本会在事务内再次核对，错误时整批拒绝。

考场可填写独立编号，最多 20 字符，支持字母、数字、下划线及连字符，保存后统一大写且同活动内唯一。报名导出分别包含考场与座位。

生成准考证优先使用已经提交的排考结果。更改座位、考场名称或地点会使受影响文档失效，需重新生成。每个活动只有一个场次，已有排考时先清空再更改排考单位。下文的直接填写考场和旧 CSV 用于未启用考场管理的兼容模式。

管理员可生成单张，或在竞赛后台选择报名批量生成并从座位起始数字连续分配。默认编号为 CC、年份及随机唯一部分；API 可以配置 numberPrefix、发放时间 releaseAt 和逐报名 seats。

座位 CSV 的第一行为标题，后续每行格式如下，字段不使用逗号或换行：

```csv
registrationId,room,seat,number,location
报名UUID,A101,1,CC2026-0001,示例考点
报名UUID,A101,2,CC2026-0002,示例考点
```

编号 / 考点可留空。导入检查重复报名、报名资格和编号唯一性；生成任务保存逐项结果。改变座位会创建新的文档版本与编译任务，旧任务无法覆盖新版本。

## 批量生成、发放和下载

报名管理支持跨页勾选，或显式选择当前筛选条件下的全部报名。改变筛选条件会清空勾选。每个批次最多 10000 份报名，操作前预览总数、可处理数及跳过原因，并固定目标报名与版本。

“批量生成准考证”完成后为 READY，管理员可以检查 PDF；“批量发放准考证”将当前有效且已生成完成的文档改为 RELEASED，开放参赛者下载并触发通知。重复发放不重复通知。资料、资格、模板或活动配置变化会阻止旧文档发放。逐项结果显示成功、失败和跳过原因，失败项可重新预览处理。

下载由后台生成 ZIP。每包最多 1000 份 PDF、源文件合计 100 MiB，超出自动分包。分包 24 小时有效；每次下载重新校验权限和所有文档有效性。参赛者只能下载已发放的当前文档，管理员可检查 READY 文档。

活动可选自动生成比赛账号，默认模板通过 account.username、account.password 条件区块展示比赛账号密码。个人一组、团队共享一组。账号配置变化后旧 PDF 失效，需要重新生成和发放。详见[报名导出与比赛账号](REGISTRATION_EXPORTS.md)。

## 编译隔离

独立 Runner 容器无网络，根目录只读，不连接数据库，不挂载生产附件目录和 Docker socket。每个编译目录归不同 UID 所有；shell escape 关闭，TeX 文件访问采用受限设置，资源和输出大小受限制。生成与发布前再次核验报名和模板版本，避免编译期间资料更新后发布旧内容。
