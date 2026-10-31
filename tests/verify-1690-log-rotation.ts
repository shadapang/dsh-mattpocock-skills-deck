/**
 * tests/verify-1690-log-rotation.ts —— 日志文件口必须能轮转（#1690，2026-10-31 04:48 宿主 OOM 的根因门禁）
 *
 * 事故：index.ts 递给 dsh-log 的文件口白名单里没有 `rename` → dsh-log 的封存逻辑
 *   （dist/engine/rotation.js `sealCurrentFile`）直接返回 `no-rename` → 每次轮转都降级并记一行
 *   `log.rotate.degraded` → 当日日志永不封存、无上限增长（10-28 0.98MB → 10-29 3.2MB → 10-30 8.4MB，
 *   单日 4 万行），而 dsh-log 每次 flush 是「整篇读进来 + 整篇写回」，写放大随文件线性增长，
 *   最终堆涨到 4GB：`FATAL ERROR: MarkCompactCollector: young object promotion failed`。
 *
 * 本门禁钉三件事：
 *   ① 文件口里必须有 rename（原生有就转发，没有就退化成「读→写→删」，dsh-log 认这种搬法）；
 *   ② 退化的 rename 真的把内容搬走且删掉源文件（源在 = dsh-log 会判没搬成，等于没修）；
 *   ③ index.ts 不再自己写一份方法白名单（单源在 src/host/logFsPort.ts）。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-1690-log-rotation.ts
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

const root = path.resolve(import.meta.dirname, '..')
const mod = await import(pathToFileURL(path.join(root, 'src/host/logFsPort.ts')).href)
const { buildLogFsPort, LOG_FS_METHODS } = mod as any

console.log('== ① 文件口必须带 rename（这一格丢了就是 04:48 那场 OOM）')
{
  const svc: any = { readText: () => 'x', writeText: () => undefined, unlink: () => undefined, listDir: () => [], stat: () => ({}), exists: () => true }
  const port: any = buildLogFsPort(() => svc)
  check(typeof port.rename === 'function', '① 宿主服务没有原生 rename 时，文件口仍给出可用的 rename（降级实现）')
  check(LOG_FS_METHODS.includes('rename') === false && port.rename !== undefined, '① rename 单独挂在文件口上（不混进白名单数组，避免再被漏掉）')
  for (const m of ['readText', 'writeText', 'unlink', 'listDir', 'stat', 'exists']) {
    check(typeof port[m] === 'function', '① 基础方法仍在：' + m)
  }
}

console.log('== ② 降级 rename 的语义：内容搬过去、源文件删掉')
{
  const files = new Map<string, string>([['a.log', 'hello-day']])
  const calls: string[] = []
  const svc: any = {
    readText: (p: any) => { calls.push('read:' + p); return files.get(String(p)) },
    writeText: (p: any, text: any) => { calls.push('write:' + p); files.set(String(p), String(text)) },
    unlink: (p: any) => { calls.push('unlink:' + p); files.delete(String(p)) },
  }
  const port: any = buildLogFsPort(() => svc)
  await port.rename('a.log', 'a.1.log')
  check(files.get('a.1.log') === 'hello-day', '② 内容落在目标文件上')
  check(files.has('a.log') === false, '② 源文件已删掉（dsh-log 回查「源还在」就会判没搬成）')
  check(calls.join(',') === 'read:a.log,write:a.1.log,unlink:a.log', '② 走的正是「读→写→删」三步，顺序不错')
}

console.log('== ③ 原生 rename 优先：有就不自己搬')
{
  let nativeCalled = 0
  const svc: any = { rename: (a: any, b: any) => { nativeCalled++; return a + '->' + b }, readText: () => '', writeText: () => undefined, unlink: () => undefined }
  const port: any = buildLogFsPort(() => svc)
  const r = await port.rename('x', 'y')
  check(nativeCalled === 1 && r === 'x->y', '③ 服务有原生 rename 时直接转发（不复制一遍内容）')
}

console.log('== ④ 服务拿不到/能力缺失时给 undefined（dsh-log 自带降级），不许抛')
{
  const port: any = buildLogFsPort(() => null as any)
  check(port.readText === undefined && port.rename === undefined, '④ 服务不在时各格是 undefined，不抛错')
  const partial: any = buildLogFsPort(() => ({ readText: () => 'x' } as any))
  check(typeof partial.readText === 'function' && partial.rename === undefined, '④ 只有读能力时不给 rename（凑不出「读→写→删」就明说没有）')
}

console.log('== ⑤ 接线：单源在 logFsPort.ts，index.ts 不再自己列白名单')
{
  const { sourceText } = requireHere('./lib/source-text.ts')
  const hostIndex = sourceText('src/host/index.ts')
  check(/buildLogFsPort/.test(hostIndex), '⑤ index.ts 用 buildLogFsPort 建文件口')
  check(!/\[.resolve.,.readText./.test(hostIndex), '⑤ index.ts 里那份手写方法白名单已删除（漏掉 rename 的就是它）')
  const portSrc = sourceText('src/host/logFsPort.ts')
  check(/rename/.test(portSrc) && /readText/.test(portSrc) && /unlink/.test(portSrc), '⑤ 降级实现（读→写→删）在单一真源里')
  check(/1690/.test(portSrc) && /4GB|out of memory/.test(portSrc), '⑤ 文件头记录了事故与判据（后人删这格前能看见代价）')
}

if (failed) {
  console.log('\n存在失败 — verify-1690-log-rotation 未通过（失败项见上）')
  process.exit(1)
}
console.log('\n' + total + ' 条断言全部通过 — 日志文件口能轮转，#1690 的降级死循环不会再出现')
