// parse-fields.ts —— 票面字段读取这一族：父票 / 创建时间 / 隐藏头 / 围栏剥离 / 关票原因 / 认领人。
//
// 为什么单列一份：parse.ts 贴着「单文件 350 有效行」那条线（tests/verify-file-granularity.ts），
// 而「从票面或文件头读回一个字段」本来就是一簇同形函数（都只认文件头、都先剥围栏），
// 拆出来两边都不必为了行数去砍注释。parse.ts 仍原样转出这些函数，调用方不用改导入点。

import { hiddenCommentOf } from './original-fields.js'

/** 从票文件正文里读出文件顶写着的父票编号（#971）。
 *
 *  为什么要有这一步：建票时父票编号写在文件顶的注释里（例如 <!-- parentKey: 01 -->），
 *  但读回与列举一直用调用方递进来的固定值（永远是 00），注释写了却从不读。
 *  扁平布局里地图本身是 01 号，固定值 00 永远对不上，按地图筛选恒为 0，快照数不出子票。
 *  这里把注释读回来：有注释就以注释为准，没有注释的老文件才回落到调用方给的值。
 *
 *  返回 {found, value}：found 表示文件里有没有这一行注释；
 *  value 是归一后的父票编号（数字补成两位），空值与 null 字样都归成 null（根票，没有父票）。
 *  只认 parentKey 这一行，不认幂等锚那一行（锚是 DSH-IDEMPOTENCY-KEY，不是父子关系）。 */
export function parentKeyFromFile(text: unknown): { found: boolean; value: string | null } {
  const raw = String(text || '')
  // 只看文件头（标题之前的那几行）：父注释是文件元数据，写在最前（锚之后、标题之前）。
  // 正文里也可能出现同样的写法（例如文档里举例怎么写注释），那一行不算数。
  // 没有标题的坏文件退化成只看前 10 行，照样够到文件头。
  const h1 = /^#+\s+/m.exec(raw)
  const head = h1 ? raw.slice(0, h1.index) : String(raw).split('\n').slice(0, 10).join('\n')
  const m = /^[ \t]*<!--[ \t]*(?:parentKey|DSH-PARENT)[ \t]*:[ \t]*(.*?)-->/im.exec(head)
  if (!m) return { found: false, value: null }
  const v = String(m[1] || '').trim()
  if (!v) return { found: true, value: null }
  if (/^null$/i.test(v) || /^none$/i.test(v) || v === '-') return { found: true, value: null }
  if (/^\d+$/.test(v)) return { found: true, value: v.padStart(2, '0') }
  return { found: true, value: v }
}

/** 从票文件顶上读出「这张票是什么时候建的」（#1174 决策 10）。
 *
 *  为什么要有这一步：契约要求按页取票的排序键是**创建时间倒序**，理由是「翻页期间有人改票也不会
 *  让票在页与页之间挪位置」（contract-page 的「翻页稳定」那一段）。而本地这一侧的创建时间一直取的是
 *  票文件的**修改时间**——关票、加评论、改标签都会重写文件，于是「创建时间」每改一次就变一次，
 *  排序键实际是「最近修改时间倒序」，契约选创建时间的那个理由正好落空。
 *
 *  怎么修：建票时把创建时刻写进文件顶的一行注释，以后每次写回都原样保留、不再改动。老票（没有这一行）
 *  继续回落到文件修改时间，与今天的行为一模一样 —— 不回填，因为回填等于拿「第一次被写的时间」假装成
 *  「建票的时间」，那是编一个数出来。
 *
 *  只认文件头（第一个可见标题之前的那几行），理由与 parentKeyFromFile 相同：正文里举例写同样的注释不算数。
 *  这里用 /^#+\s+/ 截头，一级与二级都算标题：#1480 之后规格与地图没有一级标题，第一个可见标题是段标题「## ...」。 */
export function createdStampFromFile(text: unknown): { found: boolean; value: string } {
  const raw = String(text || '')
  const h1 = /^#+\s+/m.exec(raw)
  const head = h1 ? raw.slice(0, h1.index) : String(raw).split('\n').slice(0, 10).join('\n')
  const m = /^[ \t]*<!--[ \t]*(?:created|DSH-CREATED)[ \t]*:[ \t]*(.*?)-->/im.exec(head)
  if (!m) return { found: false, value: '' }
  const v = String(m[1] || '').trim()
  return v ? { found: true, value: v } : { found: false, value: '' }
}

/** 读文件头里某一条隐藏注释的值（#1486）。
 *
 *  新布局把状态、父票、标签、认领人、阻塞边都写进 `<!-- DSH-XXX: ... -->`，可见正文里不再出现这些行。
 *  只认第一个可见标题之前的那几行：正文里举例写同样的注释不算数，理由与 parentKeyFromFile 相同。
 *  截头用 /^#+\s+/：规格与地图没有一级标题，第一个可见标题是正文第一个段标题「## ...」，注释头仍只到它为止。
 *  返回值里只保留这一行本身，不跨行 —— 一行一条是 YAML 里定死的形状。 */
