/**
 * scripts/sync-upstream.mts —— 一轮上游合并：开 sync/<YYYYMMDD> 分支、合上游、三步验证，给出 ACCEPT / REJECT。
 *
 * 这条流程回答一个问题：上游这次的新提交，能不能安全合进我们这棵 fork 树？
 * 顺序（任何一步不过就整轮作废，main 不动）：
 *   1. 开（或复用）sync/<YYYYMMDD> 分支，从 --base（缺省 main）起；
 *   2. 合并 --from（缺省 upstream/main）；lib/、package/ 这类构建产物冲突按「先取上游那份、再重新构建」解决，
 *      非产物路径上的冲突一律不自动解，交给人；
 *   3. 三步验证：① pnpm install --frozen-lockfile ② node scripts/build.mts 退出码 0
 *      ③ 把构建产物装进 profile 后直接在 Node 里跑一次 deck_context，断言 backend=markdown、workspace 正确；
 *   4. 打印 ACCEPT（退出码 0）或 REJECT（退出码 1）。
 *
 * 为什么 main 一个字节都不会动：本脚本只在 sync/* 分支上合、只在 sync/* 分支上验，结束时切回开始时所在的分支，
 * 并核对 main 的 sha 前后一致（对不上会直接报错，不是悄悄继续）。合完想回到 main 是人的动作，脚本只打印命令。
 *
 * 第 3 步为什么不启动 Electron、也不靠人在界面上点：deck_context 是一个纯 Node 模块。
 * 本脚本按「已安装的 profile 包路径」动态导入它的工具模块、本地 Markdown 后端与判定出口，
 * 给一个临时 markdown 工作区（docs/agents/workspace.yaml 写着 backendId: markdown），直接调 run() 看回执。
 * 装进 profile 之前会把原来的插件目录整份备份到 <backup-root>/profile-backup-<时间戳>，
 * 冒烟失败就把它原样放回去，不把真实 profile 留在半坏状态。
 *
 * 用法：
 *   node scripts/sync-upstream.mts                       # 合 upstream/main（本机没有这个 ref 就先手动 fetch，脚本不联网）
 *   node scripts/sync-upstream.mts --from upstream/main
 *   node scripts/sync-upstream.mts --from D:\tmp\upstream.git   # 本地临时仓（本地 fetch，不联网）
 *   node scripts/sync-upstream.mts --from <sha>          # 已在本仓里的提交
 *   node scripts/sync-upstream.mts --self-test           # 自测：临时 profile + 本地造的提交，不碰真实 profile
 *
 * 选项：
 *   --from <ref|sha|目录>  要合进来的上游提交；目录会被当作本地仓 fetch 一次（只写 FETCH_HEAD，不写远端分支 ref）
 *   --base <分支>          sync 分支从哪起（缺省 main）
 *   --branch <名字>        覆盖分支名（缺省 sync/<YYYYMMDD>）
 *   --profile <目录>       profile 根目录（缺省 %USERPROFILE%\.dsh\profiles\desktop）
 *   --backup-root <目录>   插件目录备份落在哪（缺省 <仓库上一级>/w2-evidence）
 *   --allow-dirty          允许工作区有未提交改动（自测用；日常别加，合并不确定会不会碰到你的活）
 *   --quiet                不把子命令输出接到终端（自测用），失败时仍会打印最后几行
 *
 * 说明（刻意不做的）：脚本不 push、不 merge 进 main、不 reset/clean、不删别人分支；网络只出现在人手动 fetch 那一步。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 构建会重写的产物目录：这些路径上的冲突「取上游那份 + 重新构建」即可，绝不手改产物。 */
// ponytail: 只给「重建能覆盖」的路径开这扇门；漏加的路径会走人处理那一侧，宁可拦下来也不猜。
const GENERATED_PREFIXES: string[] = [
  'package/lib/',
  'package/shared/',
  'package/deck/',
  'package/tracker/',
  'package/refresh/',
  'package/scripts/',
  'package/README.md',
  '.build/',
]

interface Options {
  from: string
  base: string
  branch: string
  profile: string
  backupRoot: string
  allowDirty: boolean
  quiet: boolean
  selfTest: boolean
  /** 自测用：新构建装进 profile 之后、跑冒烟之前插一手（例如把包弄坏），模拟装完就是坏的。 */
  onProfileInstalled?: (installedDir: string) => void
}

interface StepResult {
  name: string
  ok: boolean
  ms: number
  note: string
}

interface RoundResult {
  verdict: 'ACCEPT' | 'REJECT'
  reason: string
  branch: string
  fromRef: string
  mainBefore: string
  mainAfter: string
  steps: StepResult[]
  backupDir: string
  installedDir: string
}

