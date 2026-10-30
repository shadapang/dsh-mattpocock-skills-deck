// tests/verify-scope-session.ts —— deck_issue_list 的 scope 参数（会话视图）
//
// 守的是什么：一条命令只列「本会话碰过的票」，不换工具、不改票、不写账。
// 四条判据逐条对验收：
//   ① scope=session 只回本会话碰过的票（固定账页 + 固定票集 → 与列表求交）；
//   ② scope=all（与不传 scope）行为与改动前完全一致：还是整个工作区那一份全集；
//   ③ 读操作不改任何票文件：调用前后 .scratch 下每个文件逐字节一致（同时证明 list 不往账页里记一笔）；
//   ④ 账页只把 create/patch/claim 类写事件算「碰过」：只上报不算；建过之后再只上报，仍然算。
//
// 为什么要用真账页而不是桩：账页的「碰过」口径（hasWork 不被后来一次上报抹掉）是这次实现的
// 关键，桩一份假账就把这条口径一起假掉了。所以本门禁真的往临时家目录里写一份账页（走生产同一条
// 写路径 createWorkRouteBindings.note），再让工具从同一份账页里读回来求交。
//
// 用法：在插件根目录执行 node --import ./scripts/ts-hook.mjs tests/verify-scope-session.ts，可独立运行。
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const ROOT = path.resolve(__dirname, '..')
const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)
// 工作区文件夹具（写法见 tests/lib/deck-decide-stub.ts 文件头）：这个工作区「用户亲手选过 markdown」，
// 工具才会往下走；不给这份文件，工具在选后端那一步就回 unsupported，什么都测不到。
const { makeDecideStub, chooseWorkspace } = require('./lib/deck-decide-stub.ts')

let failed = false
let total = 0
const check = function (ok: unknown, msg: string): void {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg)
  if (!ok) failed = true
}

/** 这个夹具工作区在账页里的工作区键（工具侧由 deps.workspaceKeyOf 给同一个值，两边才读同一份账）。 */
const WSKEY = 'ws-scope-session'
/** 本会话与被人的会话号。 */
const ME = 's-scope-me'
const OTHER = 's-scope-other'