export function hiddenHeaderValue(text: unknown, name: string): string {
  const raw = String(text || '')
  const h1 = /^#+\s+/m.exec(raw)
  const head = h1 ? raw.slice(0, h1.index) : raw.split('\n').slice(0, 16).join('\n')
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp('^[ \\t]*<!--[ \\t]*' + escaped + '[ \\t]*:[ \\t]*(.*?)-->', 'im').exec(head)
  return m ? String(m[1] || '').trim() : ''
}

/** 把隐藏注释里的名单拆成若干段：逗号、全角逗号、顿号都算分隔。 */
export function splitHiddenList(value: string): string[] {
  return String(value || '').split(/[,\uFF0C\u3001]+/).map((one) => one.trim()).filter(Boolean)
}

/** 把正文里的围栏代码块整段抹掉，只留下「票面」本身。
 *
 *  为什么要这一步（#1174 复核 P1-3）：字段行是按文本正则找的，而正文里很容易出现**举例**写下的同一行 ——
 *  比如文档里写「在票文件里加一行 `Assignees: 张三`」，那句话就躺在围栏里。照全文找，那行会被当成真字段，
 *  于是认领人变成正文里抄来的那个名字、关票原因变成举例里的那句话。围栏里的内容是给人看的例子，不是字段。
 *
 *  拿空格行替换、不删行：行号与行数保持原样，按位置切分的调用方（例如只认文件头的读法）不会错位。 */
export function stripFencedCode(text: unknown): string {
  const raw = String(text || '')
  const out: string[] = []
  let fenced = false
  for (const line of raw.split('\n')) {
    if (/^[ \t]*(```|~~~)/.test(line)) { fenced = !fenced; out.push(''); continue }
    out.push(fenced ? '' : line)
  }
  return out.join('\n')
}

/** 关票原因：票面上 `Close reason:` 那一行的值（#1174 决策 8）。
 *
 *  为什么要存：契约的 `close` 签名收 `CloseOpts.reason`，本地房以前把它丢了，回读时不管调用方给的是什么
 *  都写 `completed`。现在调用方给了就原样存、原样读回；没这一行的老票仍然按后端默认 `completed`。
 *  取值是开放字符串（契约 `contract/identity.ts` 对 `ClosedReason` 的说法），这里不判合法与否。 */
export function closeReasonFromFile(text: unknown): string {
  const m = /^[ \t]*Close[ \t]+reason[ \t]*[:\uFF1A][ \t]*(.*)$/im.exec(stripFencedCode(text))
  return m ? String(m[1] || '').trim() : ''
}

/** 从指派入参里取出登录名（#1174 决策 12）：契约允许只给一个名字，也允许给完整形状。
 *
 *  取不出名字的（空串、形状里 login 不是字符串）一律丢掉，不写成一行空名字 ——
 *  那会读成「有人认领，但名字是空的」，与「明确没人认领」是两回事。
 *  住在 parse 这一件里：建票（写 `Assignees:` 行）与改认领人都要用，两处必须是同一把尺子。 */
export function loginOfAssignee(a: unknown): string {
  if (typeof a === 'string') return a.trim()
  if (a && typeof a === 'object' && typeof (a as { login?: unknown }).login === 'string') {
    return String((a as { login: string }).login).trim()
  }
  return ''
}

/** 从票面上读出「这张票指派给了谁」（#1174 决策 12）。
 *
 *  读的是 `Assignees:` 这一行（名字之间用逗号或顿号分隔）。这一行是这次改动新加的：以前认领只写
 *  `Status: claimed`，谁认领的没地方放，回读时只能给一个 `@me` 占位符 —— 调用方看到的名字既不是
 *  自己给的那个、也不是本地用户名（契约 `contract/identity.ts` 对 login 的说法是「本地用户名或空串」）。
 *
 *  返回 `{found, value}`，两件事分开：`found` 表示票面上有没有这一行 —— 有、但值是空的，是
 *  「明确没人认领」（值为 `[]`）；根本没有这一行，才是「这份文件没记下是谁」。这两种在契约里是
 *  不同的意思（`contract/entities.ts` 对 `assignees: []` 与字段省略的区别有专门说明），不能混成一个值。 */
export function assigneesFromFile(text: unknown): { found: boolean; value: Array<{ login: string; kind: 'user' }> } {
  const raw = stripFencedCode(text)
  const m = /^[ \t]*Assignees[ \t]*[:\uFF1A][ \t]*(.*)$/im.exec(raw)
  if (!m) {
    // #1486：新布局的认领人写在 DSH-ASSIGNEES 隐藏注释里；有这一行就按它读。
    // #1489：读「有没有这一行」而不是「值空不空」：`<!-- DSH-ASSIGNEES:  -->` 是插件写下的
    //   明确空名单（解除认领后留的痕迹），与根本没有这一行（这份文件没记下是谁）不是一回事。
    const hidden = hiddenCommentOf(raw, 'DSH-ASSIGNEES')
    if (!hidden.found) return { found: false, value: [] }
    const names = splitHiddenList(hidden.value)
    return { found: true, value: names.map((login) => ({ login: login, kind: 'user' as const })) }
  }
  const names = String(m[1] || '').split(/[,\uFF0C]+/).map((s) => s.trim()).filter(Boolean)
  return { found: true, value: names.map((login) => ({ login: login, kind: 'user' as const })) }
}