function log(line: string): void { console.log(line) }
function stamp(d?: Date): string {
  const t: Date = d || new Date()
  const p = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
  return String(t.getFullYear()) + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds())
}
/** 路径比较用：统一斜杠、转小写（Windows 盘符大小写不敏感）、去掉末尾斜杠。 */
function normPath(p: unknown): string {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
function isGeneratedPath(rel: string): boolean {
  const p = String(rel).replace(/\\/g, '/')
  for (let i = 0; i < GENERATED_PREFIXES.length; i += 1) {
    const pre = GENERATED_PREFIXES[i]
    if (pre.endsWith('/') ? p.indexOf(pre) === 0 : p === pre) return true
  }
  return false
}
function parseArgs(argv: string[]): Options | { help: true } {
  const o: Options = {
    from: '',
    base: 'main',
    branch: '',
    profile: path.join(String(process.env.USERPROFILE || os.homedir()), '.dsh', 'profiles', 'desktop'),
    backupRoot: path.resolve(ROOT, '..', 'w2-evidence'),
    allowDirty: false,
    quiet: false,
    selfTest: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (a === '--self-test') { o.selfTest = true; continue }
    if (a === '--allow-dirty') { o.allowDirty = true; continue }
    if (a === '--quiet') { o.quiet = true; continue }
    if (a === '--from' || a === '--base' || a === '--branch' || a === '--profile' || a === '--backup-root') {
      const v = argv[i + 1]
      if (v === undefined) throw new Error('参数 ' + a + ' 后面少了值')
      i += 1
      if (a === '--from') o.from = v
      else if (a === '--base') o.base = v
      else if (a === '--branch') o.branch = v
      else if (a === '--profile') o.profile = path.resolve(v)
      else o.backupRoot = path.resolve(v)
      continue
    }
    throw new Error('不认识的参数：' + a + '（node scripts/sync-upstream.mts --help 看用法）')
  }
  if (!o.branch) o.branch = 'sync/' + stamp().slice(0, 8)
  return o
}

// ───────────────────────────── git 与子进程 ─────────────────────────────

interface GitResult { code: number; out: string; err: string }

function git(args: string[], input?: string): GitResult {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, input: input })
  return { code: r.status === null ? -1 : r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
}
function gitOk(args: string[]): string {
  const r = git(args)
  if (r.code !== 0) throw new Error('git ' + args.join(' ') + ' 失败：' + (r.err || r.out))
  return r.out
}
function gitLines(args: string[]): string[] {
  const out = gitOk(args)
  return out ? out.split('\n').map((s: string) => s.trim()).filter((s: string) => !!s) : []
}
function exists(p: string): boolean { try { return fs.existsSync(p) } catch (e) { return false } }
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory() } catch (e) { return false } }

/** 跑一条外部命令（Windows 上经 cmd.exe，这样 pnpm.cmd 也能直接调），回退出码与输出尾巴。 */
function runCmd(line: string, quiet: boolean): { code: number; tail: string; ms: number } {
  const t0 = Date.now()
  const win = String(process.platform) === 'win32'
  const r = win
    ? spawnSync(String(process.env.ComSpec || 'cmd.exe'), ['/d', '/s', '/c', line], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: quiet ? 'pipe' : 'inherit' })
    : spawnSync('sh', ['-c', line], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: quiet ? 'pipe' : 'inherit' })
  const ms = Date.now() - t0
  const text = String((r.stdout || '') + (r.stderr || ''))
  const tail = text.split('\n').filter((s: string) => !!s.trim()).slice(-6).join(' | ')
  return { code: r.status === null ? -1 : r.status, tail: tail, ms: ms }
}

// ───────────────────── 本地造一个「上游提交」（自测用，不联网） ─────────────────────

/**
 * 在**本仓对象库**里造一个父提交是 HEAD 的新提交，返回它的 sha。
 *
 * 为什么用 mktree 而不是 read-tree + write-tree：这棵树是前台克隆（partial clone + shallow），
 * write-tree 会触发对 promisor 远端的懒取，本机连不上 GitHub，自测就卡在网络上。
 * mktree 只写树对象、不碰工作区与索引，反过来 push 到临时裸仓也会触发同一类懒取，所以也不用那条路。
 */
