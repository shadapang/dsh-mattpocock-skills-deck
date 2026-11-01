# MattSkillsDeck · 开发总纲

> 版本：2026-11-01（V1）
> 读者：维护者、接手的 Agent、外部评审。
> 范围：这个项目「为什么做、现在长什么样、接下来按什么标准做」。
> 相关文档：`docs/workflow/DEV-WORKFLOW.md`（改代码→构建→生效）、`docs/architecture/*`（架构细节）、
> 工作区里的 `docs/deck/IMPLEMENTATION.md`（实施流程）、`docs/deck/DISCUSSION.md`（讨论两阶段）、
> `docs/deck/WORKFLOW.md`（波次容器）、`docs/agents/*`（票务/标签/领域文档约定）。

---

## 0. 先把理解对齐：你要的是什么

你要的不是「再加一个看板」，而是一套**能约束执行的项目交付系统**：

1. **看得见**：面板按「项目（工作流）」看路线，一条工作流一次只推一张「可接」，其余排队；
   不按清单一张张刷，也不让不同会话重复做同一张卡。
2. **管得住**：卡不是待办事项，是**带验收、带依赖、带写范围、带标准**的执行单元；
   不合格的卡派不出去。
3. **跑得动**：执行由宿主统一派工、子代理只交货、宿主逐张验收；有运行态（runs）、有回执、
   有作废机制、有波末报告。
4. **做得对**：质量不是「我看了一眼」，而是 TDD、可跑的验证命令、两轴评审（Standards + Spec）、
   PR/交付规范。这套方法论用 mattpocock 的工程技能固化，不靠自觉。
5. **可交接**：任何一轮跑完，另一个人（或另一个 Agent）能凭票面、runs、报告还原当时发生了什么。

一句话：**把「看板」升级成「驾驶舱」——面板决定顺序，协议保证不互相踩，标准保证做完能用。**

三层分工：

```
看得见（面板 / 工作流视图）  →  跑得动（编排协议 / runs / 多智能体）  →  做得对（票模板 / 技能 / 门禁）
```

---

## 1. 项目定位

| 项 | 内容 |
|---|---|
| 产品 | `dsh-mattpocock-skills-deck`（DSH 插件，面板 + deck 工具 + 内置 27 个 mattpocock 技能） |
| 方法 | deck 四段式（探索地图 → spec → 实施票 → 波次执行）+ mattpocock 工程技能 |
| 用户 | 单人 / 小团队，同时开多个 AI 会话干活 |
| 形态 | 一个 DSH 插件（host + client 两半）+ 一套工作区内的票与运行态文件 |
| 不做 | 不做通用项目管理 SaaS、不做无人值守自动跑、不做跨团队权限体系 |

### 成功判据（可检查）

1. 打开面板，能一眼看出「哪条工作流现在该做哪一张卡」，不需要翻清单。
2. 一张卡被派出去后，另一个会话不会再去抢同一张（认领可见、门禁拦住）。
3. 每张关掉的卡都带着：验收逐条勾选、验证命令结果、评审结论、交付证明。
4. 一波结束有报告；一轮崩了有 runs 记录，知道当时在跑什么。
5. 新接手的人只看票 + 报告就能判断「这活到底做完没有」。

---

## 2. 现有设计（as-is）

### 2.1 运行时结构

```
DSH 宿主进程
├─ host 半（src/host/index.ts → package/lib/index.js）
│   ├─ 注册 RPC 方法（wf.*）：快照、检测、票务读写、设置、更新、日志
│   ├─ 持有后端（markdown / GitHub / GitLab）与缓存
│   └─ 管设置文件 ~/.dsh/mattskillsdeck/settings.yaml
└─ client 半（src/client/** → package/lib/client.js）
    ├─ apply(ctx) → 注册插槽：右侧面板、状态栏胶囊、设置页、浮动层
    ├─ 内核（kernel/*）：locale / prompts / store / router / api / settings
    └─ 视图（views/*）：ListTab（任务卡）、WorkflowView（工作流）、MapDetail、IssueDetail…
```

关键边界：
- **client 改动刷新页面生效；host 改动必须重启 DSH**（`docs/workflow/DEV-WORKFLOW.md` §2）。
- 插件产物是**构建生成**的（`src/` 唯一真源，`package/lib/*` 由 `scripts/build.mts` 生成，不入库）。
- 面板里所有写操作都经 `wf.*` RPC 回 host，client 不直接碰文件。

