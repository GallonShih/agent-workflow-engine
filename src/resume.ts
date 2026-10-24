import type { RunEvent } from './types.js';
import { scopeKey } from './engine.js';

/**
 * 從先前 run 的事件建出 resume 對照表：所有「成功的 agent 節點」以 scopeKey/node_id 為 key。
 * builtin 節點不快取（便宜、可重算，也避免沿用過期的 HTTP / 檔案結果）。
 */
export function resumeResultsFromEvents(events: RunEvent[]) {
  const results = new Map<string, { outputs: Record<string, unknown>; fired: string[] }>();
  for (const e of events) {
    if (e.type !== 'node_succeeded' || !e.node_id || e.data?.node_kind !== 'agent') continue;
    results.set(`${scopeKey(e.scope ?? [])}/${e.node_id}`, {
      outputs: (e.data.outputs as Record<string, unknown>) ?? {},
      fired: (e.data.fired as string[]) ?? ['success'],
    });
  }
  return results;
}
