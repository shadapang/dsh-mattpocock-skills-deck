/**
 * views/listFilterRow.ts —— 列表页「状态 / 排序 / 标签」三组筛选药丸，连三块液态墨块。
 *
 * 契约：模块真源（ESM 导出）；scripts/build.mts 构建时剥掉行首 export，把声明体拼回
 * src/client/index.ts 的 `// ==== leaf:listFilterRow (spliced by build) ====` 标记处，
 * 次序排在 leaf:listTab 之前（ListTab 调它画那三行）。
 *
 * 排布：一组一行，每行左边是固定宽度的维度列头（状态 / 排序 / 标签），右边是可换行的药丸列。
 * 三组曾经挤在同一条换行流里，每组都从一颗「全部」起头，三颗同形同色，维护者提过「有三个全部，
 * 都不知道是怎么维度」；改成列头对齐后，一颗「全部」只可能属于它右边那一列，排序也不会再被
 * 误读成第四组筛选。列宽写死在 LIST_CAPTION_W：标题字数变了要连它一起改，否则标题会把列撑歪。
 *
 * 为什么搬出 ListTab：ListTab 已贴着「每文件 ≤350 有效行」的硬上限，而这几行要接三组墨块、
 * 每个药丸还要挂按压/悬停与点击日志，继续堆在原文件里就超限了。这里只搬「画法」，
 * 过滤状态仍然住在调用方传进来的 st 上（点一下改 st.lblFilters / st.stateFilter / st.sortKey，
 * 再 emit 重渲染），行为与搬出前一致。
 *
 * 三块墨块由液体墨块模块（leaf:liquidInk）的 useLiquidInk 生成：状态与排序是单选组，
 * 墨块盖住唯一选中项；标签是多选组，墨块跟着「最近一次点中的那颗」走，其余选中项保留自己的描边。
 * 颜色不新增：墨块底色/描边从选中药丸的 data-ink-bg / data-ink-bd 读，就是各组原来那套选中色。
 * 墨块是按矩形定位、在宿主里按 data-ink-group 找目标的，所以宿主从 flex 换成 block、药丸从
 * 直接子节点挪进两层的行里都不影响它——它不依赖直接子节点。
 *
 * 交互反馈与点击日志的约定见 kernel/ui-feedback.ts：data-press 负责按下态，data-log 负责
 * 点下去写一条 debug 级 ui.action（开关关着时零开销）；data-log 的值在同一屏里唯一，
 * 事后读日志能定位到「点了哪个筛选药丸」。
 */

// 这些名字由构建把各叶子拼进同一个函数作用域后提供（真机上有值）；类型检查时本文件是独立看的，
// 所以这里只声明形状、不参与转译：declare 是纯类型语法，esbuild 转译时整句删掉，产物里不留痕。
declare const React: any
declare const Tip: any
declare function chipProps(...args: any[]): any
declare function tr(...args: any[]): any
declare function emit(...args: any[]): any
declare function darken(...args: any[]): any
declare function hexA(...args: any[]): any
declare const labelClicks: any
declare function saveLabelClicks(...args: any[]): any
declare const listPrefs: any
declare function saveListPrefs(...args: any[]): any
declare const CONTAINER_ACCENT: any
declare function useLiquidInk(...args: any[]): any
declare function liquidInkRemember(...args: any[]): void

// 药丸是圆角胶囊：墨块圆角 99px（页签那组用默认的 6px，由宿主自己的 data-ink-radius 决定）。
const INK_RADIUS: string = '99px'
// 三个组的选中色就是搬出前各颗药丸用的那三套值；墨块照抄，界面不出现第五种颜色。
const STATE_INK_BG: string = 'rgba(188,140,255,.18)'
const STATE_INK_BD: string = 'rgba(188,140,255,.6)'
const SORT_INK_BG: string = 'rgba(88,166,255,.16)'
const SORT_INK_BD: string = 'rgba(88,166,255,.55)'
const LABEL_ALL_INK_BG: string = 'rgba(255,255,255,.08)'
const LABEL_ALL_INK_BD: string = 'rgba(255,255,255,.65)'

/**
 * 维度列头占的横向宽度（像素）：三行标题右对齐到这个宽度，右边药丸的左边界因此一致。
 * 现在的标题是「状态 / 排序 / 标签」，两个字在 10 像素字号下约 20 像素宽，42 像素足够且不挤；
 * 标题一旦改成三个字以上（例如「工作单元」四个字在同一行里由 mdEffortRow 自己画），
 * 要么调大这个数，要么接受标题被 nowrap 撑开——撑开会把同一面板里的三行左边界对不齐。
 */
const LIST_CAPTION_W: number = 42

/**
 * 一行左侧的维度列头。
 *
 * 为什么要有：这组药丸原来跟另外两组排在一条换行流里，每组都从一颗「全部」起头，三颗同形同色，
 * 分不清各自清的是哪一维。列头只是文字，不承担交互：不挂点击、不写日志、不参与墨块。
 */
