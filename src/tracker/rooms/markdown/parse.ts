import { STATE, ISSUE_TYPE } from '../../contract/vocabulary.js'
import type { Issue } from '../../contract/entities.js'
import type { IssueType, State } from '../../contract/identity.js'
// #1277：对象类型唯一真源是文件头那行隐藏标记（ADR 2.5），本地房读票时认它。
import { markerKindInHeader } from '../../../shared/issue-file/src/marker.js'
// 字段读取这一族（父票 / 创建时间 / 隐藏头 / 围栏剥离 / 关票原因 / 认领人）已搬到 parse-fields.ts：
// parse.ts 贴着 350 有效行上限（tests/verify-file-granularity.ts），这里原样转出，调用方不用改导入点。
import { assigneesFromFile, closeReasonFromFile, createdStampFromFile, hiddenHeaderValue, loginOfAssignee, parentKeyFromFile, splitHiddenList, stripFencedCode } from './parse-fields.js'
export { assigneesFromFile, closeReasonFromFile, createdStampFromFile, hiddenHeaderValue, loginOfAssignee, parentKeyFromFile, splitHiddenList, stripFencedCode }

// parseMd 的元数据：调用方（读路径各处）已知的票身份，不从正文里读；
// 契约 Issue 的核心字段多由此补齐（key/effortId/parentKey/时间/url）。
// 全可选：纯文本解析时调用方可以一个都不给（缺了按空/默认回落）。
export interface ParseMeta {
  key?: string
  parentKey?: string | null
  isMap?: boolean
  effortId?: string
  createdAt?: string
  updatedAt?: string
  url?: string
  // #1486：调用方已经知道这张文件是规格还是普通票（文件名 spec.md / 旧标记 / 建票上下文）。
  // 新布局不再写 DSH-ISSUE-KIND，读侧就靠这一格把「规格」这一身份带进来。
  kind?: string
}

// 标题转文件名后缀。保留各语言的字母与数字：中文标题过去会被整串删光、只剩 `untitled`
// （#1280 验收要求本地不能落成 `01-untitled.md`，本票 #1277 修）。空白与标点压成连字符，
// 过长截到 40 个字符，首尾不留连字符，空串才回落 untitled。
function slugify(s: unknown): string {
  const base = String(s || '').trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-]+/gu, '-')
    .replace(/\-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return base || 'untitled'
}

// 票里只写标签名（#312 定版）：颜色由读这份票的人按工作区里的配色文件与内置默认色算出来，
// 解析这一层不持有任何颜色。这里原来还抄着一份默认色表（全仓第三份），#618 已删掉：
// 颜色的真源只有两处——工作区里的 docs/agents/label-colors.json，和 index.js 里那份内置调色盘
// （按这两处算色的地方是 label-colors.js 的 applyLabelColors）。

/** 把标签名外面那层「写法」剥掉，只留下标签名本身。
 *
 *  为什么要有这一步：文档讲格式时习惯把标签名写成一段代码（外面一对反引号），例如
 *  「Labels: `wayfinder:map`」。照抄的人会把这对反引号一起写进票面，读出来的标签名就成了
 *  带反引号的 `wayfinder:map`。带着反引号的名字在配色文件与内置默认色表里都查不到，颜色回落到灰；
 *  wayfinder:map 这个身份也认不出来（票的类型、行内按钮颜色与动作都跟着判错），
 *  面板上还会如实显示一对多余的反引号（#634 实测：本地 Markdown 工作区的票面就是这么写的）。
 *
 *  规则：只剥「首尾是同一个字符、并且这个字符是反引号、单引号或双引号」的成对写法，
 *  一层一层往外剥（`"bug"` 这种两层包法也能剥干净）。不成对的一律不动——名字里自带
 *  单引号的写法（例如 don't）首尾字符不同，不会被切坏。 */
export function stripLabelDecoration(name: unknown): string {
  let s = String(name === null || name === undefined ? '' : name).trim()
  for (;;) {
    if (s.length < 2) break
    const head = s[0]
    if (head !== s[s.length - 1]) break
    if (head !== '`' && head !== "'" && head !== '"') break
    s = s.slice(1, -1).trim()
  }
  return s
}

