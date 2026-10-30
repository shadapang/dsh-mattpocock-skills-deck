# UPSTREAM.md —— 上游基线、合并流程与本地改动台账

这个文件回答三个问题：我们现在跟到上游哪个提交、从上游拿过 / 丢过什么、本地这棵树自己改了什么。
上游有新版时怎么合，看第四节；每次合完要把结果补回第二、三节的表里，别让台账跟树走散。

> 记一次实事的原则：这里每一个 sha、每一条命令结论都应该是本机能核对出来的。
> 核对不了的（例如本机从没取过上游 ref）就直说「记录值、未本地核对」，不写成已核对。

## 一、仓与远端

| 名字 | 地址 | 用途 |
|---|---|---|
| `origin` | https://github.com/shadapang/dsh-mattpocock-skills-deck.git | 我们自己的 fork，日常据此推送 |
| `upstream` | https://github.com/FeatherHunter/dsh-mattpocock-skills-deck.git | 原作者仓，只读，只在合并上游时用 |
| `backup` | `E:\repos\dsh-mattpocock-skills-deck.git`（本机裸仓） | 本机第二份备份 |

## 二、基线与已合内容

### 本地基线（本机实测，2026-10-30）

| 事实 | 值 |
|---|---|
| `main` | `2348e29b8e47ed9beed35a254f7111ffa2e32172`（提交标题：写清发布失败后不重跑与证据不可变两条规则） |
| `origin/main` | 与 `main` 同一个提交 |
| 克隆形态 | 浅克隆，深度 1（`git rev-parse --is-shallow-repository` 回 `true`），且带 `blob:limit=1m` 的部分克隆过滤 |
| 本地是否有 `upstream/*` ref | **没有**（`git rev-parse --verify upstream/main` 报不存在；本机从未 fetch 过上游） |

后果要写清楚：因为本地只有 1 个提交、又没有上游 ref，**这棵树跟上游没有可用的共同祖先记录**。
所以「哪些本地提交不属于上游」「上游哪些提交已经进来过」这两个问题，今天都**不能用 git 直接算**。
补全的办法见本节最后。

### 上游基线

| 记录日期 | 上游 `refs/heads/main` | 怎么来的 | 本地核对 |
|---|---|---|---|
| 2026-10-30 | `04e6132` | `.scratch/matt-skills-deck/issues/09` 那次调查实测 GitHub 上的上游 main | 未核对：本机没有上游 ref，且本机到 github 经常连接被重置 |

### 已复用 / 已丢弃 / 暂缓的上游提交

目前是空的：这棵 fork 还没有合过任何上游提交，也没有挑过补丁。合过之后在这里追加一行。

| 日期 | 上游提交 | 决定 | 理由 |
|---|---|---|---|
| （暂无） | | | |

### 怎么把基线补成「可本地核对」

一次性、需要网络、由人来做：

```
git fetch upstream main
git rev-parse upstream/main                 # 这一步拿到的才是可核对的基线
git log --oneline upstream/main..main       # main 上不属于上游的提交
git log --oneline main..upstream/main       # 还没进来的上游提交（欠账）
```

把结果写回上面两张表，再把「本地核对」那格改成已核对。

## 三、本地改动清单

### 仓库内的提交

本机只能看到 `main` 上**一个**提交（`2348e29`，见上），更早的历史在浅克隆的边界之外。
因此这里暂时不能给出「本地新增的提交清单」——那需要上游 ref 才能算，见第二节最后的命令。
在补全之前，任何一次上游合并都必须**逐文件看 diff**，不要假设「历史里没有就是没改」。

### 已知的仓外本地补丁（不影响合并，但升级会被覆盖）

| 对象 | 补丁 | 出处 |
|---|---|---|
| `@deepseek-ai/dsh-subagent-codex` | spawn 加 `windowsHide: true`（`lib/index.js` 第 656 行附近，备份 `.bak-20261030-winhide`），装在本机 profile 里，不在本仓 | `docs/deck/PLAN.md` 第二节 |

### 本仓版本

`package/package.json` 与 `package.json` 的版本号是 `1.9.0-beta.32`（2026-10-30 实测），
与当时装在本机 `desktop` profile 里的那份一致。合并上游后如果版本号变了，要重新确认 profile 里装的是哪一版。

## 四、一轮上游合并怎么做

一条命令：

```
node scripts/sync-upstream.mts                  # 合 upstream/main（本机没有这个 ref 就先按第二节手动 fetch）
node scripts/sync-upstream.mts --from <ref|sha|本地仓目录>
```

它按这个顺序做，任何一步不过就整轮作废：

1. 开（或复用）`sync/<YYYYMMDD>` 分支，从 `main` 起；
2. 合并 `--from` 指的那个提交；
3. 三步验证：① `pnpm install --frozen-lockfile` ② `node scripts/build.mts` 退出码 0
   ③ 把构建产物装进 profile，再从装好的那份包里直接调 `deck_context`，断言后端是 `markdown`、工作区认对了；
4. 打印 **ACCEPT**（退出码 0）或 **REJECT**（退出码 1）。

几条硬规矩，脚本本身已经保证：

- **main 不动**：合与验都只在 `sync/*` 分支上做，结束时切回开始时的分支，并核对 `main` 的 sha 前后一致。
- **失败可丢**：REJECT 时把 `main` 留在原处、把工作区还原，这一轮整个不要就行。
- **profile 不留坏状态**：装之前把原来的插件目录整份备份到
  `E:\repos\_wt\w2-evidence\profile-backup-<时间戳>`（缺省值，可用 `--backup-root` 改），
  冒烟不过就原样放回去。
- **产物冲突按重建解决**：`package/lib/`、`package/{shared,deck,tracker,refresh}/scripts/`、`package/README.md`、`.build/`
  这些路径上的冲突先取上游那份，再由紧接着的第 2 步构建覆盖回来，**绝不手改产物**；
  其它路径上的冲突脚本不替人裁决，直接 REJECT 并把冲突文件列出来。

合完想回到 `main` 是人的动作，脚本只打印这一行：

```
git checkout main && git merge --ff-only sync/<日期>
```

### 自测

```
node scripts/sync-upstream.mts --self-test
```

自测不碰真实 profile、不联网：用临时 profile 与本仓对象库里造的提交，跑三场——
甲（三步全过 → ACCEPT，且真的装进了 profile、旧目录有备份）、
乙（上游把源码改坏 → 构建失败 → REJECT，main 不动、profile 没被碰）、
丙（装完把包弄坏 → 冒烟失败 → REJECT，profile 回滚到备份）。

## 五、台账怎么更新

每次 ACCEPT 之后补两处：

1. 第二节「已复用 / 已丢弃」表：这次合进来的上游提交范围、有没有单独丢掉某个提交、为什么；
2. 第二节「上游基线」表：新的一行，写上游 sha 与核对方式。

REJECT 不用记上游基线（什么都没进来），但如果你为了这次专门研究了冲突，把结论写进当轮对话或票里。