### 2.2 票务模型（后端中性）

| 对象 | 说明 | 落点（本地 markdown） |
|---|---|---|
| 探索地图 map | 装「决定票」，探索结束即关闭 | `.scratch/<effort>/map.md` |
| 规格 spec | 装需求真值与实施地图（一个目录只能一种容器） | `.scratch/<effort>-impl/spec.md` 或 `.scratch/<effort>/spec.md` |
| 实施票 / 普通票 | 可执行切片，带 Acceptance / Blocked by / 标签 | `.scratch/<effort>/issues/NN-*.md` |
| 依赖边 | 只信票面的 `Blocked by` | 票头字段 / 关系边 |
| 标签 | 五个 triage 角色 + `wayfinder:*` + `impl` | 票头 `DSH-LABELS` |

后端有三种（markdown / GitHub / GitLab），客户端只读**宿主归一后的快照**（`maps` + `issues` + `deck` 投影），
不按后端分支。

### 2.3 工具面（模型能调用的）

`deck_context`（确认后端/仓库）、`deck_issue_create/get/patch/list`、`deck_map_link`、
`deck_map_plan_create`、`deck_map_snapshot`、`deck_issue_report`、`deck_work_route`。

**写工具只有宿主该用**：markdown 后端的写锁只是进程内 Map，没有跨进程文件锁；任何并行都必须是
「宿主单写、子代理只交货」。

### 2.4 面板

- **列表 / 任务卡视图**：传统清单，筛选、排序、状态过滤、容器行（地图/规格三态按钮）。
- **工作流视图**（本轮新增，见 §3.2）：按 effort 分泳道，按依赖深度分层，一次只放一张可接。
- **胶囊状态栏 / 设置页 / 详情页**：环境检查、后端选择、工作区开关、标签颜色等。

### 2.5 设置与持久化

| 位置 | 内容 | 边界 |
|---|---|---|
| `settings.yaml`（`ui` 节） | 列表排序/筛选 | 全机一份 |
| `settings.yaml`（`workspaces` 节） | 按工作区的观看状态（胶囊、工具箱等固定开关名） | 键 = 工作区根 |
| localStorage | `dsws.listPrefs`（旧键过渡）、`dsws.wfFold.<工作区>`（工作流折叠） | 跟浏览器 origin 走 |
| `.scratch/<effort>/runs/*.json` | 编排运行态 | 宿主独写 |

### 2.6 质量底座（既有的，别丢）

- `src/**` 唯一真源；构建出 `client.js` / `host.js` / `package/lib/*`。
- 单文件有效行上限 350（`tests/verify-file-granularity.ts`）。
- 门禁链：`typecheck`、`verify-leaves`、`verify-kernel`、`verify-ctx`、`verify-1106-deck-surface`、
  `verify-1327-freshness`、各功能门禁（如 `verify-workflow-view`）。
- 发布链路：构建指纹、发布前后对账、beta/latest 标签（见 `scripts/release-*.mts`）。

---

## 3. 新工作流设计（to-be）

### 3.1 四段式流水线

```
探索地图（决定）        →  spec（真值）          →  实施票（切片）        →  波次执行（runs）
wayfinder:map              /to-spec                 /to-tickets             宿主 + 子代理
收口: fog=0                做什么/边界/验收          一次一张 / 有依赖         每波 ≤2 / 逐票验收
```

铁律：**探索票与实施票永不混放**。前者是决定（grilling/research/prototype/task），
后者是可执行切片（impl + 可验收）。

### 3.2 工作流视图（已实现）

**布局：B 的头 + A 的身体**（原型见 `docs/prototype/workflow-view-fold-run-prototype.html`）

- 头：`▾ 工作流名`（人写的容器标题，不是目录名）+ `4 / 8 已完成 · 在做 1`；
  右侧 `▶ 按这条工作流执行 4 张`，全完成变绿色 `✓ 全部完成`。
- 身体：`当前这一张：#7（可接）` + 按依赖深度分层，同层并排，层间竖线；卡上带状态药丸与副文案。
- 折叠：点整行折；折叠后保留头、进度条、执行入口，并给
  `▸ 已折叠 · 下一站 #7 xxx · 可接 1 · 排队 1 · 被挡 2`；折叠状态按工作区持久化（localStorage）。