function makeUpstreamCommit(changes: Array<{ path: string; content: string }>, message: string): string {
  function lsTree(spec: string): Array<{ mode: string; type: string; sha: string; name: string }> {
    return gitLines(['ls-tree', spec]).map((line: string) => {
      const tab = line.indexOf('\t')
      const meta = line.slice(0, tab).split(' ')
      return { mode: meta[0], type: meta[1], sha: meta[2], name: line.slice(tab + 1) }
    })
  }
  function mktree(rows: Array<{ mode: string; type: string; sha: string; name: string }>): string {
    const text = rows.map((r) => r.mode + ' ' + r.type + ' ' + r.sha + '\t' + r.name).join('\n') + '\n'
    const r = git(['mktree'], text)
    if (r.code !== 0) throw new Error('mktree 失败：' + (r.err || r.out))
    return r.out
  }
  // 把若干「某个目录下要换 / 要加的文件」按目录分组，自底向上重写树。
  const byDir: Record<string, Array<{ name: string; content: string }>> = {}
  for (let i = 0; i < changes.length; i += 1) {
    const c = changes[i]
    const dir = path.posix.dirname(c.path.replace(/\\/g, '/'))
    const key = dir === '.' ? '' : dir
    if (!byDir[key]) byDir[key] = []
    byDir[key].push({ name: path.posix.basename(c.path.replace(/\\/g, '/')), content: c.content })
  }
  function rebuild(dir: string): string {
    const rows = lsTree(dir === '' ? 'HEAD' : 'HEAD:' + dir)
    const direct = byDir[dir] || []
    for (let i = 0; i < direct.length; i += 1) {
      const blob = git(['hash-object', '-w', '--stdin'], direct[i].content)
      if (blob.code !== 0) throw new Error('hash-object 失败：' + (blob.err || blob.out))
      const hit = rows.filter((r) => r.name === direct[i].name)[0]
      if (hit) hit.sha = blob.out
      else rows.push({ mode: '100644', type: 'blob', sha: blob.out, name: direct[i].name })
    }
    // 子目录里还有要改的，就先递归把那个子树换掉，再写这一层。
    // 注意这里下钻的是「下一个路径段」（src → deck → tools），不是整段剩余路径：
    // 早先按整段判断会导致深层改动（src/deck/tools/context.ts）被静默跳过，自测乙就是这样漏过去的。
    const childNames: Record<string, boolean> = {}
    const keys = Object.keys(byDir)
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i]
      if (k === dir) continue
      let rel = ''
      if (dir === '') rel = k
      else if (k.indexOf(dir + '/') === 0) rel = k.slice(dir.length + 1)
      else continue
      const seg = rel.split('/')[0]
      if (seg) childNames[seg] = true
    }
    const names = Object.keys(childNames)
    for (let i = 0; i < names.length; i += 1) {
      const sub = rebuild(dir === '' ? names[i] : dir + '/' + names[i])
      const row = rows.filter((r) => r.name === names[i])[0]
      if (row) row.sha = sub
      else rows.push({ mode: '040000', type: 'tree', sha: sub, name: names[i] })
    }
    return mktree(rows)
  }
  const tree = rebuild('')
  const base = gitOk(['rev-parse', 'HEAD'])
  const commit = git(['commit-tree', tree, '-p', base, '-m', message])
  if (commit.code !== 0) throw new Error('commit-tree 失败：' + (commit.err || commit.out))
  return commit.out
}

// ─────────────────────────── profile 安装 / 备份 / 回滚 ───────────────────────────

function pluginDirOf(profile: string): string {
  return path.join(profile, 'node_modules', 'dsh-mattpocock-skills-deck')
}

/** 删掉一个目录；遇到链接（junction / 符号链接）只摘链接本身，绝不顺着链接删到目标里去。 */
function removeInstalled(dir: string): void {
  let st: any = null
  try { st = fs.lstatSync(dir) } catch (e) { st = null }
  if (!st) return
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) { fs.unlinkSync(dir); return }
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 把构建产物（package/ 目录）装成 profile 里的插件目录；package-lock.json 不属发布内容，跳过。 */
function installPackage(packageDir: string, pluginDir: string): void {
  removeInstalled(pluginDir)
  fs.mkdirSync(path.dirname(pluginDir), { recursive: true })
  fs.cpSync(packageDir, pluginDir, {
    recursive: true,
    filter: (src: string) => {
      const base = path.basename(src)
      return base !== 'package-lock.json' && base !== 'node_modules'
    },
  })
}

// ───────────────────────────── 第 3 步：deck_context 冒烟 ─────────────────────────────

interface SmokeResult { ok: boolean; text: string; detail: string }

/**
 * 从**已安装的 profile 包路径**导入 deck 工具，对一个临时 markdown 工作区跑一次 deck_context。
 *
 * 为什么这样算「装进 profile 后的真冒烟」：导入的每一个模块都来自 profile 里那份拷贝（不是 src/ 也不是 package/），
 * 所以这段能抓住「构建产物缺文件、模块之间说明符写断、版本里少了后端」这类只有装完才看得见的问题。
 * 为什么不启动 Electron：deck_context 的依赖都是普通对象（注册表、判定出口、算账函数），给齐就能跑；
 * 沙箱与界面那一层不参与「这个工作区是哪个后端、仓库是什么」这个结论。
 */
