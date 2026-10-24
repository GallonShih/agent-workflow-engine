import type { Diagnostic } from '../../src/compiler.js';
import type { NodeRunRecord, RunEvent, WorkflowGraph } from '../../src/types.js';
import type { WorkspaceReport, WorkspacePermission } from '../../src/workspace-policy.js';

/** backend（Fastify, npm run server）的 client；dev 時經 Vite proxy 走同源 /api */
export interface RunMeta {
  run_id: string;
  workflow_name: string;
  workflow_id?: string;
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  started_at: number;
  finished_at?: number;
  duration_ms?: number;
  token_usage?: { input_tokens: number; output_tokens: number };
  source: string;
  runtime: string;
  scenario?: string;
  resumed_from?: string;
  legacy?: boolean;
  /** workspace 路徑、git branch / HEAD、結束後的變更檔案 */
  workspace?: WorkspaceReport;
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 400 workspace 錯誤帶 fix；422 編譯錯誤帶 errors[].fix
    const b = body as { error?: string; fix?: string; errors?: { code: string; message: string; fix?: string }[] };
    const first = b.errors?.[0];
    const msg = [b.error ?? `HTTP ${res.status}`, first ? `${first.code}: ${first.message}` : '', b.fix ?? first?.fix ? `修正：${b.fix ?? first?.fix}` : ''].filter(Boolean).join(' — ');
    throw Object.assign(new Error(msg), { body });
  }
  return body as T;
}

export const backend = {
  async health(): Promise<{ ok: boolean; runtime: { mode: string; reason: string }; workspace_roots?: string[] } | null> {
    try {
      const r = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
      return r.ok ? r.json() : null;
    } catch {
      return null;
    }
  },
  validate: (workflow: WorkflowGraph, advanced = false) =>
    fetch('/api/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow, advanced }) }).then((r) => j<{ ok: boolean; errors: Diagnostic[]; warnings: Diagnostic[]; workspace_required?: WorkspacePermission }>(r)),
  startRun: (body: { workflow: WorkflowGraph | Record<string, unknown>; scenario?: string; mock_delay_ms?: number; inputs?: Record<string, unknown>; advanced?: boolean; workspace?: string; mock_writes?: boolean }) =>
    fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<{ run_id: string }>(r)),
  listRuns: () => fetch('/api/runs').then((r) => j<RunMeta[]>(r)),
  getRun: (id: string) => fetch(`/api/runs/${id}`).then((r) => j<{ meta: RunMeta; workflow?: WorkflowGraph; records?: NodeRunRecord[]; events: RunEvent[] }>(r)),
  cancel: (id: string) => fetch(`/api/runs/${id}/cancel`, { method: 'POST' }).then((r) => j<{ ok: boolean }>(r)),
  /** 進階功能 */
  resume: (id: string, body: Record<string, unknown> = {}) =>
    fetch(`/api/runs/${id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<{ run_id: string }>(r)),
  /** SSE：回傳關閉函式 */
  stream(id: string, onEvent: (e: RunEvent) => void, onEnd: () => void): () => void {
    const es = new EventSource(`/api/runs/${id}/events`);
    es.addEventListener('run', (m) => onEvent(JSON.parse((m as MessageEvent).data)));
    es.addEventListener('end', () => (es.close(), onEnd()));
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) onEnd();
    };
    return () => es.close();
  },
};