- 窄面板：执行按钮收成 `执行 · 4`，层内卡片竖排。
- 泳道名：优先取容器（地图/规格）的 `DSH-TITLE`；按票的 `parentKey` 认是哪张容器；
  没有容器标题才退回目录名，悬停给目录。

**判定口径（纯函数，`workflowLayout.ts`）**

| 状态 | 判据 |
|---|---|
| closed | 票已关闭 |
| running | 有认领人（别人在做） |
| blocked | 本泳道内有未关闭的挡路票 |
| ready | 候选；按（深度, 编号）排序，只放 WIP=1 张 |
| queued | 候选但超出 WIP，带排队名次 |

### 3.3 编排协议（已定，`docs/deck/IMPLEMENTATION.md` §6）

- **宿主单写**：写票、关票、写 Answer 只在宿主一处；子代理只交货。
- **先置状态再认领**：`runs.plan[].state=running` → `deck_issue_patch` 认领 → 才派工。
- **每波 ≤2**；同写范围串行，不同范围才可同波。
- **子代理回执固定五段**：`ticketKey / status / changed_files / evidence / open_risks`。
- **宿主逐票验收**：逐条核 Acceptance + 亲读 diff/产物；通过写 Answer 关票；不过记 progress、attempt ≤2。
- **波末停下报告**，不自动开下一波。
- **触发**：人显式说「跑」才动；不自动、不定时。

### 3.4 运行态状态机

`run.status`：`active` → `invalid`（票面漂移，整波作废）/ `closed`（全项终态）。
`plan[].state`：`pending` → `running` → `done | failed`；`running` 期间票面被改 → `void`。

脚本：`scripts/deck/workflow.mjs`（`plan / init-run / claim / record / verify / reconcile / close-wave / self-test`），
判定集中在脚本一处，宿主只负责派工与验收。

---

## 4. 把技能变成标准（mattpocock 集成）

> 现状：插件已内置 `mattpocock/skills` v1.3.1 的 27 个技能；本工作区已跑过 setup
> （`docs/agents/issue-tracker.md`、`triage-labels.md`、`domain.md`、`AGENTS.md` 三节）。
> 所以**不需要再装**；要做的是把技能从「可调用」变成「卡流程里必须走的一步」。

### 4.1 技能地图（只取执行链路要用的）

| 阶段 | 技能 | 产物 | 对应门禁 |
|---|---|---|---|
| 需求锁真值 | `grilling` / `grill-me` | 需求真值（人回答的记录） | 模糊/跨模块需求必须先过 |
| 写规格 | `to-spec` | spec：做什么/边界/验收/不做 | spec 回读 + 用户故事可核对 |
| 拆票 | `to-tickets` | 实施票：纵向切片 + 依赖 + 验收 | 每票有 Acceptance |
| 执行 | `implement` / `implement-spec` | 代码改动 + 测试 | 无 Acceptance 不派 |
| 执行 | `tdd` | 先失败的测试 → 实现 → 绿 | 无测试的票要有理由 |
| 验收 | `code-review`（两轴） | Standards + Spec 评审结论 | 关票前必须有评审结论 |
| 交付 | `pr` | PR 正文（标题/引用/验证） | 需要 PR 的仓库必须走 |
| 复盘 | `retro` | 波末复盘 | 可选 |

`diagnosing-bugs`、`prototype`、`research`、`improve-codebase-architecture`、`handoff`、`triage`、
`domain-modeling`、`writing-for-agents`、`wizard` 是专项技能，按需调用，不进流水线门禁。

### 4.2 票模板 v2（在现有模板上加两节）

```md
# NN: <标题>

## What to build
<用户视角的端到端行为，一句话说清做完什么能用>

## Standards
- <引用：AGENTS.md / docs/deck/STANDARDS.md 的哪几条；本票特别要守的规矩>

## Verification
- <一条能跑的命令 + 期望结果；跑不了要写清为什么>

## Acceptance
- [ ] <可命令化或可检查>

## Blocked by
- <NN 标题>｜None

## Write scope
- <允许改的路径前缀>

## Answer
（宿主验收后写：改了什么、证据、评审结论、遗留）
```