async function deckContextSmoke(installedDir: string): Promise<SmokeResult> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sync-smoke-'))
  const cleanup = (): void => { try { fs.rmSync(ws, { recursive: true, force: true }) } catch (e) { /* 临时目录删不掉不影响结论 */ } }
  try {
    const wsPosix = ws.replace(/\\/g, '/')
    fs.mkdirSync(path.join(ws, 'docs', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'docs', 'agents', 'workspace.yaml'), 'version: 2\nbackendId: markdown\npickedAt: 1700000000000\nsource: user\n')
    fs.mkdirSync(path.join(ws, '.scratch', 'smoke', 'issues'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.scratch', 'smoke', 'map.md'), '# 冒烟地图\n<!-- DSH-FORMAT: md-v1 -->\n')

    const bust = '?v=' + stamp() + '-' + String(Math.random()).slice(2, 8)
    const imp = async (rel: string): Promise<any> => import(pathToFileURL(path.join(installedDir, rel)).href + bust)

    const platFs = {
      resolve: async (p: unknown): Promise<string> => String(p).replace(/\\/g, '/'),
      readText: async (p: unknown): Promise<string> => String(fs.readFileSync(String(p), 'utf8')),
      writeText: async (p: unknown, c: unknown): Promise<void> => { fs.mkdirSync(path.dirname(String(p)), { recursive: true }); fs.writeFileSync(String(p), String(c), 'utf8') },
      lstat: async (p: unknown): Promise<any> => { try { return fs.statSync(String(p)) } catch (e) { return null } },
      stat: async (p: unknown): Promise<any> => { try { return fs.statSync(String(p)) } catch (e) { return null } },
      listDir: async (p: unknown): Promise<string[]> => { try { return fs.readdirSync(String(p)) } catch (e) { return [] } },
      mkdir: async (p: unknown): Promise<void> => { fs.mkdirSync(String(p), { recursive: true }) },
      rm: async (p: unknown): Promise<void> => { try { fs.rmSync(String(p), { recursive: true, force: true }) } catch (e) { /* 冒烟不写盘，删不掉无所谓 */ } },
      unlink: async (p: unknown): Promise<void> => { try { fs.unlinkSync(String(p)) } catch (e) { /* 同上 */ } },
    }
    const platform = { path: path.posix, fs: platFs }
    const backendCtx = { platform: platform, fs: platFs, cwd: wsPosix, get: (n: string): unknown => (n === 'fs' ? platFs : undefined), logEvent: (): void => {}, isEnabled: (): boolean => false }

    const registryMod = await imp('tracker/registry/core.js')
    const markdownMod = await imp('tracker/rooms/markdown/index.js')
    const decisionMod = await imp('tracker/detection/backendDecision.js')
    const anchorMod = await imp('deck/shell/workspace-anchor.js')
    const contextMod = await imp('deck/tools/context.js')
    const budgetMod = await imp('refresh/kernel/host-budget.js')
    const toolCost = await imp('refresh/kernel/tool-call-budget.js')

    const registry = registryMod.createRegistry(backendCtx, { matchesTimeout: 200 })
    registry.register(markdownMod.markdownModule)
    const readWorkspaceFileText = async (cwd: unknown): Promise<string | null> => {
      try { return String(fs.readFileSync(path.join(String(cwd), String(anchorMod.WORKSPACE_FILE_REL)), 'utf8')) } catch (e) { return null }
    }
    const tool = contextMod.createDeckContext({
      registry: registry,
      backendCtx: backendCtx,
      budget: budgetMod,
      estimate: toolCost.estimateToolCost,
      costInputFrom: toolCost.toolCostInputFrom,
      decideBackend: decisionMod.decideBackend,
      readWorkspaceFileText: readWorkspaceFileText,
      parseWorkspaceFile: anchorMod.parseWorkspaceFile,
      handleFor: (s: any): unknown => ({ cwd: s && s.cwd }),
      getCachedReading: async (): Promise<unknown> => ({ known: false, reason: 'smoke' }),
    })
    const back: any = await tool.run({ agent: { session: { cwd: wsPosix, id: 'sync-upstream-smoke' } } }, {})
    const value: any = (back && back.value !== undefined) ? back.value : back
    const data: any = (value && value.data) || {}
    const backendId = data.backend ? String(data.backend.id) : ''
    const root = data.workspace ? data.workspace.root : ''
    const maps = Array.isArray(data.maps) ? data.maps.length : -1
    const problems: string[] = []
    if (!value || value.status !== 'ok') problems.push('回执状态是 ' + String(value && value.status) + '（原因 ' + String(value && value.reason) + '）')
    if (backendId !== 'markdown') problems.push('后端认成了 ' + (backendId || '（空）') + '，期望 markdown')
    if (normPath(root) !== normPath(wsPosix)) problems.push('工作区认成了 ' + (root || '（空）') + '，期望 ' + wsPosix)
    if (maps < 1) problems.push('地图清单里没有那张冒烟地图（拿到 ' + maps + ' 张）')
    const summary = 'backend=' + (backendId || '（空）') + ' workspace=' + (root || '（空）') + ' maps=' + maps
    return { ok: problems.length === 0, text: summary, detail: problems.join('；') || summary }
  } catch (e) {
    return { ok: false, text: '', detail: '导入或调用已安装的 deck 工具时抛错：' + String((e && (e as Error).message) || e).slice(0, 400) }
  } finally {
    cleanup()
  }
}

// ───────────────────────────── 一轮合并 ─────────────────────────────

function resolveFrom(o: Options): { ok: true; ref: string; note: string } | { ok: false; reason: string } {
  const raw = (o.from || '').trim()
  if (raw && exists(raw) && isDir(raw)) {
    // 本地仓：本地 fetch 一次（不联网），只用 FETCH_HEAD，不往远端分支 ref 上写东西。
    const f = git(['fetch', '--no-tags', path.resolve(raw), 'main'])
    if (f.code !== 0) return { ok: false, reason: '从本地仓 ' + raw + ' 取 main 失败：' + (f.err || f.out) }
    return { ok: true, ref: 'FETCH_HEAD', note: '本地仓 ' + raw + ' 的 main（FETCH_HEAD）' }
  }
  const target = raw || 'upstream/main'
  const rev = git(['rev-parse', '--verify', target + '^{commit}'])
  if (rev.code !== 0) {
    return {
      ok: false,
      reason: '本机没有 ' + target + ' 这个提交。脚本不联网，请先手动 git fetch upstream main，' +
        '或用 --from 指一个已有的提交 / 本地仓目录。',
    }
  }
  return { ok: true, ref: rev.out, note: target + ' = ' + rev.out.slice(0, 12) }
}

function tailOf(res: { tail: string }): string { return res.tail ? '最后几行：' + res.tail : '' }

async function runRound(o: Options): Promise<RoundResult> {
  const steps: StepResult[] = []
  const startBranch = gitOk(['rev-parse', '--abbrev-ref', 'HEAD'])
  const mainBefore = git(['rev-parse', '--verify', 'main']).out
  const statusBefore = git(['status', '--porcelain']).out
  const result: RoundResult = {
    verdict: 'REJECT', reason: '', branch: o.branch, fromRef: '',
    mainBefore: mainBefore, mainAfter: mainBefore, steps: steps, backupDir: '', installedDir: pluginDirOf(o.profile),
  }

  const finish = (verdict: 'ACCEPT' | 'REJECT', reason: string): RoundResult => {
    result.verdict = verdict
    result.reason = reason
    // 还没收尾的合并先撤掉：留一半的索引在盘上，下一轮的前置检查会直接拦下来。
    if (git(['rev-parse', '--verify', 'MERGE_HEAD']).code === 0) {
      const ab = git(['merge', '--abort'])
      if (ab.code !== 0) log('WARN 撤掉没收尾的合并失败，工作区可能还停在中途：' + (ab.err || ab.out))
    }
    const cur = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
    if (cur !== startBranch) {
      const back = git(['checkout', startBranch])
      if (back.code !== 0) log('WARN 切回 ' + startBranch + ' 失败：' + (back.err || back.out))
    }
    result.mainAfter = git(['rev-parse', '--verify', 'main']).out
    if (result.mainAfter !== result.mainBefore) {
      log('ERROR main 被动了：' + result.mainBefore + ' → ' + result.mainAfter + '（这不该发生，先停下看现场）')
      result.verdict = 'REJECT'
      result.reason = result.reason + '；另外 main 的 sha 变了，这轮不算数'
    }
    const statusAfter = git(['status', '--porcelain']).out
    if (statusAfter !== statusBefore && verdict === 'ACCEPT') {
      log('WARN 这一轮留下的工作区改动与开跑前不同（合成本身不该改工作区）：' + statusAfter.replace(/\n/g, ' / ').slice(0, 300))
    }
    return result
  }

  // 0. 前置：脏工作区与没做完的合并
  const mergeHead = git(['rev-parse', '--verify', 'MERGE_HEAD'])
  if (mergeHead.code === 0) return finish('REJECT', '本仓还有一次没做完的合并（MERGE_HEAD 在）：先在 ' + startBranch + ' 上 git merge --abort 或合完它，再来跑这一轮。')
  if (statusBefore && !o.allowDirty) {
    return finish('REJECT', '工作区有未提交改动，合并可能碰到你的活：先提交 / 收好，或用 --allow-dirty 明确放行。')
  }

  const from = resolveFrom(o)
  if (!from.ok) return finish('REJECT', from.reason)
  result.fromRef = from.note
  log('[0/4] 起点：分支 ' + startBranch + '，main ' + mainBefore.slice(0, 12) + '；要合 ' + from.note)

  // 1. 开 / 复用 sync 分支
  const hasBranch = git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + o.branch]).code === 0
  const co = hasBranch ? git(['checkout', o.branch]) : git(['checkout', '-b', o.branch, o.base])
  if (co.code !== 0) return finish('REJECT', '开 / 切到分支 ' + o.branch + ' 失败：' + (co.err || co.out))
  log('[1/4] 分支 ' + o.branch + (hasBranch ? '（复用已有的）' : '（从 ' + o.base + ' 新开）'))

  // 2. 合并
  const merge = git(['merge', '--no-edit', from.ref])
  if (merge.code !== 0) {
    const conflicts = gitLines(['diff', '--name-only', '--diff-filter=U'])
    if (conflicts.length === 0) return finish('REJECT', '合并失败（不是冲突）：' + (merge.err || merge.out).slice(0, 400))
    const human = conflicts.filter((p: string) => !isGeneratedPath(p))
    if (human.length > 0) {
      git(['merge', '--abort'])
      steps.push({ name: '合并', ok: false, ms: 0, note: '非产物路径冲突：' + human.join(', ') })
      return finish('REJECT', '冲突落在非产物路径上，脚本不替人裁决：' + human.join('、'))
    }
    // 产物冲突：取上游那一份，内容由紧跟着的重新构建覆盖回来（绝不手改产物）。
    for (let i = 0; i < conflicts.length; i += 1) {
      const p = conflicts[i]
      const take = git(['checkout', '--theirs', '--', p])
      if (take.code !== 0) { git(['merge', '--abort']); return finish('REJECT', '取上游那份产物失败：' + p + '（' + (take.err || take.out) + '）') }
      const add = git(['add', '--', p])
      if (add.code !== 0) { git(['merge', '--abort']); return finish('REJECT', '把产物冲突标成已解决失败：' + p) }
    }
    const commit = git(['commit', '--no-edit'])
    if (commit.code !== 0) { git(['merge', '--abort']); return finish('REJECT', '产物冲突按重建解决后收尾提交失败：' + (commit.err || commit.out).slice(0, 300)) }
    log('[2/4] 合并完成；产物冲突 ' + conflicts.length + ' 个已按「取上游 + 重新构建」处理：' + conflicts.join(', '))
    steps.push({ name: '合并（产物冲突按重建解决）', ok: true, ms: 0, note: conflicts.join(', ') })
  } else {
    log('[2/4] 合并完成' + (merge.out.indexOf('Already up to date') >= 0 ? '（已经是最新，无需合并）' : ''))
  }

  // 3. 三步验证
  const step1 = runCmd('pnpm install --frozen-lockfile', o.quiet)
  steps.push({ name: '① pnpm install --frozen-lockfile', ok: step1.code === 0, ms: step1.ms, note: step1.code === 0 ? '' : tailOf(step1) })
  log('  ' + (step1.code === 0 ? 'PASS' : 'FAIL') + ' ① pnpm install --frozen-lockfile（' + step1.ms + 'ms）')
  if (step1.code !== 0) return finish('REJECT', '第 1 步装依赖失败（' + tailOf(step1) + '）')

  const t2 = Date.now()
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mts')], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: o.quiet ? 'pipe' : 'inherit' })
  const ms2 = Date.now() - t2
  const code2 = r2.status === null ? -1 : r2.status
  const tail2 = String((r2.stdout || '') + (r2.stderr || '')).split('\n').filter((s: string) => !!s.trim()).slice(-6).join(' | ')
  steps.push({ name: '② node scripts/build.mts', ok: code2 === 0, ms: ms2, note: code2 === 0 ? '' : tail2 })
  log('  ' + (code2 === 0 ? 'PASS' : 'FAIL') + ' ② node scripts/build.mts（' + ms2 + 'ms）')
  if (code2 !== 0) return finish('REJECT', '第 2 步构建失败，退出码 ' + code2 + (tail2 ? '（最后几行：' + tail2 + '）' : ''))

  // 3. 装进 profile（先备份）再跑 deck_context
  const t3 = Date.now()
  const installedDir = pluginDirOf(o.profile)
  const backupDir = path.join(o.backupRoot, 'profile-backup-' + stamp())
  result.backupDir = backupDir
  result.installedDir = installedDir
  const hadInstalled = exists(installedDir)
  if (hadInstalled) {
    fs.mkdirSync(o.backupRoot, { recursive: true })
    fs.cpSync(installedDir, backupDir, { recursive: true })
  }
  const rollback = (): void => {
    try {
      removeInstalled(installedDir)
      if (hadInstalled) fs.cpSync(backupDir, installedDir, { recursive: true })
      log('  已把 profile 的插件目录回滚到备份：' + backupDir)
    } catch (e) {
      log('ERROR 回滚 profile 失败，需要人工把 ' + backupDir + ' 拷回 ' + installedDir + '：' + String((e && (e as Error).message) || e))
    }
  }
  installPackage(path.join(ROOT, 'package'), installedDir)
  if (typeof o.onProfileInstalled === 'function') o.onProfileInstalled(installedDir)
  const smoke = await deckContextSmoke(installedDir)
  const ms3 = Date.now() - t3
  steps.push({ name: '③ 装进 profile 跑 deck_context', ok: smoke.ok, ms: ms3, note: smoke.detail })
  log('  ' + (smoke.ok ? 'PASS' : 'FAIL') + ' ③ deck_context 冒烟（' + ms3 + 'ms）：' + smoke.detail + '（装到 ' + installedDir + '）')
  if (!smoke.ok) {
    rollback()
    return finish('REJECT', '第 3 步 deck_context 冒烟不过：' + smoke.detail)
  }
  log('[3/4] 三步验证全过')
  log('[4/4] 结论：ACCEPT')
  return finish('ACCEPT', '三步验证全过')
}

