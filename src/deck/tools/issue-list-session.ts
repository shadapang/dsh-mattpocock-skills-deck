// issue-list-session.ts —— deck_issue_list 的 scope=session（只列本会话碰过的票）那一块规则与取数。
//
// 为什么单列一份：issue-list.ts 已经贴着「单文件 350 有效行」那条线（tests/verify-file-granularity.ts），
// 会话视图这一块是自成一体的纯规则（票键怎么归一、目录什么时候要比）加一支只读取数，
// 拆出来两边都不必为了行数去砍注释。拆的理由与 call-shell.ts 拆出 call-shell-types.ts 同一条。
//
// 口径（改这里就要连票面与 tests/verify-scope-session.ts 一起改）：
//   · 「碰过」只认写类事件：建票、改票（含认领与关票）、建图、挂边；只上报不算 —— 否则筛出来的是
//     「报过的票」，不是「动过的票」。账页自己用 hasWork 记这件事（上报不会抹掉以前的实事），
//     所以判断以账页的 hasWork 为准，旧存档没有这一格时才退回看动作类别。
//   · 票键先按链上的口径归一：账页记 "1"，本地后端列表回 "01"，不归一永远对不上。
//   · 目录（本地后端的 .scratch/<目录>）两边都认得出来时才比：每个目录都有自己的 01 号票，
//     只比编号会把别的目录的票也算进来；有一边不认识（远端后端、老记录、地图薄行）就只比编号。
//   · 纯读：不写账页、不碰任何票文件，读不出来时如实回失败，不拿空名单冒充「一张也没碰过」。
import { chainTicketKey } from '../../refresh/kernel/refresh-chain.js'
import { REFUSAL_REASONS } from '../shell/call-shell.js'

/** 账页交回来的一张「本会话碰过的票」：ticketKey 已按链口径归一，effortId 空串表示单工作单元后端或老记录。 */
export interface SessionTicketHit { ticketKey: string; effortId: string }

/** 会话视图那句说明（两条返回路共用一份，免得以后一边改了口径另一边没改）。 */
export const SESSION_SCOPE_NOTE = '这次只看本会话碰过的票（scope=session）：账页只认建票、改票（含认领）、建图、挂边这几类写事件，只上报与只读取不算；这一步只读账页，没有改动任何票文件。'

/** 票键收口：链上口径认得出就用它，认不出就原样去空白、去井号。 */
function normalizedTicketKey(raw: unknown): string {
  const chained = chainTicketKey(raw)
  if (chained !== '') return chained
  return String(raw === undefined || raw === null ? '' : raw).trim().replace(/^#/, '')
}

/** 这一行票算不算「本会话碰过的那几张之一」（口径见文件头那几条）。 */
export function hitSessionTicket(row: Record<string, unknown>, hits: SessionTicketHit[]): boolean {
  const key = normalizedTicketKey(row.key)
  const effort = String(row.effortId === undefined || row.effortId === null ? '' : row.effortId)
  for (const h of hits) {
    if (normalizedTicketKey(h.ticketKey) !== key) continue
    if (h.effortId && effort && h.effortId !== effort) continue
    return true
  }
  return false
}

/**
 * scope=session 的取数：读本机工作路线账页（只读），拿本会话碰过的票。
 * 三种取不到分清楚说：没有会话号、装配没接上、账页读不出来；都不拿空名单冒充「一张也没碰过」。
 * 失败时回的原因码只从壳里登记过的那几个里挑（tests/verify-1106-deck-surface.ts 冻着这八个数）。
 */
export async function readSessionTickets(
  read: ((arg: { rootKey: string; sessionId: string }) => Promise<unknown>) | undefined,
  sessionId: unknown,
  workspaceKey: unknown,
): Promise<{ ok: true; tickets: SessionTicketHit[] } | { ok: false; reason: string; text: string }> {
  const sid = String(sessionId === undefined || sessionId === null ? '' : sessionId)
  if (!sid) return { ok: false, reason: REFUSAL_REASONS.NO_SESSION, text: '这次没拿到会话号，所以给不出「本会话碰过的票」；不传 scope 或传 scope=all 可以看全部票。' }
  if (typeof read !== 'function') return { ok: false, reason: REFUSAL_REASONS.BACKEND_UNSUPPORTED, text: '这次装配没有接上工作路线账页（workRouteTickets），所以给不出「本会话碰过的票」；不传 scope 或传 scope=all 可以看全部票。' }
  const rootKey = String(workspaceKey === undefined || workspaceKey === null ? '' : workspaceKey)
  let back: unknown = null
  try { back = await read({ rootKey: rootKey, sessionId: sid }) } catch (e) { back = null }
  const rec = (back && typeof back === 'object') ? back as Record<string, unknown> : {}
  if (rec.ok !== true) return { ok: false, reason: REFUSAL_REASONS.BACKEND_UNSUPPORTED, text: '本机的工作路线账页这次读不出来（原因 ' + String(rec.reason || 'unknown') + '），所以给不出「本会话碰过的票」；不传 scope 或传 scope=all 可以看全部票。' }
  const tickets: SessionTicketHit[] = []
  for (const r of (Array.isArray(rec.tickets) ? rec.tickets : [])) {
    if (!r || typeof r !== 'object') continue
    const t = r as Record<string, unknown>
    const key = String(t.ticketKey === undefined || t.ticketKey === null ? '' : t.ticketKey)
    if (key) tickets.push({ ticketKey: key, effortId: typeof t.effortId === 'string' ? t.effortId : '' })
  }
  return { ok: true, tickets: tickets }
}