### 4.3 门禁 v2（在现有五条上加三条）

| 条件 | 结果 |
|---|---|
| 票无 Acceptance | 不派 |
| **票无 Verification** | **不派** |
| 票带 `wayfinder:*` | 不派（决定票） |
| 票无 `impl` 标签 | 不派（默认） |
| blocked-by 有未闭环 | 不派 |
| 有 assignee 且非本会话 | 不派（别人在跑） |
| **关票前无评审结论** | **不关** |
| **Verification 未通过** | **不关** |

### 4.4 执行提示词 v2（`workflowRunPromptOf` 升级）

顺序写死，不给自由度：

```
0. deck_context 确认后端；票一律走 deck 工具。
1. 按顺序推进，每波 ≤2；Blocked by 未关不开工。
2. 每张票：
   a. 先读 Standards 与 Write scope；
   b. 走 /implement（或 /implement-spec）；代码类先 /tdd 写失败测试；
   c. 跑 ## Verification 的命令，留输出；
   d. 用 /code-review 两轴评审（fixed point = 开工前那个 commit；Spec 来源 = 本票/规格）；
   e. 全过 → 写 ## Answer（含验证输出、评审结论）→ 关票；不过 → 留原状、记 progress、attempt ≤2。
3. 需要 PR/合并 → /pr 写正文，按仓库交付口径走。
4. 一波结束停下报告：做完几张、卡在哪张、为什么；不自动开下一波。
```

### 4.5 标准文档（待建）

`docs/deck/STANDARDS.md`（短、可检查，给 `code-review` 的 Standards 轴当依据）：

1. 命名与目录（按现有架构：kernel / views / host / tracker / shared）
2. 测试（哪些必须有、放哪、怎么跑）
3. 错误处理（不吞错、日志字段、用户可见文案）
4. 提交信息（一票一提交、引用票号、写清验证）
5. 评审（谁审、审什么、结论写哪）
6. 交付（PR 还是直推、合并前检查）
7. 禁止事项（手改产物、绕过门禁、把决定票当执行票）

### 4.6 需求侧（与现有 wayfinder 并行）

- 模糊或跨模块需求：先 `/grilling` 锁真值（判据：列不出 ≥3 张互不依赖的票，或触及 ≥2 个模块）。
- 然后 `/to-spec` → `/to-tickets`；探索地图仍只产决定，不产交付。
- 讨论产物 = spec + 风险清单 + 票草稿，全由宿主写；双跑只审风险，不产出 spec。

---

## 5. 端到端流程（一个需求从进来到交付）

```
① 需求进来（人话）
   │  判据：模糊/跨模块？ → 是：/grilling 锁真值；否：直接下一步
   ▼
② spec（/to-spec）           产物：spec.md（做什么/边界/验收/不做）
   │  门禁：非目标写出、验收可命令化
   ▼
③ 拆票（/to-tickets）        产物：实施票（纵向切片 + 依赖 + Write scope + Standards + Verification）
   │  门禁：无 Acceptance / 无 Verification 不建或补全
   ▼
④ 排波（workflow.mjs plan）  产物：wave 计划 + runs/<runId>.json
   │  门禁：依赖全闭、无环、写范围不冲突
   ▼
⑤ 派工（宿主）              产物：认领 + 子代理任务书（自包含）
   │  门禁：五条硬门禁 + 写范围
   ▼
⑥ 交货（子代理）            产物：五段回执（ticketKey/status/changed_files/evidence/open_risks）
   │  禁止：调 deck 写工具、改票文件
   ▼
⑦ 验收（宿主）              产物：Verification 输出 + /code-review 两轴结论
   │  门禁：逐条 Acceptance + 验证通过 + 评审通过
   ▼
⑧ 关票 + Answer             产物：Answer（改了什么/证据/评审/遗留）
   ▼
⑨ 波末（reconcile + close-wave） 产物：报告 docs/deck/reports/<runId>.md
   ▼
⑩ 收口（规格）             产物：规格级收尾评论 + 关闭（人确认）
```

---

## 6. Definition of Done（三级）

**卡级（关票前）**
- [ ] Acceptance 逐条勾选，且有证据（命令输出/文件/截图）
- [ ] Verification 命令实际跑过，结果写进 Answer
- [ ] 改动在 Write scope 内；越界有说明
- [ ] `/code-review` 两轴结论：Standards 无未处置项，Spec 无缺口
- [ ] 需要 PR 的仓库：PR 已开/已合，链接与提交写进 Answer