/** 递进来的正文是不是「一整份票文件」：自带一级标题、幂等锚、字段行或骨架标题就是整份，建票与改正文共用同一条判据（#1002）。
 *
 *  为什么四条都算整份：读回给的是整份票文件文本，写路径必须用同一条判据认出它，否则读回原样写回会写坏。
 *  只认一级标题或锚不够：改正文的实测里出现过无一级标题但带字段行的整份（C5），建票的实测里出现过
 *  只带骨架的正文（C2），它们按片段走都会翻倍或丢东西。片段里正常不会出现这四种写法，误伤的可能很小。
 *
 *  房规注：这条判据住在这里（Markdown 房内），建票与改正文同房引用。共享层 plan.js 里有一份逐字相同的
 *  写法给工具层与门禁读（房规不许后端引用共享层的 deck-tools 目录，共享层也不许互引，所以两份各自手写，
 *  改一处必须改另一处，两处注释都写明了对方）。 */
export function isWholeIssueBody(body: unknown): boolean {
  const t = typeof body === 'string' ? body : ''
  if (/^\s*#\s+\S/m.test(t)) return true
  if (/^\s*<!--[ \t]*DSH-IDEMPOTENCY-KEY:/m.test(t)) return true
  // #1489：原文实施票模板的字段行是加粗的（**Status:** ...），整份判据也要认，否则读回原样写回会被当片段。
  if (/^\s*(?:\*\*)?(Status|Type|Blocked\s+by|Labels)(?:\*\*)?\s*[:\uFF1A]/im.test(t)) return true
  if (/^\s*##\s*(Comments|Answer)\s*$/im.test(t)) return true
  return false
}


/** 从读路径给的本地路径里取文件名、去掉 .md 扩展名：标题降级时用它，不去猜目录名。 */
function fileBaseTitle(url: unknown): string {
  const base = String(url || '').split(/[\\/]/).pop() || ''
  return base.replace(/\.[Mm][Dd]$/, '').trim()
}

export function parseMd(text: unknown, meta: ParseMeta): Issue {
  const raw = String(text || '')
  // 2026-10-10 修（#991 实测带回来的读路径缺陷）：冒号后面原来写的是 \s*，而 \s 含换行 —— 字段值为空的
  //   那一行（「Status:」单独一行）会让 \s* 跨过换行，再由 ([^\n]+) 把**下一行**当成这个字段的值抓走。
  //   实测证据：同一份票文件上，带某个标签时读出「阻塞」有一条、去掉该标签立刻变空，而盘上那行本来就是空的。
  //   改成 [ \t]*：只吃同一行里的空格与制表符，值不许跨行。空值这一档由「匹配不上」处理（回到默认），
  //   与「空行就是空值」的语义一致。Type / Blocked by 两条同一个毛病，一并改。
  // 字段行只在「票面」上找，围栏代码块里的举例不算（#1174 复核 P1-3，见 stripFencedCode）。
  // 标题、正文、评论骨架仍然按整份原文读 —— 那几处要的就是原文。
  const field = stripFencedCode(raw)
  // #1486：新布局把状态写在 DSH-STATUS 隐藏注释里；可见的 Status: 行优先（老文件与人工改过的票都还有）。
  // #1489：原文实施票可见状态行是加粗写法（**Status:** resolved）；字段名两侧的 ** 都当装饰剥掉，
  //   值仍是冒号后面那一段（值前面可能还有一个收尾的 **，一并跳过）。可见行依旧优先于隐藏注释。
  const statusRaw = (/^\s*(?:\*\*)?Status(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*([^\n]+)/im.exec(field)?.[1]?.trim() || '')
    || hiddenHeaderValue(raw, 'DSH-STATUS')
  const statusNorm = statusRaw.toLowerCase().replace(/\s+/g, '-')
  const closedSet = new Set(['resolved', 'completed', 'closed', 'done'])
  const state = (closedSet.has(statusNorm) ? STATE.CLOSED : STATE.OPEN) as State
  // 上一行断言的原因：STATE 是冻住的对象字面量（vocabulary.ts），成员类型被拓宽成 string；
  // 运行时这里必为两态之一，转成契约的 State 字面量联合只为过类型，值不变。下同（type 一处）。
  // 标题读取顺序（#1480 两轴评审修）：
  //   ① 可见一级标题 —— 旧 deck 文件与手写原文模板都还有它，旧读法一个字节不变；新布局 `# NN: 标题` 在下面剥掉编号前缀（#1500，与写侧 cleanTitle 同一个口径）；
  //   ② 文件头 DSH-TITLE 隐藏注释 —— 新布局的规格与地图没有可见一级标题，标题值只在这里；
  //   ③ 降级：容器（规格/地图）先用目录名（effortId）、没有再用文件名去 .md；其余票先文件名、
  //      再首个非空且不是注释的行。降级不报错，也绝不把「## Problem Statement」这类段名当标题。
  const title = (() => {
    const h1 = /^#[ \t]+(.+)$/m.exec(raw)
    if (h1) return h1[1].trim().replace(/^\d{1,3}:[ \t]*/, '')
    const hiddenTitle = hiddenHeaderValue(raw, 'DSH-TITLE')
    if (hiddenTitle) return hiddenTitle
    const fileBase = fileBaseTitle(meta && meta.url)
    if ((meta && meta.kind === 'spec') || (meta && meta.isMap)) {
      return String((meta && meta.effortId) || '').trim() || fileBase || 'untitled'
    }
    if (fileBase) return fileBase
    const first = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !/^<!--/.test(l)) || ''
    return first.replace(/^#+\s*/, '').trim() || 'untitled'
  })()
  // #1489：地图子票的 Type 行是裸写法；加粗包法是实施票/手写模板的通用写法，这里一并认。
  const typeRaw = (/^\s*(?:\*\*)?Type(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*([^\n]+)/im.exec(field)?.[1]?.trim().toLowerCase() || '')
  let customFields
  if (typeRaw) {
    customFields = [{ name: 'Type', value: typeRaw, type: 'single', options: ['research', 'prototype', 'grilling', 'task'] }]
  }
  const blockedRaw = (/^\s*(?:\*\*)?Blocked\s+by(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*(.+)$/im.exec(field)?.[1]?.trim() || '')
    || splitHiddenList(hiddenHeaderValue(raw, 'DSH-BLOCKED-BY')).join(', ')
  let blockedBy = []
  if (blockedRaw) {
    const parts = blockedRaw.split(/[,,\s]+/).map((s) => s.trim()).filter(Boolean)
    // above split uses comma, fullwidth comma, whitespace
    const realParts = blockedRaw.split(/[,\uFF0C\s]+/).map((s) => s.trim()).filter(Boolean)
    const useParts = realParts.length ? realParts : parts
    for (const p of useParts) {
      const m = /#?(\d+)/.exec(p)
      if (m) {
        const k = String(m[1]).padStart(2, '0')
        blockedBy.push({ key: k, title: '', state: STATE.OPEN })
      }
    }
  }
  // Labels: 调色盘模型（#312 定版）——票只写名，色在总表，缺行按空、非法段丢弃、没冒号视为缺行；兼容历史单数 Label:
  // #634：每段先经 stripLabelDecoration 剥掉外层成对引号/反引号（照抄文档代码写法写进来的那层），
  //   剥完全空的段一样按「非法段丢弃」处理，与原来的空段口径一致。
  let labels = []
  const labelsMatch = /^\s*(?:\*\*)?Labels?(?:\*\*)?\s*[:\uFF1A][ \t]*(?:\*\*)?[ \t]*([^\n]*)/im.exec(field)
  if (labelsMatch) {
    const rawNames = labelsMatch[1] || ''
    // 逗号（含全角）分隔，仅名字
    const parts = rawNames.split(/[,\uFF0C]+/)
    for (const part of parts) {
      const name = stripLabelDecoration(part)
      if (!name) continue
      // 颜色留空：由 applyLabelColors 按配色文件与内置默认色填上（没填就是空串=界面按灰显示）
      labels.push({ name, color: '', description: '' })
    }
  } else {
    // 新布局把标签写在 DSH-LABELS 隐藏注释里；没有这一行才按空（不抛、空数组）。
    for (const name of splitHiddenList(hiddenHeaderValue(raw, 'DSH-LABELS'))) {
      const clean = stripLabelDecoration(name)
      if (clean) labels.push({ name: clean, color: '', description: '' })
    }
  }
  let comments = []
  const cmAnchor = /^\s*##\s*Comments\s*$/im
  const cmExec = cmAnchor.exec(raw)
  if (cmExec) {
    const start = cmExec.index + cmExec[0].length
    const after = raw.slice(start)
    const nextH2 = /^\s*##\s+/m.exec(after)
    const segment = nextH2 ? after.slice(0, nextH2.index) : after
    const blocks = segment.split(/^###\s+/m).map((s) => s.trim()).filter(Boolean)
    for (const b of blocks) {
      if (!b) continue
      const lines = b.split('\n')
      const header = lines[0]?.trim() || ''
      let login = 'local'
      let createdAt = ''
      const dashIdx = header.indexOf('\u2014')
      const dashIdx2 = header.indexOf('-')
      let sep = -1
      if (dashIdx >= 0) sep = dashIdx
      else if (dashIdx2 >= 0) sep = dashIdx2
      if (sep >= 0) {
        login = header.slice(0, sep).trim() || 'local'
        const datePart = header.slice(sep + 1).trim()
        const iso = /\d{4}-\d{2}-\d{2}T/.exec(datePart) ? datePart.match(/\d{4}-\d{2}-\d{2}T[^ \n]+/)?.[0] : ''
        if (iso) createdAt = iso
      } else if (header) {
        login = header.split(/\s+/)[0] || 'local'
      }
      const bodyPart = lines.slice(1).join('\n').trim()
      const body = bodyPart.split(/^---\s*$/m)[0]?.trim() || bodyPart
      if (!body && !header) continue
      comments.push({
        author: { login },
        authorAssociation: '',
        body: body || '',
        createdAt: createdAt || (meta && meta.createdAt) || '',
        updatedAt: createdAt || (meta && meta.updatedAt) || '',
      })
    }
  }
  const key = String((meta && meta.key) || '00')
  // #1277：对象类型看文件头那行隐藏标记（ADR 2.5：标记是唯一真源，标签与正文形状只作兜底）。
  // #1403：判定顺序与 T1 三房口径一致 —— 标记 → 类型标签（wayfinder:map）→ 正文形状（地图文件本身 / 老的 Type: map）。
  //   先把标记判完：spec 标记是规格容器，ticket 标记是实施票（契约类型仍是普通票），这两种都不许被标签改判；
  //   然后才看 wayfinder:map 标签：新建的地图票不再写 Type: map，只带这一枚标签，不认它就会读成普通票；
  //   最后才是老的形状判据（map.md 本身、或老文件里的 Type: map），保证老数据照旧读得对。
  const markedKind = markerKindInHeader(raw)
  const metaKind = String((meta && meta.kind) || '').trim().toLowerCase()
  const hasMapLabel = labels.some((one: { name?: unknown }) => String((one && one.name) || '').trim().toLowerCase() === 'wayfinder:map')
  let type: IssueType
  if (metaKind === 'spec') type = ISSUE_TYPE.SPEC
  else if (metaKind === 'map') type = ISSUE_TYPE.MAP
  else if (markedKind === 'spec') type = ISSUE_TYPE.SPEC
  else if (markedKind === 'ticket') type = ISSUE_TYPE.ISSUE
  else if ((meta && meta.isMap) || hasMapLabel || typeRaw === 'map') type = ISSUE_TYPE.MAP
  else type = ISSUE_TYPE.ISSUE
  // #971：父子关系以文件顶注释为准，有注释就用注释，没有注释的老文件才回落。
  // 地图文件本身没有父票（恒为空）；计划里用票文件冒充的地图（正文写着 Type: map、却没有父注释）同样视作没有父票。
  // #1403：规格是顶层容器，盘中没写父注释就是没有父票 —— 本地房老数据里规格可能落在默认 00（根地图）下，
  //   新口径不认这个默认；有老父注释的规格仍按注释读（存量票不回填）。规格的判定看上面的对象类型：标记优先后 type 就是 spec。
  // 其余票没有注释时沿用调用方递进来的固定值（今天是 00，即老单根工作区的地图），保持老数据行为不变。
  const fileParent = parentKeyFromFile(raw)
  let parentKey = null
  if (meta && meta.isMap) {
    parentKey = null
  } else if (metaKind === 'spec' || metaKind === 'map') {
    // #1486：新布局的规格/地图文件由调用方用 meta.kind 指明，顶层容器没有父票。
    parentKey = null
  } else if (fileParent.found) {
    parentKey = fileParent.value
  } else if (hasMapLabel || typeRaw === 'map') {
    // #1403：带 wayfinder:map 标签的新地图票没有父票（标签就是它的容器身份）；老文件里的 Type: map 同样算。
    parentKey = null
  } else if (type === ISSUE_TYPE.SPEC) {
    // #1403：规格没有父注释时就是顶层容器，不回落调用方给的 00。
    parentKey = null
  } else {
    parentKey = meta && meta.parentKey !== undefined ? meta.parentKey : null
  }
  if (typeof parentKey === 'string') {
    const t = parentKey.trim()
    if (!t) parentKey = null
    else if (/^\d+$/.test(t)) parentKey = t.padStart(2, '0')
    else parentKey = t
  }
  if (parentKey === '') parentKey = null
  // effort 维度：effort 是核心字段（永远存在）；扁平布局 / 单 effort 后端填 ''（EMPTY）
  const effortId = String((meta && meta.effortId) || '')
  // #1174 决策 10：创建时间**优先取文件里写下来的那一行**（写下来就不动了），没有这一行的老票才回落到
  // 调用方给的（本地是文件修改时间）。更新时间仍取调用方给的（本地就是文件修改时间，改一次变一次）。
  const fileCreated = createdStampFromFile(raw)
  const createdAt = (fileCreated.found ? fileCreated.value : '') || (meta && typeof meta.createdAt === 'string' ? meta.createdAt : '') || ''
  const updatedAt = (meta && typeof meta.updatedAt === 'string' ? meta.updatedAt : '') || ''
  // 地址（#1142）：本地后端的票就是工作区里的文件，所以一张票的地址就是它所在的那个文件的路径。
  // 只有真正读/写这个文件的那一层知道路径 —— 文件名里还带标题转出来的后缀（01-hello-world.md），
  // 光有编号是拼不出来的，所以由调用方经 meta.url 传进来；没传就是空串（例如只借 parseMd 做纯文本解析）。
  const url = (meta && typeof meta.url === 'string') ? meta.url : ''
  const closedAt = state === STATE.CLOSED ? (updatedAt || createdAt || '') : null
  const issue: Issue = {
    key,
    effortId,
    type,
    title,
    state,
    body: raw,
    url,
    createdAt,
    updatedAt,
    closedAt,
    parentKey,
    blockedBy,
    comments,
    labels,
  }
  if (customFields) issue.customFields = customFields
  // #1174 决策 12：认领人**原样读回来**。票面上写着 `Assignees:` 那一行时，读的就是那几个名字；
  // 没有这一行的老票（写的人还没经过这次改动）落到老口径：认领了、但这份文件没记下是谁，就诚实给空名字
  // ——「本地用户名或 ''」本来就是契约允许的值（contract/identity.ts 对 login 的说法），
  // 而 `@me` 是个占位符，它既不是调用方给的名字、也不是本地用户名。
  // 没有 Status 行的票照样给出认领人（空数组 = 明确没人认领）。
  //
  // 这一格以前是「有 Status 行才挂 assignees，没有就整个字段省略」，理由是「认领状态未知」。
  // 但本地 Markdown 的票面里，未开始且没人认领本来就写成「没有 Status 行」（原文 wayfinder 的
  // Status 行只有 claimed/resolved 两档），所以「没有这一行」不是不知道，而是一个确定的意思。
  // 省略字段会让 deck 的派生判定把它算成 indeterminate（不认识领态），结果是新建的子票
  // 与所有没补过 Status 的老票都不进 frontier —— 实测一张地图 7 张子票全部被判 indeterminate、
  // frontier 为 0（2026-10-30，票 #02）。认领态这个问题，本地这一侧总能回答，就不该说「不知道」。
  //
  // 顺序不变：有 Assignees 行（或 DSH-ASSIGNEES 注释）就原样读名字；没有这一行但写着 claimed，
  // 仍给一个空名字表示「认领了、但没记下是谁」；其余（含没有 Status 行）都是空数组。
  {
    const named = assigneesFromFile(raw)
    if (named.found) issue.assignees = named.value
    else if (statusNorm === 'claimed') issue.assignees = [{ login: '', kind: 'user' }]
    else issue.assignees = []
  }
  if (state === STATE.CLOSED) issue.reason = closeReasonFromFile(raw) || 'completed'
  else issue.reason = ''
  return issue
}

export default parseMd
export { slugify }