function printRound(r: RoundResult): void {
  log('')
  log('sync-upstream 结论：' + r.verdict)
  log('  分支：' + r.branch + (r.fromRef ? '（合 ' + r.fromRef + '）' : ''))
  for (let i = 0; i < r.steps.length; i += 1) {
    const s = r.steps[i]
    log('  ' + (s.ok ? 'PASS' : 'FAIL') + ' ' + s.name + '（' + s.ms + 'ms）' + (s.note ? ' —— ' + s.note.slice(0, 300) : ''))
  }
  if (r.backupDir) log('  profile 备份：' + r.backupDir + '（插件目录 ' + r.installedDir + '）')
  log('  main：' + r.mainBefore.slice(0, 12) + ' → ' + r.mainAfter.slice(0, 12) + (r.mainBefore === r.mainAfter ? '（未动）' : '（变了，这轮不算数）'))
  if (r.reason) log('  原因：' + r.reason)
  if (r.verdict === 'ACCEPT') {
    log('  回到 main 是人的动作：git checkout main && git merge --ff-only ' + r.branch)
  } else {
    log('  main 没动，这一轮整轮可丢；本脚本不删分支（下一轮会复用 ' + r.branch + '）。')
  }
}

// ───────────────────────────── 自测 ─────────────────────────────