**波级（close-wave 前）**
- [ ] runs 全部终态，无 `running` 悬挂
- [ ] 每张票面未被 worker 改动（digest 核对）
- [ ] 报告写了：做完几张、卡在哪、为什么、下一步

**规格级（关闭 spec 前）**
- [ ] 实施票全关
- [ ] 规格正文用户故事逐条有实现或测试
- [ ] 交付证明（分支/提交/PR）可复现
- [ ] 遗留已转票或用户确认不做

---

## 7. 角色与权限

| 角色 | 能做 | 不能做 |
|---|---|---|
| 人（维护者） | 定需求、拍板、批准危险操作、最终收口 | — |
| 宿主 Agent | 写票、认领、派工、验收、关票、写报告 | 越过门禁派工；替用户拍板 |
| 子代理 | 改代码、跑测试、交五段回执 | 调 deck 写工具、改票/地图文件 |
| 外部评审（Claude/Codex） | 独立评审、第二意见 | 无人值守做危险操作（push/删库） |
| 脚本（workflow.mjs） | 算波次、门禁、runs 状态、漂移核对 | 自己起子代理（宿主工具） |

---

## 8. 仓库与文档落点

| 位置 | 内容 |
|---|---|
| `src/` | 唯一真源（client / host / tracker / shared / seam） |
| `package/` | 构建产物（发布用，入库但由构建生成） |
| `docs/architecture/` | 架构、契约、拆分图 |
| `docs/workflow/` | 开发工作流、本总纲 |
| `docs/prototype/` | 一次性原型（含工作流视图三变体） |
| `docs/agents/` | 票务后端、triage 标签、领域文档约定（setup 产物） |
| `AGENTS.md` | 人/Agent 协作约定（含技能路由） |
| `.scratch/<effort>/` | 探索地图、规格、实施票、runs（工作区里） |

---

## 9. 路线图

### 已完成（本轮）

- 工作流视图：B 的头 + A 的身体；折叠；`执行全部` 注入任务书；泳道名取容器标题；折叠持久化；窄态降级。
- 门禁：`verify-workflow-view` 57 条；typecheck / build / leaves / kernel / ctx / 1106 / 1327 全绿。
- 原型：三变体 + 选定稿归档；真机安装流程（覆盖 + 锚定补丁重打）。

### P0（把标准接进卡流程，1～2 天）

1. 票模板 v2：加 `## Standards`、`## Verification`（改 `docs/deck/IMPLEMENTATION.md` §8 + 建/改票提示词）。
2. 门禁 v2：`workflowRunPromptOf` 加「无 Verification 不派」；`workflow.mjs` 的 gate 同步。
3. 执行提示词 v2：按 §4.4 顺序写死（implement → tdd → Verification → code-review → Answer → 关票）。
4. 验收：拿一张真卡跑一遍，Answer 里能看到验证输出与评审结论。

### P1（标准落地，3～5 天）

1. `docs/deck/STANDARDS.md`（§4.5 七节）。
2. `code-review` 接成关票门禁：固定点=开工 commit，Spec 来源=票/规格；结论写回 Answer。
3. 交付口径：PR 模板（`/pr`）、提交信息规范、合并前检查。
4. 波末报告模板升级：加入评审覆盖率与 Verification 结果。

### P2（需求侧与复盘）

1. 模糊需求强制 `/grilling`（判据写进讨论 runbook）。
2. `/retro` 波末复盘（可选，按波）。
3. 跨会话抢票冲突（当前明示缓办）。
4. 工作流标题别名（本地覆盖，不改票文件）。

### 明确不做

- 无人值守连续多波、自动重试调度器、token 预算调度。
- CNB 作为 deck 后端。
- 重造 DSH 任务系统 / 复刻 Agent Teams。
- 插件面板之外的独立 Web 应用。

---

## 10. 度量（每波/每月看一次）

