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

生成准考证优先使用已经提交的排考结果。更改座位、考场名称或地点会使受影响文档失效，需重新生成。每个活动只有一个场次，已有排考时先清空再更改排考单位。下文的直接填写考场和旧 CSV 用于未启用考场管理的兼容模式。

管理员可生成单张，或在竞赛后台选择报名批量生成并从座位起始数字连续分配。默认编号为 CC、年份及随机唯一部分；API 可以配置 numberPrefix、发放时间 releaseAt 和逐报名 seats。

座位 CSV 的第一行为标题，后续每行格式如下，字段不使用逗号或换行：

```csv
registrationId,room,seat,number,location
报名UUID,A101,1,CC2026-0001,示例考点
报名UUID,A101,2,CC2026-0002,示例考点
```

编号 / 考点可留空。导入检查重复报名、报名资格和编号唯一性；生成任务保存逐项结果。改变座位会创建新的文档版本与编译任务，旧任务无法覆盖新版本。

生成完成为 READY，管理员确认发放或达到设置的 releaseAt 后为 RELEASED。参赛者下载需要已发放、当前版本和有效资格；管理员可以在未发放时检查已完成文件。编译失败不发布 PDF，后台和任务查询提供经过权限检查的日志。批量 ZIP 导出会先验证每张文档的访问权限，后台通过 POST /api/v1/admissions/batch 提交文档 ids 或报名 registrationIds，单次最多 1000 张；重复 ID 只导出一次，超过上限返回明确错误，可分批下载。旧 GET 下载接口保留，最多 200 张。ZIP 导出会先读取授权文档，PDF 总大小限制为 100 MiB；API 在该上限内缓存内容，再生成归档。

## 编译隔离

独立 Runner 容器无网络，根目录只读，不连接数据库，不挂载生产附件目录和 Docker socket。每个编译目录归不同 UID 所有；shell escape 关闭，TeX 文件访问采用受限设置，资源和输出大小受限制。生成与发布前再次核验报名和模板版本，避免编译期间资料更新后发布旧内容。
