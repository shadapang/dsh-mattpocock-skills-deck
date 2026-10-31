/**
 * src/host/logFsPort.ts —— 递给 dsh-log 的文件口（#1690 轮转修复）
 *
 * 为什么单独成文件：这里是「日志库能不能落盘、能不能轮转」的唯一入口，出过一次真事故 ——
 *   2026-10-31 04:48 宿主堆涨到 4GB（`FATAL ERROR: MarkCompactCollector ... heap out of memory`）。
 *   根因链：本文件此前把方法白名单写死在 index.ts 里，漏了 `rename`；dsh-log 的封存逻辑
 *   （dist/engine/rotation.js 的 sealCurrentFile）在 `fs.rename` 缺失时直接返回 `{ok:false, reason:'no-rename'}`，
 *   于是**每次轮转都降级**并记一行 `log.rotate.degraded`；当日日志永远封不走、越写越大
 *   （10-28 0.98MB → 10-29 3.2MB → 10-30 8.4MB，单日 4 万行、其中绝大多数是这条降级行），
 *   而 dsh-log 每次 flush 都是「整篇读进来 + 整篇写回」，写放大随文件线性增长 → 堆一路涨到上限。
 *
 * 两条不许改的约定：
 *  1. 方法白名单里必须有 `rename`。宿主 fs 服务没有原生 rename 时，用「读→写→删」等价实现顶上 ——
 *     dsh-log 认这种搬法（回查时源文件消失 + 目标文件出现即算搬成功，见 rotation.js 第 78-89 行）。
 *  2. 这里只搬日志库要用的那几格，不把整个 fs 服务摊出去；拿不到的格子返回 undefined（dsh-log 自带降级）。
 */

// ---------------------------------------------------------------------------
// 类型：宿主 fs 服务只按「用得到的那几格」声明，不假装知道它的完整形状。
// ---------------------------------------------------------------------------
export interface LogFsService {
  rename?: (from: unknown, to: unknown) => unknown
  readText?: (path: unknown) => unknown
  writeText?: (path: unknown, text: string) => unknown
  unlink?: (path: unknown) => unknown
  [key: string]: unknown
}

/** 递出去的文件口：键与 dsh-log 的 fs 端口一致，方法存在时是真函数，不存在时是 undefined。 */
export interface LogFsPort {
  [key: string]: unknown
}

/** 日志库会用到的方法（顺序即契约清单，新增一格必须同时补门禁里的断言）。 */
export const LOG_FS_METHODS: ReadonlyArray<string> = Object.freeze([
  'resolve', 'readText', 'writeText', 'mkdir', 'processPath', 'listDir', 'unlink', 'lstat', 'stat', 'exists',
])

/** 把宿主服务的一个方法包成「服务还在就转发、服务没了就返回 undefined」的取值器。 */
function forwarderOf(svc: () => LogFsService, name: string): () => any {
  return function (): any {
    const f = svc()
    return (f && typeof (f as any)[name] === 'function')
      ? function (...args: unknown[]): unknown { const fn = (svc() as any)[name]; return fn.apply(svc(), args) }
      : undefined
  }
}

/**
 * 轮转用的 rename：优先用宿主原生 rename；没有就退化成「读→写→删」。
 * 为什么可以退化：dsh-log 封存后要回查目录，判据是「源文件不在了、目标文件出现了」——
 *   与用哪种系统调用搬的无关。反过来，缺这一格就只能永远降级（#1690 的事故）。
 */
function renameOf(svc: () => LogFsService): (() => unknown) {
  return function (): unknown {
    const f = svc()
    if (f && typeof f.rename === 'function') {
      return function (from: unknown, to: unknown): unknown { const fn = (svc() as any).rename; return fn.call(svc(), from, to) }
    }
    const canCopy = !!(f && typeof f.readText === 'function' && typeof f.writeText === 'function' && typeof f.unlink === 'function')
    if (!canCopy) return undefined
    return async function (from: unknown, to: unknown): Promise<void> {
      const raw: any = await (svc() as any).readText(from)
      const text: string = (typeof raw === 'string') ? raw : String((raw && (raw.text != null ? raw.text : raw.content)) || '')
      await (svc() as any).writeText(to, text)
      await (svc() as any).unlink(from)
    }
  }
}

/**
 * 建日志文件口。
 * @param svc 取宿主 fs 服务的取值器（每次访问都重新取，服务换代后自动跟上；与原先 getter 行为一致）
 */
export function buildLogFsPort(svc: () => LogFsService): LogFsPort {
  const port: LogFsPort = {}
  for (const m of LOG_FS_METHODS) {
    Object.defineProperty(port, m, { configurable: true, enumerable: true, get: forwarderOf(svc, m) })
  }
  Object.defineProperty(port, 'rename', { configurable: true, enumerable: true, get: renameOf(svc) })
  return port
}