| 指标 | 口径 | 采集 |
|---|---|---|
| Verification 覆盖率 | 有可跑验证命令的卡 / 总卡 | 票面扫描 |
| 首轮通过率 | attempt=1 就通过的卡 / 派出的卡 | runs `attempt` |
| 返工率 | attempt>1 的卡 / 派出的卡 | runs |
| 评审覆盖率 | 关票前有 code-review 结论的卡 / 关掉的卡 | Answer + 日志 |
| 证据齐全率 | Answer 含验证输出 + 交付证明的卡 / 关掉的卡 | 票面 |
| 波次时长 | close-wave 时间 - init-run 时间 | runs |

原则：**数据是结果，行为才是原因**；指标只用来发现「哪一步没做」，不用来考核人。

---

## 11. 风险与边界

| 风险 | 影响 | 处置 |
|---|---|---|
| markdown 后端无跨进程锁 | 并行写票会撞号/覆盖 | 宿主单写；子代理禁写；波末 digest 核对 |
| localStorage 跟 origin（端口）走 | 换端口折叠记忆丢 | 接受；要跨端口/换机就搬设置文件（需改核 schema） |
| 子代理握着同一套 deck 写工具 | 隔离只能靠 prompt | 任务书显式禁止 + 波末核对票面未变 |
| 技能是提示词，不是强制 | 不写就没人拦 | 把标准落到票模板、门禁、执行提示词三处 |
| 构建产物由人手覆盖安装 | 补丁会丢 | 本项目里有一处气泡锚定补丁只在安装目录；重建需重打（见 §9 备注） |
| 外部子代理冷启动 30～90s | 小活不划算 | 按 AGENTS.md 路由，小活自己干 |

---

## 12. 立刻可执行清单

1. 写 `docs/deck/STANDARDS.md`（§4.5）。
2. 改票模板（§4.2）与建票提示词（`specSplit` / `to-tickets` 相关）。
3. 改 `workflowRunPromptOf`（§4.4）与 `workflow.mjs` 的 gate（加 Verification）。
4. 拿一张真卡跑：开工 → 红测试 → 实现 → 验证 → 两轴评审 → Answer → 关票。
5. 把这一轮的过程写进 `docs/deck/reports/`。
6. 波末复盘：哪条约束没落地，补进 STANDARDS.md 或门禁。

---

## 附：决策记录（本项目已定）

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-10-30 | 工作流视图：一次只放一张「可接」 | 「任务卡不断冒、永远做不完」的处方 |
| 2026-10-30 | 编排不进插件，落在 `scripts/deck/workflow.mjs` + runs | 插件不该自己起子代理；脚本可重算、可复核 |
| 2026-11-01 | 视图采用「B 的头 + A 的身体」 | 执行入口要显眼，卡片信息要全（原型三选一） |
| 2026-11-01 | 折叠状态存 localStorage（按工作区） | 纯界面状态；进设置文件要改核 schema，成本不成比例 |
| 2026-11-01 | 泳道名取容器 `DSH-TITLE`，目录名退到悬停 | 目录名是给代码用的，标题是给人看的 |
| 2026-11-01 | 技能不重复安装，改为写进模板/门禁/提示词 | 插件已内置 v1.3.1；约束要可执行，不能靠自觉 |

---

## 附：代码索引（本轮工作流实现）

| 位置 | 作用 |
|---|---|
| `src/client/views/workflowLayout.ts` | 纯判定：分层、准入（WIP=1）、排队名次、焦点卡、执行顺序与任务书文本 |
| `src/client/views/WorkflowView.ts` | 渲染：B 的头（标题/进度/执行入口）+ A 的身体（分层卡片/连线/状态药丸）；折叠与持久化 |
| `config/copy/flow.yaml` | `wf.*` 词条（执行入口、进度、折叠行、目录提示），zh / en 对齐 |
| `tests/verify-workflow-view.ts` | 门禁 57 条：判定、任务书、折叠、持久化、泳道标题、渲染冒烟 |
| `docs/prototype/workflow-view-fold-run-prototype.html` | 三变体原型（A 现状 / B 路线图 / C 清单表），选定稿的来源 |
| `scripts/build.mts` | 叶子登记与打包（新增视图必须登记，门禁会查） |
| `scripts/deck/workflow.mjs`（工作区） | 编排脚本：plan / init-run / claim / record / verify / reconcile / close-wave / self-test |
| `docs/deck/IMPLEMENTATION.md`（工作区） | 实施协议：四段式、票模板、门禁表、runs 状态机 |

