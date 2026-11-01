/**
 * views/WorkflowView.ts — 工作流视图的渲染层（#1674）
 *
 * 判定全在 workflowLayout.ts（纯函数、有门禁），这里只负责把一条泳道画出来：
 *   根卡（这条工作流 + 已完成 x/y + 进度条）→ 按依赖深度分层 → 每层一横排卡 → 层间竖线。
 * 卡片上直接回答维护者那两个痛点：
 *   · 「还冒不冒新卡」——只有一张标「可接」，其余标「排队第 N」，队列是可见的；
 *   · 「会不会重复做」——有认领人的标「别人在做 · 认领人」，本会话不会再去点它。
 *
 * 约定：本文件是 build 拼接的叶子（同 ListTab），下面 declare 的名字由闭包提供，不进产物的 import。
 */
declare function h(...args: any[]): any
declare function setActiveIssue(...args: any[]): any
declare function effortNamesOf(...args: any[]): any
declare function effortOf(...args: any[]): any
declare function containerKindOf(...args: any[]): any
// 折叠与「执行全部」（2026-11-01 维护者要）：折叠状态落在会话状态 st.wfFold，
// 执行按钮走既有 inject（注入当前会话输入框），提示词由 workflowLayout.ts 的纯函数给。
declare function tr(...args: any[]): any
declare function emit(...args: any[]): any
declare function inject(...args: any[]): any
declare function promptLang(...args: any[]): any
declare function workflowRunPromptOf(...args: any[]): any
declare const Tip: any
// 折叠状态的记性（2026-11-01 维护者要「刷新也要记住」）：用本机 localStorage，按工作区一把键。
declare function keyOf(...args: any[]): any
declare function log(...args: any[]): any
// 判定真源在 workflowLayout.ts（build 时同处一个闭包）：这里只声明、不 import，产物里不留痕。
declare function workflowLanesOf(...args: any[]): any
declare function workflowFocusOf(...args: any[]): any
declare const WF_WIP_LIMIT: any

/** 一张卡的状态色与文案：决定这条卡在界面上怎么读。 */
const WF_STATE_STYLE: Record<string, { color: string; bg: string; border: string; text: string }> = {
  closed: { color: '#3fb950', bg: '#16251b', border: '#2c5138', text: '已关闭' },
  running: { color: '#58a6ff', bg: '#161f29', border: '#2b4766', text: '在做' },
  ready: { color: '#c084fc', bg: '#211a2e', border: '#4a3a6b', text: '可接' },
  queued: { color: '#8b8b95', bg: '#1b1e24', border: '#3a3f4a', text: '排队' },
  blocked: { color: '#d8c58a', bg: '#221d12', border: '#4a4026', text: '被挡' },
}

/** 从快照里的票摊成工作流卡要的字段（只读快照，不碰票面）。 */
const wfTicketOf = function (x: any): any {
  const keyOf = function (v: any): string { const n = Number(v); return isFinite(n) ? String(n) : String(v == null ? '' : v) }
  const blocked = Array.isArray(x && x.blockedBy) ? x.blockedBy.map(keyOf) : []
  const assignees = Array.isArray(x && x.assignees)
    ? x.assignees.map(function (a: any) { return typeof a === 'string' ? a : String((a && (a.login || a.name)) || '') }).filter(Boolean)
    : []
  return {
    key: keyOf(x && (x.number != null ? x.number : x.key)),
    number: Number(x && x.number) || 0,
    title: String((x && x.title) || ''),
    effortId: String(effortOf(x) || ''),
    closed: String((x && x.state) || '').toUpperCase() === 'CLOSED',
    assignees,
    blockedBy: blocked,
  }
}

