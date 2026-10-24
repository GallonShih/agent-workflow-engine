import type { AgentEvent, NodeStatus, RunEvent, Scope, TokenUsage } from '../../src/types.js';

/** 前端的執行狀態：把事件流（in-browser 或 backend SSE / 歷史紀錄）歸約成以 scope/node_id 為鍵的紀錄 */
export interface RecView {
  key: string; // scopeKey/node_id，例如 fix_loop#1/coder
  node_id: string;
  scope: Scope;
  scopeKey: string;
  iteration: number | null;
  status: NodeStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  reason?: string;
  fired?: string[];
  started_at?: number;
  duration_ms?: number;
  token_usage?: TokenUsage;
  attempts?: number;
  runtime?: string;
  resumed_from?: string;
  handled?: boolean;
  agentEvents: AgentEvent[];
  logs: { level: string; message: string; ts: number }[];
  retries: { attempt: number; error: string }[];
}

export interface RunView {
  run_id?: string;
  status: 'idle' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  records: Map<string, RecView>;
  /** composite node id → 已開始的 iteration 編號 */
  iterations: Record<string, number[]>;
  started_at?: number;
  ended_at?: number;
  token_usage: TokenUsage;
  eventCount: number;
  lastSeq: number;
}

export const emptyRun = (): RunView => ({ status: 'idle', records: new Map(), iterations: {}, token_usage: { input_tokens: 0, output_tokens: 0 }, eventCount: 0, lastSeq: 0 });

export const scopeKeyOf = (scope: Scope = []) => (scope.length ? scope.map((s) => `${s.loop}#${s.iteration}`).join('/') : 'root');

export function applyEvent(run: RunView, e: RunEvent): RunView {
  run.eventCount++;
  run.lastSeq = Math.max(run.lastSeq, e.seq);
  run.run_id = e.run_id;
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (e.type === 'run_started') {
    run.status = 'running';
    run.started_at = e.ts;
    return run;
  }
  if (e.type === 'run_completed') {
    if (d.closed) return run;
    run.status = (d.status as RunView['status']) ?? 'failed';
    run.ended_at = e.ts;
    return run;
  }
  if (!e.node_id) return run;
  if (e.type === 'loop_iteration_started' || e.type === 'loop_iteration_completed') {
    const it = d.iteration as number;
    const list = (run.iterations[e.node_id] ??= []);
    if (!list.includes(it)) list.push(it);
    return run;
  }
  const scope = e.scope ?? [];
  const sk = scopeKeyOf(scope);
  const key = `${sk}/${e.node_id}`;
  let r = run.records.get(key);
  if (!r) {
    r = { key, node_id: e.node_id, scope, scopeKey: sk, iteration: scope.length ? scope[scope.length - 1].iteration : null, status: 'pending', agentEvents: [], logs: [], retries: [] };
    run.records.set(key, r);
  }
  switch (e.type) {
    case 'node_triggered':
      r.status = 'pending';
      break;
    case 'node_started':
      r.status = 'running';
      r.started_at = e.ts;
      r.inputs = d.inputs as Record<string, unknown>;
      break;
    case 'node_succeeded':
      r.status = 'success';
      if (d.inputs) r.inputs = d.inputs as Record<string, unknown>;
      r.outputs = d.outputs as Record<string, unknown>;
      r.fired = d.fired as string[];
      r.duration_ms = d.duration_ms as number;
      r.token_usage = d.token_usage as TokenUsage | undefined;
      r.attempts = d.attempts as number | undefined;
      r.runtime = d.runtime as string | undefined;
      r.resumed_from = d.resumed_from as string | undefined;
      if (r.token_usage) {
        run.token_usage.input_tokens += r.token_usage.input_tokens;
        run.token_usage.output_tokens += r.token_usage.output_tokens;
      }
      break;
    case 'node_failed':
      r.status = 'failed';
      r.error = d.error as string;
      r.handled = d.handled as boolean;
      r.duration_ms = d.duration_ms as number | undefined;
      if (d.outputs) r.outputs = d.outputs as Record<string, unknown>;
      r.attempts = d.attempts as number | undefined;
      r.token_usage = d.token_usage as TokenUsage | undefined;
      r.runtime = d.runtime as string | undefined;
      break;
    case 'node_skipped':
      r.status = 'skipped';
      r.reason = d.reason as string;
      break;
    case 'node_retry':
      r.retries.push({ attempt: d.attempt as number, error: d.error as string });
      break;
    case 'agent_event':
      r.agentEvents.push(d as unknown as AgentEvent);
      break;
    case 'log':
      r.logs.push({ level: d.level as string, message: d.message as string, ts: e.ts });
      break;
  }
  return run;
}

export function reduceEvents(events: RunEvent[]): RunView {
  const run = emptyRun();
  for (const e of events) applyEvent(run, e);
  return run;
}

/** 目前畫面（外層或某 composite 的某一輪）要顯示的節點狀態 */
export function statusesFor(run: RunView, view: string, iteration: number | null): Record<string, NodeStatus> {
  const sk = view ? `${view}#${iteration ?? 0}` : 'root';
  const out: Record<string, NodeStatus> = {};
  for (const r of run.records.values()) if (r.scopeKey === sk) out[r.node_id] = r.status;
  return out;
}

/** 某節點在所有 scope 的紀錄（per-iteration 歷史） */
export function recordsForNode(run: RunView, view: string, nodeId: string): RecView[] {
  return [...run.records.values()]
    .filter((r) => r.node_id === nodeId && (view ? r.scope.length >= 1 && r.scope[r.scope.length - 1].loop === view && r.scope.length === 1 : r.scopeKey === 'root'))
    .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
}