const listGroupCaption = function (h: any, key: string): any {
  return h('span', {
    key: 'cap-' + key,
    className: 'dsws-cap',
    style: {
      flex: 'none', width: LIST_CAPTION_W, marginRight: 6, textAlign: 'right',
      fontSize: 10, lineHeight: '16px', marginTop: 2,
      color: 'var(--dsws-label-caption,#8b8b95)', whiteSpace: 'nowrap', userSelect: 'none',
    },
  }, tr('list.group.' + key))
}

/**
 * 把标签名压成日志里能用的稳定片段：ui.action 的 target 只收小写字母、数字、点、横线、下划线，
 * 其余字符折成横线；折完是空的（例如纯中文标签）就记 x —— 前面还带着序号，仍然同屏唯一。
 */
const logSlugOf = function (name: any): string {
  try {
    const s = String(name === null || name === undefined ? '' : name).toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    return s || 'x'
  } catch (e) { return 'x' }
}

export const listFilterRowNode = function (h: any, st: any, colorOf: any, sortedLabels: any) {
  // 三块墨块共用一个宿主（这整块筛选区）：每块自己带 data-ink-group，只认本组的选中项。
  const hostRef = React.useRef(null)
  const stateInk = useLiquidInk(hostRef, 'state')
  const sortInk = useLiquidInk(hostRef, 'sort')
  const labelInk = useLiquidInk(hostRef, 'label')

  // 标签药丸：v14-1「全部」恒清空过滤并保持选中，与普通标签 toggle 语义分离；
  //   #375 点选即记点击记忆（次数 + 最近点击时间，双键排序）。画法与搬出前一致。
  const chip = function (nm: any, withCount: any, on: any, isAll: any, idx: any) {
    const c = colorOf[nm]
    const borderColor = isAll ? 'rgba(255,255,255,.35)' : (darken(c, 0.16) || 'rgba(188,140,255,.6)')
    const selColor = isAll ? 'rgba(255,255,255,.65)' : (c ? '#' + c : '#bc8cff')
    const inkBg = isAll ? LABEL_ALL_INK_BG : (hexA(c, 0.18) || 'rgba(188,140,255,.16)')
    const inkBd = isAll ? LABEL_ALL_INK_BD : (c ? '#' + c : '#bc8cff')
    const logTarget = isAll ? 'list.filter.label.all' : ('list.filter.label.' + idx + '-' + logSlugOf(nm))
    return h('span', chipProps({
      key: nm,
      className: 'dsws-chip' + (on ? ' dsws-ink-on' : ''),
      'data-ink-group': 'label',
      'data-ink-bg': inkBg,
      'data-ink-bd': inkBd,
      'data-press': 'chip',
      'data-log': logTarget,
      onClick: function (e: any) {
        e.stopPropagation()
        liquidInkRemember(e.currentTarget, nm, 'label')
        // v1.5：多选 toggle —— 选中/取消单个标签，互不覆盖
        const cur = st.lblFilters || []
        st.lblFilters = isAll ? [] : (cur.indexOf(nm) >= 0 ? cur.filter(function (x: any) { return x !== nm }) : cur.concat([nm]))
        if (!isAll) {
          const c2 = labelClicks[nm] || { n: 0, ts: 0 }
          labelClicks[nm] = { n: c2.n + 1, ts: Date.now() }
          saveLabelClicks()
        }
        emit(st)
      },
      style: {
        cursor: 'pointer', marginRight: 4, marginBottom: 3, fontSize: 10,
        background: isAll ? 'rgba(255,255,255,.08)' : (hexA(c, 0.18) || 'rgba(188,140,255,.16)'),
        color: isAll ? 'var(--dsw-alias-label-secondary,#a1a1aa)' : (c ? '#' + c : '#bc8cff'),
        border: '1px solid ' + (on ? selColor : borderColor),
      },
    }), nm)
  }

  /**
   * 一行筛选：左边维度列头，右边药丸列（自己换行，不把列头顶下去）。
   * 列用 flex 且 minWidth:0：药丸再多也只在右半边换行，列头永远贴在本行开头。
   */
  const rowOf = function (key: string, chips: any[]): any {
    return h('div', {
      key: 'row-' + key,
      className: 'dsws-filter-row',
      style: { display: 'flex', alignItems: 'flex-start', marginBottom: 2 },
    }, [
      listGroupCaption(h, key),
      h('div', {
        className: 'dsws-filter-chips',
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', flex: 1, minWidth: 0 },
      }, chips),
    ])
  }

  // #374/#375：三组都是小号紧凑药丸，窄屏换行不增高；展开态点选 label 不收起。
  const stateChips = ['all', 'open', 'closed', 'blocked', 'frontier'].map(function (k: any) {
    const on = st.stateFilter === k
    return h('span', chipProps({ key: 'stf-' + k, className: 'dsws-chip' + (on ? ' dsws-ink-on' : ''), 'data-ink-group': 'state', 'data-ink-bg': STATE_INK_BG, 'data-ink-bd': STATE_INK_BD, 'data-press': 'chip', 'data-log': 'list.filter.state.' + k, onClick: function (e: any) {
      e.stopPropagation()
      liquidInkRemember(e.currentTarget, k, 'state')
      st.stateFilter = k; listPrefs.stateFilter = k; saveListPrefs('stateFilter'); emit(st)
    }, style: { cursor: 'pointer', marginRight: 4, marginBottom: 3, fontSize: 10, background: on ? STATE_INK_BG : 'rgba(255,255,255,.06)', color: on ? ((typeof CONTAINER_ACCENT === 'object' && CONTAINER_ACCENT) ? CONTAINER_ACCENT.map : '') : 'var(--dsw-alias-label-secondary,#a1a1aa)', border: '1px solid ' + (on ? STATE_INK_BD : 'rgba(255,255,255,.15)') } }), tr('list.state.' + k))
  })

  const sortChips = ['updatedAt', 'createdAt', 'number', 'title'].map(function (k: any) {
    const on = st.sortKey === k
    const arrow = on ? (st.sortDir === 'asc' ? '↑' : '↓') : ''
    return h('span', chipProps({ key: 'srt-' + k, className: 'dsws-chip' + (on ? ' dsws-ink-on' : ''), 'data-ink-group': 'sort', 'data-ink-bg': SORT_INK_BG, 'data-ink-bd': SORT_INK_BD, 'data-press': 'chip', 'data-log': 'list.filter.sort.' + k, onClick: function (e: any) {
      e.stopPropagation()
      liquidInkRemember(e.currentTarget, k, 'sort')
      if (st.sortKey === k) { st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc' }
      else { st.sortKey = k; st.sortDir = (k === 'title') ? 'asc' : 'desc' }
      listPrefs.sortKey = st.sortKey; listPrefs.sortDir = st.sortDir; saveListPrefs(['sortKey', 'sortDir']); emit(st)
    }, style: { cursor: 'pointer', marginRight: 4, marginBottom: 3, fontSize: 10, background: on ? SORT_INK_BG : 'rgba(255,255,255,.06)', color: on ? '#58a6ff' : 'var(--dsw-alias-label-secondary,#a1a1aa)', border: '1px solid ' + (on ? SORT_INK_BD : 'rgba(255,255,255,.15)') } }), tr('list.sort.' + k) + arrow)
  })

  const labelChips: any[] = [
    chip(tr('list.all'), false, !st.lblFilters || !st.lblFilters.length, true, 0),
    // #405：filter row 默认可见数 9 → 4（与 per-row 一致）；+N 触发条件 + 数字同步
    (st.expLabels ? sortedLabels : sortedLabels.slice(0, 4)).map(function (nm: any, i: any) { return chip(nm, true, (st.lblFilters || []).indexOf(nm) >= 0, false, i) }),
    (!st.expLabels && sortedLabels.length > 4) ? h(Tip, { content: tr('list.tagsTitle', { names: sortedLabels.join('、') }) }, h('span', chipProps({ key: 'lbl-more', className: 'dsws-chip', 'data-press': 'chip', 'data-log': 'list.filter.label.more', onClick: function (e: any) { e.stopPropagation(); st.expLabels = true; emit(st) }, style: { fontSize: 10, marginRight: 4, marginBottom: 3, background: 'rgba(188,140,255,.1)', color: '#bc8cff', border: '1px dashed rgba(188,140,255,.55)', cursor: 'pointer' } }), '+' + (sortedLabels.length - 4))) : null,
    st.expLabels ? h(Tip, { content: tr('list.tagsCollapseTitle') }, h('span', chipProps({ key: 'lbl-less', className: 'dsws-chip', 'data-press': 'chip', 'data-log': 'list.filter.label.less', onClick: function (e: any) { e.stopPropagation(); st.expLabels = false; emit(st) }, style: { fontSize: 10, marginRight: 4, marginBottom: 3, background: 'rgba(255,255,255,.06)', color: 'var(--dsws-label-caption,#8b8b95)', border: '1px dashed rgba(255,255,255,.3)', cursor: 'pointer' } }), tr('list.collapse'))) : null,
  ]

  return h('div', {
    ref: hostRef,
    className: 'dsws-ink-host',
    'data-ink-radius': INK_RADIUS,
    // 宿主是普通块：每组各占一行，靠行内 flex 自己排；墨块是绝对定位的浮层，不参与这个流。
    style: { display: 'block', marginBottom: 4 },
  }, [
    stateInk, sortInk, labelInk,
    rowOf('state', stateChips),
    rowOf('sort', sortChips),
    rowOf('label', labelChips),
  ])
}