interface SelfTestCheck { ok: boolean; msg: string }

function seedFakeProfile(profile: string): string {
  const dir = pluginDirOf(profile)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'old-marker.txt'), '上一版的插件目录（自测占位）\n')
  return dir
}

async function selfTest(): Promise<number> {
  const base = parseArgs([]) as Options
  const scratch = path.join(ROOT, '.tmp', 'sync-selftest-' + stamp())
  fs.mkdirSync(scratch, { recursive: true })
  const checks: SelfTestCheck[] = []
  const check = (ok: boolean, msg: string): void => {
    checks.push({ ok: ok, msg: msg })
    log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + msg)
  }
  const startBranch = gitOk(['rev-parse', '--abbrev-ref', 'HEAD'])
  const mainBefore = gitOk(['rev-parse', '--verify', 'main'])
  log('自测：临时 profile 与本地造的提交，不碰真实 profile、不联网（scratch=' + scratch + '）')

  const common = (): Options => Object.assign({}, base, {
    base: 'main', allowDirty: true, quiet: true,
    backupRoot: path.join(scratch, 'backups'),
  })

  // 甲：上游只加一个探针文件 → 三步全过 → ACCEPT
  {
    const profile = path.join(scratch, 'profile-a')
    const pluginDir = seedFakeProfile(profile)
    const commit = makeUpstreamCommit([{ path: 'sync-probe-a.md', content: '上游演练：只加一个探针文件。\n' }], '上游演练提交：只加一个探针文件')
    const o = common()
    o.from = commit; o.branch = 'sync/selftest-a'; o.profile = profile
    log('甲：三步都该过的一轮（分支 ' + o.branch + '）')
    const r = await runRound(o)
    check(r.verdict === 'ACCEPT', '甲 结论是 ACCEPT（实得 ' + r.verdict + '，原因 ' + r.reason + '）')
    check(r.steps.length === 3 && r.steps.every((s: StepResult) => s.ok), '甲 三步都 PASS（实得 ' + r.steps.map((s: StepResult) => (s.ok ? 'ok' : 'fail')).join(',') + '）')
    check(r.mainBefore === r.mainAfter, '甲 main 没动（' + r.mainBefore.slice(0, 12) + '）')
    check(exists(path.join(pluginDir, 'package.json')) && !exists(path.join(pluginDir, 'old-marker.txt')), '甲 新构建已装进 profile（占位标记被替换）')
    check(exists(r.backupDir) && exists(path.join(r.backupDir, 'old-marker.txt')), '甲 装之前把旧插件目录备份下来了（' + r.backupDir + '）')
    check(gitOk(['rev-parse', '--abbrev-ref', 'HEAD']) === startBranch, '甲 结束后回到开始时的分支 ' + startBranch)
    git(['branch', '-D', o.branch])
    fs.rmSync(profile, { recursive: true, force: true })
  }

  // 乙：上游把一份源码改坏 → 构建失败 → REJECT，且 main 不动、profile 不被碰
  {
    const profile = path.join(scratch, 'profile-b')
    const pluginDir = seedFakeProfile(profile)
    const commit = makeUpstreamCommit([{ path: 'src/deck/tools/context.ts', content: 'export const syncProbeBroken = ;\n' }], '上游演练提交：把 deck_context 的源码改坏')
    const o = common()
    o.from = commit; o.branch = 'sync/selftest-b'; o.profile = profile
    log('乙：构建必挂的一轮（分支 ' + o.branch + '）')
    const r = await runRound(o)
    check(r.verdict === 'REJECT', '乙 结论是 REJECT（实得 ' + r.verdict + '）')
    check(r.steps.length >= 2 && r.steps[1].ok === false, '乙 卡在第 2 步构建（实得 ' + r.steps.map((s: StepResult) => s.name + ':' + (s.ok ? 'ok' : 'fail')).join(' / ') + '）')
    check(r.steps.length === 2, '乙 构建失败后不再往下走第 3 步（实得 ' + r.steps.length + ' 步）')
    check(r.mainBefore === r.mainAfter, '乙 main 没动（' + r.mainBefore.slice(0, 12) + '）')
    check(exists(path.join(pluginDir, 'old-marker.txt')) && !exists(path.join(pluginDir, 'package.json')), '乙 profile 没被装过（占位标记还在）')
    check(gitOk(['rev-parse', '--abbrev-ref', 'HEAD']) === startBranch, '乙 结束后回到开始时的分支 ' + startBranch)
    check(git(['status', '--porcelain', '--', 'src/deck/tools/context.ts']).out === '', '乙 被改坏的源码没有留在工作区')
    git(['branch', '-D', o.branch])
    fs.rmSync(profile, { recursive: true, force: true })
  }

  // 丙：构建能过但 profile 里的包是坏的 → 冒烟失败 → REJECT 且 profile 回滚
  {
    const profile = path.join(scratch, 'profile-c')
    const pluginDir = seedFakeProfile(profile)
    const commit = makeUpstreamCommit([{ path: 'sync-probe-c.md', content: '上游演练：再加一个探针文件。\n' }], '上游演练提交：再加一个探针文件')
    const o = common()
    o.from = commit; o.branch = 'sync/selftest-c'; o.profile = profile
    o.onProfileInstalled = (dir: string): void => { fs.rmSync(path.join(dir, 'deck', 'tools', 'context.js'), { force: true }) }
    log('丙：装完把包弄坏的一轮（分支 ' + o.branch + '）')
    const r = await runRound(o)
    check(r.verdict === 'REJECT', '丙 结论是 REJECT（实得 ' + r.verdict + '）')
    check(r.steps.length === 3 && r.steps[2].ok === false, '丙 卡在第 3 步冒烟（实得 ' + r.steps.map((s: StepResult) => s.name + ':' + (s.ok ? 'ok' : 'fail')).join(' / ') + '）')
    check(r.mainBefore === r.mainAfter, '丙 main 没动（' + r.mainBefore.slice(0, 12) + '）')
    check(exists(path.join(pluginDir, 'old-marker.txt')) && !exists(path.join(pluginDir, 'package.json')), '丙 profile 已回滚到备份（占位标记回来了、坏包没留下）')
    check(gitOk(['rev-parse', '--abbrev-ref', 'HEAD']) === startBranch, '丙 结束后回到开始时的分支 ' + startBranch)
    git(['branch', '-D', o.branch])
    fs.rmSync(profile, { recursive: true, force: true })
  }

  // 收尾：把工作区的构建产物重新对齐回当前分支（自测在各分支上跑过构建，产物是别的树的）。
  log('收尾：在当前分支上重建一次，让 package/ 与源码对齐')
  const rebuild = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mts')], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: 'pipe' })
  check((rebuild.status === null ? -1 : rebuild.status) === 0, '收尾重建退出码 0')
  check(gitOk(['rev-parse', '--verify', 'main']) === mainBefore, '整场自测 main 一直是 ' + mainBefore.slice(0, 12))

  const failed = checks.filter((c: SelfTestCheck) => !c.ok)
  log('')
  log('自测结论：' + (failed.length === 0 ? 'PASS' : 'FAIL') + '（' + (checks.length - failed.length) + '/' + checks.length + ' 条过）')
  if (failed.length > 0) for (let i = 0; i < failed.length; i += 1) log('  未过：' + failed[i].msg)
  log('scratch 留在 ' + scratch + '（下次自测可删）')
  return failed.length === 0 ? 0 : 1
}

// ───────────────────────────── 入口 ─────────────────────────────

async function main(): Promise<void> {
  let parsed: Options | { help: true }
  try { parsed = parseArgs(process.argv.slice(2)) } catch (e) {
    console.error(String((e && (e as Error).message) || e))
    process.exit(2)
  }
  if ((parsed as { help?: boolean }).help) {
    log('用法：node scripts/sync-upstream.mts [--from <ref|sha|目录>] [--base main] [--branch sync/<日期>] [--profile <目录>] [--backup-root <目录>] [--allow-dirty] [--quiet] [--self-test]')
    log('一轮合并：开 sync 分支 → 合上游 → 三步验证（装依赖 / 构建 / 装进 profile 跑 deck_context）→ 打印 ACCEPT 或 REJECT。')
    return
  }
  const o = parsed as Options
  process.chdir(ROOT)
  if (o.selfTest) {
    const code = await selfTest()
    process.exit(code)
  }
  const r = await runRound(o)
  printRound(r)
  process.exit(r.verdict === 'ACCEPT' ? 0 : 1)
}

await main()