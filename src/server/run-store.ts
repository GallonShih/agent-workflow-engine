import fs from 'node:fs';
import path from 'node:path';
import type { NodeRunRecord, RunEvent, RunResult, WorkflowGraph } from '../types.js';

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';

export interface RunMeta {
  run_id: string;
  workflow_name: string;
  workflow_id?: string;
  status: RunStatus;
  started_at: number;
  finished_at?: number;
  duration_ms?: number;
  token_usage?: { input_tokens: number; output_tokens: number; cost_usd?: number };
  source: 'cli' | 'server' | 'legacy';
  runtime: string;
  scenario?: string;
  inputs?: Record<string, unknown>;
  resumed_from?: string;
  /** 只有事件、沒有 meta 的舊 run（iteration 1 的 CLI 產物） */
  legacy?: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * .runs/ 目錄下的 run 紀錄：
 *   <id>.meta.json      — 摘要（狀態、時間、token）
 *   <id>.workflow.json  — 當時執行的 workflow（replay / resume 用）
 *   <id>.events.jsonl   — 事件流，執行中逐行 append（server 掛掉時仍可讀到中斷前的狀態）
 *   <id>.records.json   — 結束時的 NodeRunRecord（run_id + scope + node_id）
 */
export class RunStore {
  constructor(public dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  static validId(id: string) {
    return ID_RE.test(id);
  }

  private file(id: string, ext: string) {
    if (!RunStore.validId(id)) throw new Error(`invalid run id "${id}"`);
    return path.join(this.dir, `${id}.${ext}`);
  }

  begin(meta: RunMeta, workflow: WorkflowGraph) {
    fs.writeFileSync(this.file(meta.run_id, 'workflow.json'), JSON.stringify(workflow, null, 2));
    fs.writeFileSync(this.file(meta.run_id, 'meta.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(this.file(meta.run_id, 'events.jsonl'), '');
    const eventsFile = this.file(meta.run_id, 'events.jsonl');
    return {
      append: (e: RunEvent) => fs.appendFileSync(eventsFile, JSON.stringify(e) + '\n'),
      finish: (result: RunResult, status: RunStatus = result.status) => {
        fs.writeFileSync(this.file(meta.run_id, 'records.json'), JSON.stringify(result.records, null, 2));
        const done: RunMeta = { ...meta, status, finished_at: Date.now(), duration_ms: result.duration_ms, token_usage: result.token_usage };
        fs.writeFileSync(this.file(meta.run_id, 'meta.json'), JSON.stringify(done, null, 2));
        return done;
      },
      fail: (message: string) => {
        const done: RunMeta = { ...meta, status: 'failed', finished_at: Date.now(), duration_ms: Date.now() - meta.started_at };
        fs.writeFileSync(this.file(meta.run_id, 'meta.json'), JSON.stringify({ ...done, error: message }, null, 2));
        return done;
      },
    };
  }

  /** 寫完整一次 run（CLI 用） */
  saveCompleted(meta: Omit<RunMeta, 'status' | 'run_id'>, workflow: WorkflowGraph, result: RunResult) {
    const w = this.begin({ ...meta, run_id: result.run_id, status: 'running' }, workflow);
    for (const e of result.events) w.append(e);
    return w.finish(result);
  }

  events(id: string): RunEvent[] {
    const f = this.file(id, 'events.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RunEvent];
        } catch {
          return []; // 中斷時最後一行可能寫一半
        }
      });
  }

  readJson<T>(id: string, ext: string): T | undefined {
    const f = this.file(id, ext);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : undefined;
  }

  exists(id: string) {
    return RunStore.validId(id) && (fs.existsSync(this.file(id, 'meta.json')) || fs.existsSync(this.file(id, 'events.jsonl')));
  }

  /** active = 目前這個 server process 正在跑的 run；其他仍標 running 的視為 interrupted */
  meta(id: string, active: Set<string> = new Set()): RunMeta | undefined {
    const m = this.readJson<RunMeta>(id, 'meta.json');
    if (m) return m.status === 'running' && !active.has(id) ? { ...m, status: 'interrupted' } : m;
    const events = this.events(id);
    if (!events.length) return undefined;
    const start = events.find((e) => e.type === 'run_started');
    const end = events.find((e) => e.type === 'run_completed');
    return {
      run_id: id,
      workflow_name: '(legacy CLI run)',
      status: end ? ((end.data?.status as RunStatus) ?? 'failed') : 'interrupted',
      started_at: start?.ts ?? events[0].ts,
      finished_at: end?.ts,
      duration_ms: end ? (end.data?.duration_ms as number) : undefined,
      source: 'legacy',
      runtime: 'unknown',
      legacy: true,
    };
  }

  list(active: Set<string> = new Set()): RunMeta[] {
    const ids = new Set(
      fs
        .readdirSync(this.dir)
        .map((f) => /^(.+?)\.(meta\.json|events\.jsonl)$/.exec(f)?.[1])
        .filter((x): x is string => !!x && RunStore.validId(x)),
    );
    return [...ids].flatMap((id) => this.meta(id, active) ?? []).sort((a, b) => b.started_at - a.started_at);
  }

  get(id: string, active: Set<string> = new Set()) {
    const meta = this.meta(id, active);
    if (!meta) return undefined;
    return {
      meta,
      workflow: this.readJson<WorkflowGraph>(id, 'workflow.json'),
      records: this.readJson<NodeRunRecord[]>(id, 'records.json'),
      events: this.events(id),
    };
  }
}
