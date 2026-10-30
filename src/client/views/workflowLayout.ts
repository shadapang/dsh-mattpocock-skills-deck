/**
 * views/workflowLayout.ts — 工作流视图的「顺序与准入」纯函数（#1674 工作流推进）
 *
 * 解决的两个真实痛点（维护者 2026-10-30 定）：
 *   1. 任务卡不断冒出来、永远做不完 —— 一条工作流同一时刻只放 **一张** 卡进入「可接」，
 *      其余一律「排队中」：顺序由依赖拓扑决定，不是谁新谁先。
 *   2. 不同会话可能重复处理同一张卡 —— 有认领人（另一条会话已经领走）的卡不进「可接」，
 *      只标「别人在做」，本会话不会把它排到队首。
 *
 * 纯函数：不碰 DOM、不读 st、不认识 h。渲染在 WorkflowView.ts，判定只在这一份文件里。
 */

/** 工作流视图里的一张卡：只留判定与排序要用的字段。 */
export interface WfTicket {
  key: string
  number: number
  title: string
  /** 分组键：本地 Markdown 后端是 effortId，远端后端是仓库（空串表示不分组）。 */
  effortId: string
  closed: boolean
  /** 认领人（login / 名字）；空数组 = 没人认领。 */
  assignees: string[]
  /** 挡路票的键（同一条工作流内匹配）。 */
  blockedBy: string[]
}

/** 一张卡的准入状态：closed 已完成 / running 有人在做 / ready 可接 / queued 排队中 / blocked 被挡。 */
export type WfState = 'closed' | 'running' | 'ready' | 'queued' | 'blocked'

export interface WfCard extends WfTicket {
  depth: number
  state: WfState
  /** 排队名次（只对 queued 有意义：前面还压着几张）。 */
  queuePos: number
}

export interface WfLane {
  effortId: string
  cards: WfCard[]
  total: number
  closed: number
  running: number
  ready: number
  queued: number
  blocked: number
}

/** 一条工作流同一时刻允许几张进入「可接」。默认 1：这是「做不完」的处方本身。 */
export const WF_WIP_LIMIT = 1

/**
 * 依赖拓扑分层：depth = 挡路票里最深的那个 + 1；没有挡路的 = 0。
 * 环（A 依赖 B、B 又依赖 A）按 0 切断，不让它把整个视图卡死。
 */
export function workflowDepths(tickets: WfTicket[]): Map<string, number> {
  const byKey = new Map<string, WfTicket>()
  for (const t of tickets) byKey.set(t.key, t)
  const out = new Map<string, number>()
  const walk = (key: string, stack: Set<string>): number => {
    const hit = out.get(key)
    if (hit !== undefined) return hit
    if (stack.has(key)) return 0
    const t = byKey.get(key)
    if (!t) return 0
    stack.add(key)
    let d = 0
    for (const b of t.blockedBy) {
      if (!byKey.has(b)) continue          // 挡路票不在本工作流里：不参与分层，交给 blocked 判定
      d = Math.max(d, walk(b, stack) + 1)
    }
    stack.delete(key)
    out.set(key, d)
    return d
  }
  for (const t of tickets) walk(t.key, new Set())
  return out
}

/**
 * 一条工作流的准入判定。顺序：
 *   closed → running（有认领人）→ 还有没关闭的挡路票 → blocked → 否则候选，
 * 候选里按 (depth, number) 排序，只放前 WIP_LIMIT 张为 ready，其余 queued。
 *
 * 为什么「有人认领」优先于「被阻塞」：认领是「这条已经在做了」，比「它理论上被谁挡着」更能回答
 * 「现在到底有没有人在重复做」。
 */
export function workflowLaneOf(effortId: string, tickets: WfTicket[], wipLimit = WF_WIP_LIMIT): WfLane {
  const depths = workflowDepths(tickets)
  const byKey = new Map<string, WfTicket>()
  for (const t of tickets) byKey.set(t.key, t)

  const cards: WfCard[] = tickets.map((t) => {
    const depth = depths.get(t.key) || 0
    let state: WfState
    if (t.closed) state = 'closed'
    else if (t.assignees.length > 0) state = 'running'
    else if (t.blockedBy.some((b) => { const dep = byKey.get(b); return dep ? !dep.closed : false })) state = 'blocked'
    else state = 'ready'
    return { ...t, depth, state, queuePos: 0 }
  })

  // 候选按依赖深度、再按编号排；前面不满 wipLimit 的才允许 ready。
  const candidates = cards
    .filter((c) => c.state === 'ready')
    .sort((a, b) => (a.depth - b.depth) || (a.number - b.number))
  const runningCount = cards.filter((c) => c.state === 'running').length
  let allowed = Math.max(0, wipLimit - runningCount)
  for (const c of candidates) {
    if (allowed > 0) { allowed--; continue }
    c.state = 'queued'
  }
  // 排队名次：按同一顺序数前面压着几张。
  const queued = cards.filter((c) => c.state === 'queued').sort((a, b) => (a.depth - b.depth) || (a.number - b.number))
  queued.forEach((c, i) => { c.queuePos = i + 1 })

  const count = (s: WfState) => cards.filter((c) => c.state === s).length
  return {
    effortId,
    cards,
    total: cards.length,
    closed: count('closed'),
    running: count('running'),
    ready: count('ready'),
    queued: count('queued'),
    blocked: count('blocked'),
  }
}

/** 按分组键切泳道：分组顺序按传入的工作流名顺序，没名字的排最后（单工作区仓库就只有一条）。 */
export function workflowLanesOf(tickets: WfTicket[], order: string[] = [], wipLimit = WF_WIP_LIMIT): WfLane[] {
  const groups = new Map<string, WfTicket[]>()
  for (const t of tickets) {
    const k = t.effortId || ''
    const bucket = groups.get(k)
    if (bucket) bucket.push(t); else groups.set(k, [t])
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)
    return a.localeCompare(b)
  })
  return keys.map((k) => workflowLaneOf(k, groups.get(k) || [], wipLimit))
}

/** 连线：只保留同泳道内的依赖边（A 挡 B → A→B），跨泳道不画（否则线会穿到别的项目上）。 */
export function workflowEdgesOf(lane: WfLane): Array<{ from: string; to: string }> {
  const keys = new Set(lane.cards.map((c) => c.key))
  const out: Array<{ from: string; to: string }> = []
  for (const c of lane.cards) for (const b of c.blockedBy) if (keys.has(b)) out.push({ from: b, to: c.key })
  return out
}

/**
 * 「不断冒出新的任务卡」的处方落地：只算**已经在推进**的那几张。
 * 返回这条工作流的当前焦点卡（可接或有人在做的那一张），没有则 null。
 */
export function workflowFocusOf(lane: WfLane): WfCard | null {
  const running = lane.cards.find((c) => c.state === 'running')
  if (running) return running
  const ready = lane.cards
    .filter((c) => c.state === 'ready')
    .sort((a, b) => (a.depth - b.depth) || (a.number - b.number))
  return ready[0] || null
}