/** 一棵目录树里每个文件的 sha256（相对路径 → 摘要）：用它逐字节比「调用前后有没有被改过」。 */
function digestsOf(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = function (dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out[path.relative(root, p).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

/**
 * 固定票集：一个工作单元 demo，五张票 01–05 加一份地图容器（列表里的 00 号行）。
 * 标题与正文都写死，编号即身份，后面按编号对交集。
 */
function makeWS(): any {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-scope-session-'))
  const dir = path.join(root, '.scratch', 'demo')
  fs.mkdirSync(path.join(dir, 'issues'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'map.md'), '# 底图\n\nStatus: ready-for-agent\n\n## Destination\n\n固定票集\n', 'utf8')
  const titles = ['甲票', '乙票', '丙票', '丁票', '戊票']
  for (let i = 0; i < titles.length; i++) {
    const n = ('0' + (i + 1)).slice(-2)
    fs.writeFileSync(path.join(dir, 'issues', n + '-' + titles[i] + '.md'), '# ' + titles[i] + '\n\nLabels: wayfinder:task\n\n## 进度\n\n固定票集\n', 'utf8')
  }
  const plat = {
    path: path.posix,
    fs: {
      async resolve(p: any) { return String(p).replace(/\\/g, '/') },
      async readText(t: any) { return fs.readFileSync(t, 'utf8') },
      async writeText(t: any, c: any) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, c, 'utf8') },
      async lstat(t: any) { try { return fs.statSync(t) } catch (e) { return null } },
      async listDir(t: any) { try { return fs.readdirSync(t) } catch (e) { return [] } },
      async stat(t: any) { try { return fs.statSync(t) } catch (e) { return null } },
    },
  }
  const rootPosix = root.replace(/\\/g, '/')
  return {
    root: root,
    rootPosix: rootPosix,
    ctx: { platform: plat, fs: plat.fs, cwd: rootPosix, get(n: any) { return n === 'fs' ? plat.fs : undefined } },
    cleanup() { try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {} },
  }
}

/** 回执里那一批行的编号（按编号排序），比对交集时只看这个。 */
function keysOf(receipt: any): string[] {
  const rows = (receipt && receipt.data && Array.isArray(receipt.data.issues)) ? receipt.data.issues : []
  return rows.map(function (r: any) { return String(r.key) }).sort()
}

async function main(): Promise<void> {
  console.log('deck_issue_list 的 scope=session（只列本会话碰过的票）')

  // ── 装配：真注册表 + 真闸 + 真账 + 本地 Markdown 房间（与生产同一条读取路） ──
  const budget = await imp('src/refresh/kernel/host-budget.js')
  const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
  const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
  const registryMod = await imp('src/tracker/registry/core.ts')
  const markdownModule = (await imp('src/tracker/rooms/markdown/index.ts')).markdownModule
  const toolCost = await imp('src/refresh/kernel/tool-call-budget.js')
  const bindingsMod = await imp('src/deck/shell/work-path-bindings.ts')
  const ws = makeWS()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-scope-home-'))
  const clock = 1700000000000
  const ledger = ledgerMod.createLedger({ now: () => clock })
  const gate = gateMod.createGate({ ledger: ledger, now: () => clock })
  const registry = registryMod.createRegistry(Object.assign({ logEvent: () => {}, isEnabled: () => false }, ws.ctx), { matchesTimeout: 200 })
  const dispose = registry.register(markdownModule)
  const handle = { cwd: ws.rootPosix, refId: '.scratch' }
  chooseWorkspace(ws.rootPosix, 'markdown')
  ledger.ensureBackend('github', { kind: 'two-buckets' })
  ledger.syncServer('github', { rest: { limit: 5000, remaining: 5000, reset: clock + 3600000 }, graphql: { limit: 5000, remaining: 5000, reset: clock + 3600000 } }, clock)

  // 工作路线账页：真的落到临时家目录里（写路径与生产同一个工厂），工具读的也是它。
  const route = bindingsMod.createWorkRouteBindings({
    homeDir: home,
    now: () => clock,
    readFile(p: string) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null },
    writeFile(p: string, text: string) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
    mkdir(dir: string) { fs.mkdirSync(dir, { recursive: true }) },
    rename(from: string, to: string) { fs.renameSync(from, to) },
  })
  // 固定的账页内容（每一条都对应上面固定票集里的一张票）：
  //   01 建过（create）        → 算碰过
  //   02 改过（edit，含认领）  → 算碰过
  //   03 只上报（report）      → 不算
  //   04 建过之后又只上报一次  → 仍算（上报不抹掉以前的实事）
  //   05 是别的会话建的（OTHER）→ 不算本会话的
  //   另一个目录里的 05 本会话碰过 → 但它不是 demo 目录里的那张 05，别串进来
  const notes = [
    { ticketKey: '1', effortId: 'demo', action: 'create', source: 'auto' },
    { ticketKey: '2', effortId: 'demo', action: 'edit', source: 'auto' },
    { ticketKey: '3', effortId: 'demo', action: 'report', source: 'reported' },
    { ticketKey: '4', effortId: 'demo', action: 'create', source: 'auto' },
    { ticketKey: '4', effortId: 'demo', action: 'report', source: 'reported' },
    { ticketKey: '5', effortId: 'other', action: 'edit', source: 'auto' },
  ]
  for (const n of notes) await route.note({ rootKey: WSKEY, sessionId: ME, ticketKey: n.ticketKey, effortId: n.effortId, title: '会话视图夹具', action: n.action, source: n.source })
  await route.note({ rootKey: WSKEY, sessionId: OTHER, ticketKey: '5', effortId: 'demo', title: '别人建的', action: 'create', source: 'auto' })
  const sessionHits = await route.tickets({ rootKey: WSKEY, sessionId: ME })
  check(sessionHits && sessionHits.ok === true && Array.isArray(sessionHits.tickets), '账页夹具读得回来（本会话碰过的票有一份名单）')

  const deps = {
    gate: gate, registry: registry, budget: budget,
    estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
    backendCtx: ws.ctx, handleFor: () => handle, log: { fire: () => {} }, now: () => clock,
    decideBackend: makeDecideStub(registry),
    // 工具侧的工作区键固定成同一个值，账页夹具与工具才读的是同一份文件。
    workspaceKeyOf: () => WSKEY,
    // 只读账页那支：直接把生产绑定交给工具，不另写一份取数逻辑（否则测的是门禁自己的实现）。
    workRouteTickets: (arg: any) => route.tickets(arg),
  }
  const tool = (await imp('src/deck/tools/issue-list.ts')).createDeckIssueList(deps)
  const exec = { agent: { session: { id: ME, cwd: ws.rootPosix } } }

  // ── 一、参数表 ──
  const props = tool.definition.parameters.properties
  const required = tool.definition.parameters.required || []
  check(!!props.scope && props.scope.type === 'string', '参数表里有 scope（可选字符串）')
  check(JSON.stringify(props.scope && props.scope.enum) === JSON.stringify(['all', 'session']), 'scope 枚举只有两档：all / session（实得 ' + JSON.stringify(props.scope && props.scope.enum) + '）')
  check(required.indexOf('scope') < 0, 'scope 不在必填里（不传就是默认的 all）')
  check(typeof props.scope.description === 'string' && props.scope.description.indexOf('会话') >= 0, 'scope 说明里讲清 session 是什么（模型看得懂才用得对）')

  // ── 二、调用前后逐字节比：票文件与账页都不许被动过 ──
  const scratchBefore = digestsOf(path.join(ws.root, '.scratch'))
  const homeBefore = digestsOf(home)

  // scope=all（缺省）＝整个工作区：00 地图行 + 01–05 五张票。
  const allDefault = await tool.run(exec, { state: 'all' })
  const allExplicit = await tool.run(exec, { state: 'all', scope: 'all' })
  const sessionView = await tool.run(exec, { state: 'all', scope: 'session' })
  const typoView = await tool.run(exec, { state: 'all', scope: 'sessoin' })

  const scratchAfter = digestsOf(path.join(ws.root, '.scratch'))
  const homeAfter = digestsOf(home)

  // ── 三、判据①：会话视图 = 交集 ──
  const full = ['00', '01', '02', '03', '04', '05']
  check(JSON.stringify(keysOf(allDefault)) === JSON.stringify(full), '不传 scope 时是全集（实得 ' + JSON.stringify(keysOf(allDefault)) + '）')
  check(JSON.stringify(keysOf(allExplicit)) === JSON.stringify(keysOf(allDefault)), 'scope=all 与不传 scope 逐行相同（行为与改动前一致）')
  check(JSON.stringify(keysOf(typoView)) === JSON.stringify(keysOf(allDefault)), '认不出的 scope 值按 all 处理（不猜第三档）')
  const want = ['01', '02', '04']
  check(JSON.stringify(keysOf(sessionView)) === JSON.stringify(want), 'scope=session 回的是交集（应为 ' + JSON.stringify(want) + '，实得 ' + JSON.stringify(keysOf(sessionView)) + '）')
  check(keysOf(sessionView).indexOf('03') < 0, '只上报过的票不进会话视图（03）')
  check(keysOf(sessionView).indexOf('04') >= 0, '建过之后又只上报一次的票仍在会话视图里（04，上报不抹掉以前的实事）')
  check(keysOf(sessionView).indexOf('05') < 0, '别的会话建的票不进会话视图（05），别的目录里碰过的 05 也不串进来')
  check(keysOf(sessionView).every((k: string) => full.indexOf(k) >= 0), '会话视图里没有凭空多出来的行（每一行都能在全集里找到）')
  check(String(sessionView.text || '').indexOf('scope=session') >= 0 && JSON.stringify(sessionView.notes || []).indexOf('只看本会话碰过的票') >= 0, '回执里说清这次是会话视图（正文与备注都写明）')

  // ── 四、判据②③④：票文件与账页一个字节都没变 ──
  check(JSON.stringify(scratchBefore) === JSON.stringify(scratchAfter), '.scratch 下每个文件调用前后逐字节一致（票文件没被改过）')
  check(JSON.stringify(homeBefore) === JSON.stringify(homeAfter), '账页文件调用前后逐字节一致、也没有新增（list/get 不入账）')

  ws.cleanup()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch (e) {}
  try { dispose.dispose() } catch (e) {}
  console.log('\n' + total + ' 条断言，' + (failed ? '失败' : '通过'))
  process.exit(failed ? 1 : 0)
}

main().catch(function (e: any) {
  console.error('验收脚本异常：' + ((e && e.stack) || e))
  process.exit(1)
})
