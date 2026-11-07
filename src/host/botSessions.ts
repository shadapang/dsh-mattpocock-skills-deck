// src/host/botSessions.ts —— Bot 会话判定（只读 ds-bot 的 state，不改它）
//
// 为什么在 MattSkills 这边做：
//   ds-bot 内部有 isBotSession(id) = chatOwners.has(id) || groupOwners.has(id)，但没有外露；
//   而 ds-bot 住在 node_modules 里，改了会被下一次更新覆盖。
//   它的 state（$DSH_HOME/bot/state.json）是那份名单的权威来源，只读它即可：
//     - bots[*].sessionId  = Bot 的私聊会话（ds-bot 的 chatOwners）
//     - rooms[*].sessions  = 群聊会话（ds-bot 的 groupOwners）
//   名单会变（Bot 加入/退出、群会话轮换），所以按 mtime 缓存，文件一变即重读。
//
// 用途：肖哥口径 —— Bot 会话里点「新建需求」= 把提示词注入当前 Bot 对话，不开新会话。
//   （那条路上 uiWorkspace.openSession 不产生可观测的成功，见 .scratch/mattskills 诊断报告。）

// @ts-expect-error —— 本域 tsconfig 有意不加载任何类型包（types 为空），node:fs 的类型声明缺席；
//   运行时一定是 Node，该模块必然存在（纯类型层面，不影响 esbuild 的运行时转译，同 bootstrap.ts 写法）。
import { readFileSync, statSync } from 'node:fs'
// @ts-expect-error —— 见上，node:os 同理。
import { homedir } from 'node:os'
// @ts-expect-error —— 见上，node:path 同理。
import { join, resolve } from 'node:path'

// 本域 types 为空，process 的类型声明也缺席；运行时一定是 Node。按「可能不存在」写（同 bootstrap.ts）。
declare const process: { env: Record<string, string | undefined> } | undefined

/** ds-bot 的 home 解析与 folders.dshHomeOf 同口径：DSH_HOME 缺省 ~/.dsh，展开 ~。 */
function defaultStatePath() {
  let raw = ''
  try { raw = (typeof process !== 'undefined' && process.env) ? String(process.env.DSH_HOME || '').trim() : '' } catch (e) { raw = '' }
  const home = resolve(raw ? raw : join(homedir(), '.dsh'))
  return join(home, 'bot', 'state.json')
}

export function createBotSessions(deps: any) {
  const logCtx = deps?.logCtx ?? null
  let cachePath = ''
  let cacheMtime = -1
  let cacheIds: Set<string> = new Set()

  function statePath() {
    return String(deps?.statePath || defaultStatePath())
  }

  /** Bot 会话 id 全集（私聊 + 群聊）。读不到时回上一次成功的缓存（初始为空集）。 */
  function ids(): Set<string> {
    const p = statePath()
    try {
      const st = statSync(p)
      if (p === cachePath && st.mtimeMs === cacheMtime) return cacheIds
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const out = new Set<string>()
      const bots = j && typeof j.bots === 'object' && j.bots ? j.bots : {}
      for (const b of Object.values(bots)) {
        const sid = b && typeof (b as any).sessionId === 'string' ? (b as any).sessionId : ''
        if (sid) out.add(sid)
      }
      const rooms = j && typeof j.rooms === 'object' && j.rooms ? j.rooms : {}
      for (const r of Object.values(rooms)) {
        const sess = r && typeof r === 'object' && (r as any).sessions && typeof (r as any).sessions === 'object' ? (r as any).sessions : {}
        for (const sid of Object.values(sess)) {
          if (typeof sid === 'string' && sid) out.add(sid)
        }
      }
      cachePath = p
      cacheMtime = st.mtimeMs
      cacheIds = out
      return out
    } catch (e) {
      try { if (logCtx) logCtx.fire('debug', 'botSessions.read.fail', { reason: String((e as any)?.message || e) }) } catch (eL) {}
      return cacheIds
    }
  }

  function isBotSession(id: any): boolean {
    if (typeof id !== 'string' || !id) return false
    return ids().has(id)
  }

  return {
    ids,
    isBotSession,
    /** wf.isBotSession 的宿主处理：只读，不写任何东西。 */
    handleIsBotSession(args: any) {
      const id = args && typeof args.id === 'string' ? args.id : ''
      const isBot = isBotSession(id)
      return { ok: true, id, isBot }
    },
  }
}
