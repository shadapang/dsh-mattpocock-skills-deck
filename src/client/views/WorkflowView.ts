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
      h('span', { key: 's', style: { marginLeft: 'auto', color: s.color } }, s.text),
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
 * 工作流视图主入口。
 * @param st 会话状态（读 st.snapshot；st.listView 决定列表面板显示哪一视图）
 * @param narrow 面板窄态：窄态每层只放一张卡（并排会挤成一条缝）
 */
export const WorkflowViewNode = function (st: any, narrow: boolean): any {
  const issues = (st && st.snapshot && Array.isArray(st.snapshot.issues)) ? st.snapshot.issues : []
  // 容器（地图 / 规格）不是任务卡：列表页也用同一个判据把它们摘出去
  const plain = issues.filter(function (x: any) { try { return !containerKindOf(x) } catch (e) { return true } })
  const tickets = plain.map(wfTicketOf)
  const order = (function () { try { return effortNamesOf(st) || [] } catch (e) { return [] } })()
  const lanes = workflowLanesOf(tickets, order, WF_WIP_LIMIT)
  if (!lanes.length) {
    return h('div', { key: 'wf-empty', style: { fontSize: 12, color: '#a1a1aa', padding: '14px 0', textAlign: 'center' } }, '这条工作区里还没有任务卡')
  }

  return h('div', { key: 'wf-root', style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 } }, lanes.map(function (lane: any) {
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
      body.push(wfConnNode('conn-' + lane.effortId + '-' + d, prevDone && row.every(function (c: any) { return c.state === 'closed' })))
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
    //   点整条泳道头也能折，点里面的「执行全部」不折（stopPropagation）。
    const toggleFold = function () {
      st.wfFold = Object.assign({}, (st && st.wfFold) || {}, { [lane.effortId]: !folded })
      try { if (typeof emit === 'function') emit(st) } catch (e) {}
    }
    return h('div', {
      key: 'lane-' + lane.effortId,
      className: 'dsws-wflane',
      style: { border: '1px solid #2a2d35', borderRadius: 10, background: '#13161b', padding: 10 },
    }, [
      h('div', {
        key: 'head',
        className: 'dsws-wflane-head',
        'data-press': 'button',
        'data-log': 'list.wf.fold',
        onClick: toggleFold,
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer', userSelect: 'none' },
      }, [
        h('span', { key: 'chev', 'aria-label': tr(folded ? 'wf.unfold' : 'wf.fold'), style: { fontSize: 10, color: '#8b8b95', flex: 'none', width: 10 } }, folded ? '▸' : '▾'),
        h('span', { key: 'n', style: { fontSize: 13, fontWeight: 600, color: '#e6edf3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
        h('span', { key: 's', style: { fontSize: 11, color: '#8b8b95', fontFamily: 'Consolas,"SF Mono",Menlo,monospace', marginLeft: 'auto', flex: 'none' } },
          '已完成 ' + lane.closed + '/' + lane.total + (lane.running ? ' · 在做 ' + lane.running : '') + (lane.queued ? ' · 排队 ' + lane.queued : '')),
        // 「按工作流执行」：把这条工作流剩下的票按依赖顺序写进提示词，注入当前会话，
        //   由宿主按 build 里的编排协议派子代理、逐张验收；脚本不越过门禁自己起进程。
        remaining > 0
          ? h(Tip, { key: 'run', content: tr('wf.runAllTitle') }, h('button', {
            className: 'dsws-btn primary dsws-hov',
            'data-press': 'button',
            'data-log': 'list.wf.runAll',
            onClick: function (e: any) {
              e.stopPropagation()
              try { inject(st, workflowRunPromptOf(lane, (typeof promptLang === 'function' ? promptLang() : 'zh'))) } catch (e2) {}
            },
            style: { fontSize: 11, padding: '0 8px', height: 22, flex: 'none' },
          }, tr('wf.runAll') + ' · ' + remaining))
          : h('span', { key: 'none', style: { fontSize: 11, color: '#3fb950', flex: 'none' } }, tr('wf.noneLeft')),
      ]),
      h('div', { key: 'bar', style: { height: 4, borderRadius: 3, background: '#23262e', overflow: 'hidden', marginBottom: 8 } },
        [h('div', { key: 'i', style: { height: '100%', width: pct + '%', background: '#3fb950' } })]),
      focus ? h('div', { key: 'focus', style: { fontSize: 11, color: '#a1a1aa', marginBottom: 8 } },
        '当前这一张：#' + focus.key + ' ' + (focus.state === 'running' ? '（在做：' + focus.assignees.join('、') + '）' : '（可接）')) : null,
      folded ? h('div', { key: 'folded', style: { fontSize: 11, color: '#8b8b95' } },
        tr('wf.summary', { ready: lane.ready, queued: lane.queued, blocked: lane.blocked })) : null,
    ]
      .concat(folded ? [] : body))
  }))
}