/** 卡片：编号 + 状态点 + 标题 + 状态徽标 + 认领人 / 排队名次。点整卡进详情（detailOf 由调用方给）。 */
const wfCardNode = function (st: any, effortId: string, card: any, narrow: boolean): any {
  const s = WF_STATE_STYLE[card.state] || WF_STATE_STYLE.queued
  const who = card.assignees.length ? card.assignees.join('、') : ''
  const sub = card.state === 'running' ? ('别人在做 · ' + who)
    : card.state === 'queued' ? ('排队第 ' + card.queuePos + ' 张')
      : card.state === 'blocked' ? ('被 ' + (card.blockedBy.length ? '#' + card.blockedBy.join('、#') : '上游') + ' 挡住')
        : card.state === 'ready' ? '现在接这一张'
          : ''
  return h('div', {
    key: 'wf-card-' + effortId + '-' + card.key,
    className: 'dsws-wfcard',
    'data-press': 'card',
    onClick: function () { try { setActiveIssue(st, card.number, card.effortId) } catch (e) {} },
    style: {
      border: '1px solid ' + s.border, background: s.bg, borderRadius: 9, padding: '7px 9px',
      cursor: 'pointer', opacity: card.state === 'closed' ? 0.62 : 1,
      minWidth: 0, flex: '1 1 0',
    },
  }, [
    h('div', { key: 'cn', style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#8b8b95', fontFamily: 'Consolas,"SF Mono",Menlo,monospace' } }, [
      h('span', { key: 'd', style: { width: 7, height: 7, borderRadius: '50%', background: s.color, flex: 'none' } }),
      h('span', { key: 'n' }, '#' + card.key),
      h('span', { key: 's', style: { marginLeft: 'auto', color: s.color, background: s.bg, border: '1px solid ' + s.border, borderRadius: 4, padding: '0 5px', fontSize: 10.5 } }, s.text),
    ]),
    h('div', {
      key: 't',
      style: {
        fontSize: 12.5, lineHeight: 1.4, marginTop: 3, color: '#e6edf3',
        textDecoration: card.state === 'closed' ? 'line-through' : 'none',
        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      },
    }, card.title),
    sub ? h('div', { key: 'sub', style: { marginTop: 5, fontSize: 10.5, color: s.color } }, sub) : null,
  ])
}

/** 层间竖线：一条居中的竖线 + 箭头（并排层也只用一条，避免窄面板里线打架）。 */
const wfConnNode = function (key: string, done: boolean): any {
  const color = done ? '#3a4a3e' : '#4a4258'
  return h('div', { key, style: { height: 18, position: 'relative', display: 'flex', justifyContent: 'center' } }, [
    h('div', { key: 'l', style: { width: 1.4, height: '100%', background: color } }),
    h('div', {
      key: 'a',
      style: { position: 'absolute', bottom: 0, left: '50%', marginLeft: -3, width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderTop: '5px solid ' + color },
    }),
  ])
}

/**
 * 折叠状态的记性（2026-11-01 维护者要「刷新也要记住」）。
 *
 * 存哪：本机 localStorage，按工作区一把键（与 store-prefs 的 listPrefs 同一套本机存储）。
 *   为什么不进设置文件：设置文件的 workspaces 记录只认固定的几个开关名，加新名字要改核的校验、
 *   YAML 写出与迁移；折叠是纯界面状态，丢了不影响数据，本机存储足够，刷新与重开都在。
 * 怎么存：只存「折了哪几条」的 effortId 数组，展开的不存；解析失败/存储不可用一律按「全部展开」。
 */
const WF_FOLD_STORAGE_PREFIX = 'dsws.wfFold'
const wfFoldStorageKeyOf = function (st: any): string {
  let ws = ''
  try { ws = (typeof keyOf === 'function') ? String(keyOf(st && st.cwd) || '') : '' } catch (e) { ws = '' }
  return ws ? (WF_FOLD_STORAGE_PREFIX + '.' + ws) : WF_FOLD_STORAGE_PREFIX
}
const wfFoldReadOf = function (st: any): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return out
    const raw = localStorage.getItem(wfFoldStorageKeyOf(st))
    const arr = raw ? JSON.parse(raw) : null
    if (Array.isArray(arr)) {
      for (const x of arr) if (typeof x === 'string' && x) out[x] = true
    }
  } catch (e) {
    try { if (typeof log === 'function') log('warn', 'storage.fail', { key: 'wfFold', op: 'read' }) } catch (eL) {}
  }
  return out
}
const wfFoldWriteOf = function (st: any, fold: any): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return
    const arr = Object.keys(fold || {}).filter(function (k: string) { return !!fold[k] })
    localStorage.setItem(wfFoldStorageKeyOf(st), JSON.stringify(arr))
  } catch (e) {
    try { if (typeof log === 'function') log('warn', 'storage.fail', { key: 'wfFold', op: 'write' }) } catch (eL) {}
  }
}

