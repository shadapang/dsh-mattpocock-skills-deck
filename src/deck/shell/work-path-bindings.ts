// work-path-bindings.ts —— 工作路线四支依赖的装配工厂（#1261 建；#1083 补落盘加固要的零件；#1086 补释放）；
// 第四节是只读的「本会话碰过哪些票」，给 deck_issue_list 的 scope=session 用（读的是同一份存档、同一把工作区键）。
//
// 为什么单列一份：宿主接线（wiring.ts）有效行已到 328，离 350 上限只剩 22 行，
// 存储创建 + 读出口拼装 + 几支容错包边展开要三十多行，直接写过去会顶超标。
// 本文件只做一件事：把存储（work-path-store.ts）与读出口（work-path-readout.ts）
// 合成工具壳要的那几支（workRouteNote / workRouteRead / workRouteRelease，外加只读的 tickets），
// 输入输出形状见 call-shell-types.ts 里那几处注释。文件读写、改名、日志与家目录仍由调用方注入，
// 本文件不直接碰 Node（生产由宿主接线给真实现，门禁给临时目录 + 固定时钟）。
//
// #1083 起多两个零件：rename（写临时文件再改名覆盖、换后端改旧文件留档）与
// log（workRoute.write / workRoute.read 两个事件的出口）。两者缺省时不报错：
// 没有 rename 就退化成直接写正式文件，没有 log 就一条不记。
// 读出口要读盘（存储不再有内存真源），所以 read 本身是异步的。

import { createWorkPathStore } from './work-path-store.js';
import {
  buildWorkPathCollisionNote,
  buildWorkPathReadout,
  buildWorkPathSummary,
  projectWorkPathReadout,
  workPathDetailOf,
} from './work-path-readout.js';

export interface WorkRouteBindingIo {
  homeDir?: string;
  now?: () => number;
  readFile?: (path: string) => Promise<string | null> | string | null;
  writeFile?: (path: string, text: string) => Promise<void> | void;
  mkdir?: (dir: string) => Promise<void> | void;
  /** 改名覆盖：临时文件 → 正式文件；换后端时旧文件 → 留档名。 */
  rename?: (from: string, to: string) => Promise<void> | void;
  /** 宿主日志出口（workRoute.write / workRoute.read 两个事件从这里出去）。 */
  log?: { fire?: (level: string, event: string, fields: Record<string, unknown>) => void };
}

/**
 * 账页上这一条算不算「这个会话碰过这张票」。
 *
 * 只认写类事件：建票（create）、改票含认领与关票（edit）、建图（plan）、挂边（link）；
 * 只上报（report）不算 —— 否则筛出来的是「报过的票」，不是「动过的票」。
 * 账页自己用 hasWork 记这件事（见 work-path-ledger.ts 的 hasWorkAfter：上报不会抹掉以前的实事），
 * 所以以它为准；旧存档没有这一格时退回看动作类别（不是 report 就算碰过），与释放那边同一套保守口径。
 */
function touchedBySession(entry: any): boolean {
  if (entry.hasWork === true) return true;
  if (entry.hasWork === false) return false;
  return String(entry.action || '') !== 'report';
}

/** 合成壳要的那几支：note 与 release 原样交存储（存储自己永不抛，这里不再包第二层）；read 读盘快照 + 读出口 + 摘要；tickets 只读账页挑本会话碰过的票。 */
export function createWorkRouteBindings(io?: WorkRouteBindingIo) {
  const store = createWorkPathStore(io || {});
  return {
    note: function (input: any): Promise<unknown> {
      try {
        return store.note(input || {}) as Promise<unknown>;
      } catch {
        return Promise.resolve({ ok: false, reason: 'threw' });
      }
    },
    release: function (input: any): Promise<unknown> {
      try {
        return store.release(input || {}) as Promise<unknown>;
      } catch {
        return Promise.resolve({ ok: false, reason: 'threw' });
      }
    },
    read: async function (input: any): Promise<unknown> {
      try {
        const sid = input ? String(input.sessionId || '') : '';
        const rkey = input ? String(input.rootKey || '') : '';
        const at = input && typeof input.at === 'number' ? input.at : Date.now();
        const info: any = await (store as any).readSnapshotInfo({ rootKey: rkey, sessionId: sid });
        // 读不出来（读盘失败或盘上文件形状不认识）要如实回 ok:false：给空表会让人以为「这个工作区
        // 没在办票」，而其实是这次没读成。文件不存在仍是正常情况，回空表。
        if (info && info.failed === true) return { ok: false, reason: 'read-failed' };
        // 直接读出口（面板、诊断、门禁）默认给全量细节（standard）；只有工具回执那一支显式传 core 省上下文。
        const detail = workPathDetailOf(input ? input.detail : undefined, 'standard');
        const readout = buildWorkPathReadout(info ? info.ledger : null, { sessionId: sid, at: at });
        // 摘要与撞车提醒都从投影后的表算：撞车提醒只取投影前的 collisions（core 档不搬整表，但撞车这句仍要能出来）。
        const view = projectWorkPathReadout(readout, detail);
        return { ok: true, readout: view, summary: buildWorkPathSummary(view), collisionNote: buildWorkPathCollisionNote(readout) };
      } catch {
        return { ok: false, reason: 'read-failed' };
      }
    },
    /**
     * 本会话碰过哪些票（deck_issue_list 的 scope=session 用）：只读盘上那一份账，不记一笔、不改账页、不碰任何票文件。
     *
     * 输出 { ok: true, tickets: [{ ticketKey, effortId }] } 或 { ok: false, reason }。
     * 「碰过」的口径见上面 touchedBySession：建票、改票（含认领与关票）、建图、挂边算，只上报不算；list/get 从来不进账。
     * 读不出来时如实回失败，不拿空名单冒充「本会话一张也没碰过」。
     */
    tickets: async function (input: any): Promise<unknown> {
      try {
        const sid = input ? String(input.sessionId || '') : '';
        const rkey = input ? String(input.rootKey || '') : '';
        if (sid === '') return { ok: false, reason: 'no-session' };
        const info: any = await (store as any).readSnapshotInfo({ rootKey: rkey, sessionId: sid });
        if (info && info.failed === true) return { ok: false, reason: 'read-failed' };
        const ledger: any = info ? info.ledger : null;
        const tickets: Array<{ ticketKey: string; effortId: string }> = [];
        for (const w of (ledger && Array.isArray(ledger.workers)) ? ledger.workers : []) {
          if (!w || w.session !== sid) continue;
          for (const e of (Array.isArray(w.entries) ? w.entries : [])) {
            if (!e || typeof e.ticketKey !== 'string' || e.ticketKey === '') continue;
            if (!touchedBySession(e)) continue;
            tickets.push({ ticketKey: e.ticketKey, effortId: typeof e.effortId === 'string' ? e.effortId : '' });
          }
        }
        return { ok: true, tickets: tickets };
      } catch {
        return { ok: false, reason: 'threw' };
      }
    },
  };
}
