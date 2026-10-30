/**
 * tests/verify-1672-auto-open.ts —— 「新会话默认展开右侧面板」的三条纪律（#1672）。
 *
 * 真机复现过的那条失败（1672-02）：在 deck 工具箱**关掉**的工作区里新开一条会话，面板照样自己展开了。
 * 日志链是 trace 67925e7b59531e9c 的 seq=3 `host.call.fail wf.getSettings` → seq=9 `panel-open`：
 * 新工作区首帧读不到设置，`deckToolsOf` 出于「不悄悄关掉用户的工具」一律按 on 兜底，
 * 于是自动展开把「读不到」当成了「开着」。修法：自动展开只认**明确**是 on（`deckToolsKnown`）。
 *
 * 本门禁钉三件事：
 *   ① `deckToolsKnown` 的语义：off→'off'、on→'on'、缺格→'on'（缺省开）、读抛出→'unknown'；
 *   ② 自动展开的判定只认 on：off 与 unknown 都不开，openPanel 只在 deckKnown === 'on' 时才被调用；
 *   ③ 接线：router 里确实声明并用了 deckToolsKnown（防止源码改回去而门禁不动）。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-1672-auto-open.ts
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

// deck-state 片靠 declare 拿闭包里的同名实现，这里挂替身当观察窗（与 verify-1612-deck-state 同一手法）。
let flagTable: Record<string, unknown> = {}
let readThrows = false
;(globalThis as any).viewFlagOf = (cwd: any, name: any) => {
  if (readThrows) throw new Error('读设置失败（夹具）')
  return flagTable[String(cwd) + '|' + String(name)]
}
;(globalThis as any).setViewFlagValue = () => true
;(globalThis as any).keyOf = (cwd: any) => String(cwd || '').replace(/[\\/]+$/, '').toLowerCase()
;(globalThis as any).emit = () => {}
;(globalThis as any).shared = { cwd: 'D:/ws-a' }
;(globalThis as any).stores = { s1: { cwd: 'D:/ws-a/' } }

const root = path.resolve(import.meta.dirname, '..')
const mod = await import(pathToFileURL(path.join(root, 'src/client/kernel/deck-state.ts')).href)
const { deckToolsKnown } = mod as any

console.log('== ① deckToolsKnown：只有 off 算关，读不到算 unknown ==')
{
  flagTable = { 'D:/ws-a|deckTools': 'off' }
  check(deckToolsKnown('D:/ws-a') === 'off', "① 写成 off → 'off'（自动展开必须放弃）")
  flagTable = { 'D:/ws-a|deckTools': 'on' }
  check(deckToolsKnown('D:/ws-a') === 'on', "① 写成 on → 'on'（唯一允许自动展开的取值）")
  flagTable = {}
  check(deckToolsKnown('D:/ws-a') === 'on', "① 文件里没有这一格 → 'on'（缺省开，别人不受影响）")
  flagTable = { 'D:/ws-a|deckTools': false }
  check(deckToolsKnown('D:/ws-a') === 'on', "① 旧布尔 false 不算关（本格只认字面量 off）")
  readThrows = true
  check(deckToolsKnown('D:/ws-a') === 'unknown', "① 读设置抛错 → 'unknown'（#1672 实测的那条路径：不许当开）")
  readThrows = false
}

console.log('\n== ② 自动展开的判定：只认明确 on，off 与 unknown 都不开 ==')
{
  const { sourceText } = requireHere('./lib/source-text.ts')
  const router = sourceText('src/client/kernel/router.ts')
  const start = router.indexOf('export const autoOpenPanelOnce')
  const block = start >= 0 ? router.slice(start, router.indexOf('export const togglePanel', start)) : ''
  check(start >= 0, '② 找到 autoOpenPanelOnce')
  check(/const deckToolsKnown/.test(router) || /declare const deckToolsKnown/.test(router), '② router 声明了 deckToolsKnown（接线在）')
  check(/deckKnown === 'off'\) return/.test(block), "② 明确 off 时直接放弃（不重试、不弹任何东西）")
  check(/ready && deckKnown === 'on'/.test(block), "② 只有 nativeTabReady 与 deckKnown === 'on' 同时成立才 openPanel")
  check(!/if \(typeof isDeckClosed === 'function' && isDeckClosed\(st\.cwd\)\) return/.test(block), '② 旧写法（只看 isDeckClosed）已不在自动展开里：读不到设置时它会放行')
  check(/tries >= 25/.test(block), '② 重试上限仍在（unknown 跟着这条节奏再问几次）')
  check(/st\.autoPanelOpened = true/.test(block), '② 同一条会话只试一次的标记还在')
  const openCalls = (block.match(/openPanel\(st\)/g) || []).length
  check(openCalls === 1, '② 自动展开里只有一处 openPanel(st)，且那处被 deckKnown === \'on\' 守着（实际 ' + openCalls + ' 处）')
}

if (failed) {
  console.log('\n存在失败 — verify-1672-auto-open 未通过（失败项见上）')
  process.exit(1)
}
console.log('\n' + total + ' 条断言全部通过 — 自动展开只在明确知道 deck 开着时才开')
