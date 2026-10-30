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
const { workflowDepths, workflowLaneOf, workflowLanesOf, workflowEdgesOf, workflowFocusOf, WF_WIP_LIMIT } = mod as any

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

if (failed) {
  console.log('\n存在失败 — verify-workflow-view 未通过（失败项见上）')
  process.exit(1)
}
console.log('\n' + total + ' 条断言全部通过 — 工作流视图的顺序与准入符合 #1674 口径')