/**
 * 工作流视图主入口。
 * @param st 会话状态（读 st.snapshot；st.listView 决定列表面板显示哪一视图）
 * @param narrow 面板窄态：窄态每层只放一张卡（并排会挤成一条缝）
 */
export const WorkflowViewNode = function (st: any, narrow: boolean): any {
  // 第一次画这条工作区时把折叠状态从本机存储接回来（只接一次，之后以 st.wfFold 为准）。
  if (st && typeof st === 'object' && !st.wfFold) st.wfFold = wfFoldReadOf(st)
  const issues = (st && st.snapshot && Array.isArray(st.snapshot.issues)) ? st.snapshot.issues : []
  // 容器（地图 / 规格）不是任务卡：列表页也用同一个判据把它们摘出去
  const plain = issues.filter(function (x: any) { try { return !containerKindOf(x) } catch (e) { return true } })
  const tickets = plain.map(wfTicketOf)
  const order = (function () { try { return effortNamesOf(st) || [] } catch (e) { return [] } })()
  const lanes = workflowLanesOf(tickets, order, WF_WIP_LIMIT)
  if (!lanes.length) {
    return h('div', { key: 'wf-empty', style: { fontSize: 12, color: '#a1a1aa', padding: '14px 0', textAlign: 'center' } }, '这条工作区里还没有任务卡')
  }

  return h('div', { key: 'wf-root', style: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 } }, lanes.map(function (lane: any) {
    const name = lane.effortId || '本工作区'
    // 按依赖深度分层：同层并排，层与层之间一条竖线
    const layers: any[] = []
    for (const card of lane.cards) {
      if (!layers[card.depth]) layers[card.depth] = []
      layers[card.depth].push(card)
    }
    const body: any[] = []
    let prevDone = true
    for (let d = 0; d < layers.length; d++) {
      const row = layers[d] || []
      if (!row.length) continue
      // 只在层与层之间画竖线；第一层上面不画（A 原型的口径）。
      if (d > 0) body.push(wfConnNode('conn-' + lane.effortId + '-' + d, prevDone && row.every(function (c: any) { return c.state === 'closed' })))
      body.push(h('div', {
        key: 'layer-' + lane.effortId + '-' + d,
        style: { display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: 8, alignItems: 'stretch' },
      }, row.map(function (c: any) { return wfCardNode(st, lane.effortId, c, narrow) })))
      prevDone = row.every(function (c: any) { return c.state === 'closed' })
    }

    const pct = lane.total ? Math.round(lane.closed / lane.total * 100) : 0
    const focus = workflowFocusOf(lane)
    const folded: boolean = !!(st && st.wfFold && st.wfFold[lane.effortId])
    const remaining: number = Math.max(0, lane.total - lane.closed)
    // 折叠状态只落在会话状态里（st.wfFold[effortId]），不新增票字段、不写文件；
    //   点整条泳道头也能折，点里面的「按这条工作流执行」不折（stopPropagation）。
    const toggleFold = function () {
      st.wfFold = Object.assign({}, (st && st.wfFold) || {}, { [lane.effortId]: !folded })
      // 先落盘再重画：刷新/重开时由 WorkflowViewNode 开头那一趟读回来。
      wfFoldWriteOf(st, st.wfFold)
      try { if (typeof emit === 'function') emit(st) } catch (e) {}
    }
    // B 的头：名字 + 进度一行；CTA 在右侧（窄态收成「执行 · N」）。
    const pctText = lane.running
      ? tr('wf.pctRunning', { closed: lane.closed, total: lane.total, running: lane.running })
      : tr('wf.pct', { closed: lane.closed, total: lane.total })
    const runLabel = narrow ? tr('wf.runLaneShort', { n: remaining }) : tr('wf.runLane')
    // 折叠后仍要回答「还剩什么」：下一站 + 可接/排队/被挡摘要；全完成时直接说完成。
    const foldedText = remaining === 0
      ? tr('wf.foldedDone', { closed: lane.closed, total: lane.total })
      : tr('wf.foldedNext', { next: focus ? ('#' + focus.key + ' ' + focus.title) : '—' }) +
        ' · ' + tr('wf.summary', { ready: lane.ready, queued: lane.queued, blocked: lane.blocked })
    return h('div', {
      key: 'lane-' + lane.effortId,
      className: 'dsws-wflane',
      style: { border: '1px solid #2a2d35', borderRadius: 12, background: 'linear-gradient(180deg,#151821,#111319)', padding: 12, marginBottom: 0 },
    }, [
      h('div', {
        key: 'head',
        className: 'dsws-wflane-head',
        'data-press': 'button',
        'data-log': 'list.wf.fold',
        onClick: toggleFold,
        style: { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 4, cursor: 'pointer', userSelect: 'none' },
      }, [
        h('div', { key: 'info', style: { flex: '1 1 auto', minWidth: 0 } }, [
          h('div', { key: 'nm', style: { fontSize: 13.5, fontWeight: 600, color: '#e6edf3', letterSpacing: 0.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [
            h('span', { key: 'chev', 'aria-label': tr(folded ? 'wf.unfold' : 'wf.fold'), style: { fontSize: 10, color: '#8b8b95', marginRight: 6 } }, folded ? '▸' : '▾'),
            name,
          ]),
          h('div', { key: 'pct', style: { fontFamily: 'Consolas,"SF Mono",Menlo,monospace', fontSize: 11, color: '#8b8b95', marginTop: 2 } }, pctText),
        ]),
        // 「按工作流执行」：把这条工作流剩下的票按依赖顺序写进提示词，注入当前会话，
        //   由宿主按 build 里的编排协议派子代理、逐张验收；脚本不越过门禁自己起进程。
        remaining > 0
          ? h(Tip, { key: 'run', content: tr('wf.runAllTitle') }, h('button', {
            className: 'dsws-btn dsws-hov',
            'data-press': 'button',
            'data-log': 'list.wf.runAll',
            onClick: function (e: any) {
              e.stopPropagation()
              try { inject(st, workflowRunPromptOf(lane, (typeof promptLang === 'function' ? promptLang() : 'zh'))) } catch (e2) {}
            },
            style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, background: '#7c5bd6', color: '#fff', border: 'none', borderRadius: 8, height: narrow ? 26 : 30, padding: narrow ? '0 9px' : '0 12px', fontSize: narrow ? 11.5 : 12, fontWeight: 600, flex: 'none', cursor: 'pointer', boxShadow: '0 0 0 1px #9d7ff0 inset' },
          }, narrow ? ('▶ ' + runLabel) : ['▶ ' + runLabel + ' ', h('span', { key: 'n', style: { opacity: 0.75, fontWeight: 400 } }, tr('wf.runLaneN', { n: remaining }))]))
          : h('button', {
            key: 'done',
            disabled: true,
            style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', color: '#3fb950', border: '1px solid #2c5138', borderRadius: 8, height: narrow ? 26 : 30, padding: narrow ? '0 9px' : '0 12px', fontSize: narrow ? 11.5 : 12, fontWeight: 600, flex: 'none', cursor: 'default' },
          }, '✓ ' + tr('wf.noneLeft')),
      ]),
      h('div', { key: 'bar', style: { height: 4, borderRadius: 3, background: '#23262e', overflow: 'hidden', margin: '8px 0 0' } },
        [h('div', { key: 'i', style: { height: '100%', width: pct + '%', background: '#3fb950' } })]),
      folded ? h('div', { key: 'folded', style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#a1a1aa', marginTop: 8 } }, [
        h('span', { key: 'chev', style: { color: '#8b8b95' } }, '▸'),
        h('span', { key: 'txt' }, foldedText),
      ]) : null,
      // A 的身体：当前这一张 + 分层卡片（同层并排，层间竖线）。
      (folded ? null : (focus ? h('div', { key: 'focus', style: { fontSize: 11, color: '#a1a1aa', margin: '8px 0 8px' } },
        '当前这一张：#' + focus.key + ' ' + (focus.state === 'running' ? '（在做：' + focus.assignees.join('、') + '）' : '（可接）')) : null)),
    ]
      .concat(folded ? [] : body))
  }))
}
