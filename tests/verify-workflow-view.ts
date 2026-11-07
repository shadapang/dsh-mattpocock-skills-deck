/**
 * tests/verify-workflow-view.ts —— 工作流视图的「顺序与准入」门禁（#1674）
 *
 * 这张票解决两个真痛（维护者 2026-10-30 定）：
 *   ① 任务卡不断冒、永远做不完 → 一条工作流同时只放一张「可接」，其余排队；
 *   ② 不同会话重复做同一张卡 → 有认领人的卡不进「可接」，标「在做」。
 *
 * 本门禁钉判定本身（纯函数）与接线：
 *   · 依赖拓扑分层（链、并行、环切断）；
 *   · 准入顺序：closed → running（有认领人）→ blocked（有未关闭的挡路票）→ ready，候选只放 WIP 张；
 *   · 排队名次、焦点卡、连线只留泳道内；
 *   · 列表页默认工作流视图（listView 缺省按 flow）、两个新叶子已登记进构建与客户端拼接表。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-workflow-view.ts
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireHere = createRequire(import.meta.url)
let failed = false
let total = 0
const check = (ok: unknown, msg: string) => {
  total++
  if (ok) console.log('  PASS ' + msg)
  else { failed = true; console.log('  FAIL ' + msg) }
}
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b)

const root = path.resolve(import.meta.dirname, '..')
const mod = await import(pathToFileURL(path.join(root, 'src/client/views/workflowLayout.ts')).href)
const { workflowDepths, workflowLaneOf, workflowLanesOf, workflowEdgesOf, workflowFocusOf, workflowRunnableOf, workflowRunPromptOf, WF_WIP_LIMIT } = mod as any

const T = (key: string, number: number, extra: any = {}) => ({
  key, number, title: 'T' + key, effortId: 'w1', closed: false, assignees: [], blockedBy: [], ...extra,
})

console.log('== ① 依赖拓扑：链、并行、环 ==')
{
  const chain = [T('1', 1), T('2', 2, { blockedBy: ['1'] }), T('3', 3, { blockedBy: ['2'] })]
  const d1 = workflowDepths(chain)
  check(d1.get('1') === 0 && d1.get('2') === 1 && d1.get('3') === 2, '① 链 1→2→3 的深度是 0/1/2')

  const diamond = [T('1', 1), T('2', 2, { blockedBy: ['1'] }), T('3', 3, { blockedBy: ['1'] }), T('4', 4, { blockedBy: ['2', '3'] })]
  const d2 = workflowDepths(diamond)
  check(d2.get('2') === 1 && d2.get('3') === 1 && d2.get('4') === 2, '① 分叉 2/3 同层、汇合点 4 在下一层')

  const cyc = [T('1', 1, { blockedBy: ['2'] }), T('2', 2, { blockedBy: ['1'] })]
  const d3 = workflowDepths(cyc)
  // 环本身无解，要求只有一条：不死循环、深度有界；渲染出来两张都算「被挡」（互相挡着，谁也不能开工）。
  check([...d3.values()].every((v: any) => typeof v === 'number' && v >= 0 && v <= cyc.length), '① 环不死循环：深度有界（' + JSON.stringify([...d3.entries()]) + '）')
  const cycLane = workflowLaneOf('w1', cyc)
  check(cycLane.cards.every((c: any) => c.state === 'blocked'), '① 环里两张都判「被挡」，谁也不会被当成可接')
}

console.log('== ② 准入顺序与 WIP：同时只有一张可接 ==')
{
  const tickets = [
    T('1', 1),
    T('2', 2, { blockedBy: ['1'] }),
    T('3', 3, { blockedBy: ['2'] }),
  ]
  const lane = workflowLaneOf('w1', tickets)
  const byKey = new Map(lane.cards.map((c: any) => [c.key, c.state]))
  check(byKey.get('1') === 'ready' && byKey.get('2') === 'blocked' && byKey.get('3') === 'blocked', '② 只有队首可接，后面的被挡')
  check(WF_WIP_LIMIT === 1, '② WIP 上限默认是 1（这就是「做不完」的处方）')

  // 队首被认领 → 后续不再补位（别人在做，就等于这一波满了）
  const running = workflowLaneOf('w1', [T('1', 1, { assignees: ['lead'] }), T('2', 2, { blockedBy: ['1'] })])
  const st2 = new Map(running.cards.map((c: any) => [c.key, c.state]))
  check(st2.get('1') === 'running' && st2.get('2') === 'blocked', '② 有认领人的卡是「在做」，不会重复派给另一个会话')

  // 两张都没依赖：第一张可接、第二张排队，并带名次
  const two = workflowLaneOf('w1', [T('2', 2), T('1', 1)])
  const s3 = new Map(two.cards.map((c: any) => [c.key, c]))
  check(s3.get('1').state === 'ready' && s3.get('2').state === 'queued', '② 同层两张：编号小的可接，另一张排队')
  check(s3.get('2').queuePos === 1 && two.queued === 1 && two.ready === 1, '② 排队名次与统计对得上')

  // 前置全关 → 下一张自动变成可接
  const advanced = workflowLaneOf('w1', [T('1', 1, { closed: true }), T('2', 2, { blockedBy: ['1'] })])
  const s4 = new Map(advanced.cards.map((c: any) => [c.key, c.state]))
  check(s4.get('1') === 'closed' && s4.get('2') === 'ready', '② 前置关闭后，下一张自动升为可接')
}

console.log('== ③ 连线与泳道：只连自己这条工作流 ==')
{
  const lane = workflowLaneOf('w1', [T('1', 1), T('2', 2, { blockedBy: ['1', '9'] })])
  const edges = workflowEdgesOf(lane)
  check(edges.length === 1 && edges[0].from === '1' && edges[0].to === '2', '③ 跨泳道的挡路票不画线（#9 不在本泳道）')

  const lanes = workflowLanesOf([
    T('1', 1, { effortId: 'b' }),
    T('2', 2, { effortId: 'a' }),
    T('3', 3, { effortId: '' }),
  ], ['a', 'b'])
  check(lanes.map((l: any) => l.effortId).join(',') === 'a,b,', '③ 泳道顺序按传入的工作流名，空分组排最后')

  const focus = workflowFocusOf(workflowLaneOf('w1', [T('1', 1), T('2', 2)]))
  check(focus && focus.key === '1', '③ 焦点卡 = 当前这一张（没有 running 时取队首可接）')
}

console.log('== ④ 接线：默认工作流视图，两个叶子已登记 ==')
{
  const { sourceText } = requireHere('./lib/source-text.ts')
  const listTab = sourceText('src/client/views/ListTab.ts')
  const build = sourceText('scripts/build.mts')
  const indexSrc = sourceText('src/client/index.ts')
  const view = sourceText('src/client/views/WorkflowView.ts')
  check(/st\.listView === 'cards'/.test(listTab), '④ 任务卡视图要显式选中；缺省（undefined）= 工作流视图')
  check(/WorkflowViewNode\(st, narrow\)/.test(listTab), '④ 列表页调用了 WorkflowViewNode(st, narrow)')
  check(build.indexOf("workflowLayout', file: 'src/client/views/workflowLayout.ts") >= 0 && build.indexOf("WorkflowView', file: 'src/client/views/WorkflowView.ts") >= 0, '④ 两个叶子已登记进构建清单')
  check(indexSrc.indexOf('leaf:workflowLayout') >= 0 && indexSrc.indexOf('leaf:WorkflowView') >= 0, '④ 客户端拼接表里有两个叶子的标记')
  check(/setActiveIssue\(st, card\.number, card\.effortId\)/.test(view), '④ 点卡片进票详情（带 effortId，多工作单元不会串号）')
}

console.log('== ⑤ 执行全部：只列没关的票，顺序按依赖深度再按编号 ==')
{
  const tickets = [
    T('1', 1, { closed: true }),
    T('2', 2, { blockedBy: ['1'] }),
    T('3', 3, { blockedBy: ['2'] }),
    T('4', 4, { assignees: ['lead'] }),
  ]
  const lane = workflowLaneOf('w1', tickets)
  const runnable = workflowRunnableOf(lane)
  check(eq(runnable.map((c: any) => c.key), ['4', '2', '3']), '⑤ 执行顺序：先无依赖的 #4，再 #2、#3；已关闭的 #1 不进')
  check(runnable.every((c: any) => !c.closed), '⑤ 提示词不会带上已关闭的票')

  const zh = workflowRunPromptOf(lane, 'zh')
  check(/^\- #4 /m.test(zh) && /^\- #2 /m.test(zh) && /^\- #3 /m.test(zh), '⑤ 中文提示词逐行列出要推进的票')
  check(!/^\- #1 /m.test(zh), '⑤ 中文提示词不列 #1（只作为 #2 的挡路票出现）')
  check(zh.indexOf('Acceptance') >= 0 && zh.indexOf('wayfinder:*') >= 0, '⑤ 中文提示词带上派工门禁（验收 + 决定票不派）')
  check(zh.indexOf('最多 2 张') >= 0, '⑤ 中文提示词写明每波 ≤2')

  // 真被挡的票（挡路票还开着）要把挡路票写进提示词，子代理才知道等谁。
  const blockedZh = workflowRunPromptOf(workflowLaneOf('w1', [T('1', 1), T('2', 2, { blockedBy: ['1'] })]), 'zh')
  check(blockedZh.indexOf('被 #1 挡住') >= 0, '⑤ 被挡的票写清挡路票')

  const en = workflowRunPromptOf(lane, 'en')
  check(/^\- #4 /m.test(en) && en.indexOf('Acceptance') >= 0 && en.indexOf('at most 2') >= 0, '⑤ 英文提示词同样自包含')
}

console.log('== ⑥ 折叠与「执行全部」按钮的接线 ==')
{
  const { sourceText } = requireHere('./lib/source-text.ts')
  const view = sourceText('src/client/views/WorkflowView.ts')
  const yaml = sourceText('config/copy/flow.yaml')
  check(/st\.wfFold/.test(view), '⑥ 折叠状态落在会话状态（st.wfFold[effortId]），不新增票字段')
  check(/dsws\.wfFold/.test(view) && /localStorage\.setItem/.test(view), '⑥ 折叠状态按工作区存本机（dsws.wfFold.<工作区>）')
  check(/!st\.wfFold/.test(view) && /localStorage\.getItem/.test(view), '⑥ 第一次画时从本机存储接回折叠状态')
  check(/inject\(st, workflowRunPromptOf\(lane/.test(view), '⑥ 执行全部把这条泳道的提示词注入当前会话')
  check(/tr\('wf\.runLane'/.test(view) && /tr\('wf\.runLaneShort'/.test(view), '⑥ 执行入口文案走词表（宽 / 窄两套）')
  check(/tr\('wf\.pct'/.test(view) && /tr\('wf\.pctRunning'/.test(view), '⑥ 泳道头两行：进度 / 在做什么')
  check(/tr\('wf\.foldedNext'/.test(view) && /tr\('wf\.foldedDone'/.test(view), '⑥ 折叠行说清「下一站」与「全完成」')
  check(/tr\('wf\.summary'/.test(view), '⑥ 折叠后仍给出可接/排队/被挡的摘要')
  check(['wf.runLane:', 'wf.runLaneN:', 'wf.runLaneShort:', 'wf.pct:', 'wf.pctRunning:', 'wf.foldedNext:', 'wf.foldedDone:', 'wf.summary:', 'wf.dirHint:', 'wf.dirOnly:'].every((k) => (yaml.split(k).length - 1) === 2), '⑥ 词表 zh / en 两段都补齐了新键')
}

console.log('== ⑦ 渲染冒烟：折叠、执行全部、全部完成三态 ==')
{
  // 渲染层是 build 拼接的叶子，运行时依赖同一闭包里的名字；这里用全局桩把闭包补出来，
  //   直接调 WorkflowViewNode 验「点得动、点对了、折叠后卡片真的不画」。
  const injected: string[] = []
  let emitted = 0
  const g = globalThis as any
  const hStub = (tag: any, props: any, children?: any) => {
    const list: any[] = []
    const push = (c: any) => {
      if (c == null || c === false || c === true) return
      if (Array.isArray(c)) { for (const x of c) push(x); return }
      list.push(c)
    }
    push(children)
    return { tag: typeof tag === 'string' ? tag : 'Component', props: props || {}, children: list }
  }
  g.h = hStub
  g.tr = (k: string) => k
  g.Tip = function TipStub() {}
  g.emit = () => { emitted++ }
  g.inject = (_st: any, text: string) => { injected.push(text) }
  g.promptLang = () => 'zh'
  g.setActiveIssue = () => {}
  g.effortNamesOf = () => ['w1']
  g.effortOf = (x: any) => (x && x.effortId) || ''
  g.containerKindOf = (x: any) => {
    if (!x) return null
    if (x.type === 'spec') return 'spec'
    if (x.type === 'map') return 'map'
    const labels = Array.isArray(x.labels) ? x.labels : []
    return labels.some((l: any) => l && l.name === 'wayfinder:map') ? 'map' : null
  }
  g.workflowLanesOf = workflowLanesOf
  g.workflowFocusOf = workflowFocusOf
  g.workflowRunPromptOf = workflowRunPromptOf
  g.WF_WIP_LIMIT = WF_WIP_LIMIT
  g.keyOf = (cwd: any) => cwd || ''
  // 本机存储桩：折叠状态要能读回来（刷新这件事的门禁）。
  const mem = new Map<string, string>()
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
    removeItem: (k: string) => { mem.delete(k) },
  }
  g.log = () => {}
  const wfMod = await import(pathToFileURL(path.join(root, 'src/client/views/WorkflowView.ts')).href)
  const render = (st: any) => (wfMod as any).WorkflowViewNode(st, false)
  const walk = (n: any, out: any[]) => {
    if (!n || typeof n !== 'object') return
    out.push(n)
    if (Array.isArray(n.children)) for (const c of n.children) walk(c, out)
  }
  const nodesOf = (v: any) => { const out: any[] = []; walk(v, out); return out }
  const textOf = (n: any): string => {
    if (n == null || n === false) return ''
    if (typeof n === 'string' || typeof n === 'number') return String(n)
    if (Array.isArray(n)) return n.map(textOf).join('')
    if (n.children) return n.children.map(textOf).join('')
    return ''
  }
  const st = { cwd: 'E:/demo', snapshot: { issues: [
    { number: 1, title: 'a', state: 'CLOSED', effortId: 'w1', assignees: [], blockedBy: [] },
    { number: 2, title: 'b', state: 'OPEN', effortId: 'w1', assignees: [], blockedBy: [1] },
    { number: 3, title: 'c', state: 'OPEN', effortId: 'w1', assignees: [], blockedBy: [2] },
  ] } }

  const nodes = nodesOf(render(st))
  const head = nodes.find((n: any) => n.props && n.props['data-log'] === 'list.wf.fold')
  const runBtn = nodes.find((n: any) => n.props && n.props['data-log'] === 'list.wf.runAll')
  check(!!head && textOf(head).indexOf('▾') >= 0, '⑦ 泳道头带展开箭头（默认展开）')
  check(textOf(head).indexOf('wf.pct') >= 0, '⑦ 泳道头第二行是进度（4 / 8 已完成）')
  check(!!runBtn && textOf(runBtn).indexOf('wf.runLane') >= 0, '⑦ 执行入口是 B 的头：按这条工作流执行')
  check(nodes.some((n: any) => String(n.props && n.props.key || '').indexOf('wf-card-w1-2') === 0), '⑦ 展开时画卡片')
  const narrowNodes = nodesOf((wfMod as any).WorkflowViewNode(st, true))
  check(narrowNodes.some((n: any) => textOf(n).indexOf('wf.runLaneShort') >= 0), '⑦ 窄面板执行入口收成「执行 · N」')

  runBtn.props.onClick({ stopPropagation: () => {} })
  check(injected.length === 1 && injected[0].indexOf('#2') >= 0, '⑦ 点执行注入提示词（含 #2）')
  check(emitted === 0, '⑦ 点执行不会误折叠（stopPropagation）')

  head.props.onClick({ stopPropagation: () => {} })
  check(st.wfFold && st.wfFold.w1 === true && emitted === 1, '⑦ 点泳道头折叠，状态落在 st.wfFold')
  check(mem.get('dsws.wfFold.E:/demo') === '["w1"]', '⑦ 折叠后按工作区写进本机存储（刷新还记得）')
  const foldedNodes = nodesOf(render(st))
  check(!foldedNodes.some((n: any) => String(n.props && n.props.key || '').indexOf('wf-card-w1-') === 0), '⑦ 折叠后卡片一条都不画')
  check(foldedNodes.some((n: any) => textOf(n).indexOf('wf.foldedNext') >= 0), '⑦ 折叠行给出「下一站」')
  check(foldedNodes.some((n: any) => textOf(n).indexOf('wf.summary') >= 0), '⑦ 折叠行给出可接/排队/被挡摘要')
  check(foldedNodes.some((n: any) => n.props && n.props['data-log'] === 'list.wf.runAll'), '⑦ 折叠后执行入口仍在（可以在折叠状态直接开跑）')

  // 刷新场景：新会话状态（还没有 wfFold）第一次画时，从本机存储接回折叠状态。
  const refreshed = { cwd: 'E:/demo', snapshot: { issues: [
    { number: 1, title: 'a', state: 'CLOSED', effortId: 'w1', assignees: [], blockedBy: [] },
    { number: 2, title: 'b', state: 'OPEN', effortId: 'w1', assignees: [], blockedBy: [1] },
  ] } }
  const refreshedNodes = nodesOf(render(refreshed))
  check((refreshed as any).wfFold && (refreshed as any).wfFold.w1 === true, '⑦ 刷新后第一次画就从本机存储接回折叠状态')
  check(!refreshedNodes.some((n: any) => String(n.props && n.props.key || '').indexOf('wf-card-w1-') === 0), '⑦ 刷新后仍是折叠态（卡片不画）')

  // 展开后要把存储里的那一条摘掉，不能只改内存。
  const head2 = foldedNodes.find((n: any) => n.props && n.props['data-log'] === 'list.wf.fold')
  head2.props.onClick({ stopPropagation: () => {} })
  check(mem.get('dsws.wfFold.E:/demo') === '[]', '⑦ 展开后存储里也摘掉（刷新保持展开）')

  // 泳道名：有人写的容器标题就用标题，不显示目录名；目录名进悬停提示。
  const titled = render({ cwd: 'E:/demo-titled', snapshot: {
    issues: [
      { number: 1, title: 'a', state: 'CLOSED', effortId: 'w1', parentKey: '00', assignees: [], blockedBy: [] },
      { number: 2, title: 'b', state: 'OPEN', effortId: 'w1', parentKey: '00', assignees: [], blockedBy: [1] },
    ],
    maps: [
      { key: '00', type: 'spec', title: '平台交接体检与换机复刻', effortId: 'w1', stats: { total: 2, closed: 1 } },
    ],
  } })
  const titledNodes = nodesOf(titled)
  const titledHead = titledNodes.find((n: any) => n.props && n.props['data-log'] === 'list.wf.fold')
  check(textOf(titledHead).indexOf('平台交接体检与换机复刻') >= 0, '⑦ 泳道名用人写的容器标题（不再直接显示目录名）')
  check(titledNodes.some((n: any) => n.props && typeof n.props.title === 'string' && n.props.title.indexOf('wf.dirHint') >= 0), '⑦ 悬停提示里保留目录名（wf.dirHint）')

  // 找不到容器的泳道：退回目录名，并在悬停里说清楚。
  const plainNodes = nodesOf(render({ cwd: 'E:/demo-plain', snapshot: { issues: [
    { number: 3, title: 'c', state: 'OPEN', effortId: 'raw-dir', assignees: [], blockedBy: [] },
  ] } }))
  const plainHead = plainNodes.find((n: any) => n.props && n.props['data-log'] === 'list.wf.fold')
  check(textOf(plainHead).indexOf('raw-dir') >= 0, '⑦ 没有地图/规格标题时退回目录名')
  check(plainNodes.some((n: any) => n.props && typeof n.props.title === 'string' && n.props.title.indexOf('wf.dirOnly') >= 0), '⑦ 退回目录名时悬停说明没有标题')

  const done = render({ snapshot: { issues: [
    { number: 1, title: 'a', state: 'CLOSED', effortId: 'w1', assignees: [], blockedBy: [] },
  ] } })
  const doneNodes = nodesOf(done)
  check(!doneNodes.some((n: any) => n.props && n.props['data-log'] === 'list.wf.runAll'), '⑦ 全部完成时不再给执行入口')
  check(doneNodes.some((n: any) => textOf(n).indexOf('wf.noneLeft') >= 0), '⑦ 全部完成时显示全部完成')
}

if (failed) {
  console.log('\n存在失败 — verify-workflow-view 未通过（失败项见上）')
  process.exit(1)
}
console.log('\n' + total + ' 条断言全部通过 — 工作流视图的顺序与准入符合 #1674 口径')
