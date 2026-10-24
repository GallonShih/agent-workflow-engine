import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RunEvent, WorkflowGraph } from '../types.js';
import type { NodeRegistry } from '../registry.js';
import { loadRegistry } from '../registry-fs.js';
import { compileWorkflow } from '../compiler.js';
import { runWorkflow } from '../engine.js';
import { makeRuntimeSelector, resolveRuntimeMode } from '../runtime/select.js';
import type { AgentRuntime } from '../runtime/types.js';
import { demoRuntime } from '../demo/scenario.js';
import { createWorkflowLoader, nodeServices } from '../services-node.js';
import type { RunServices } from '../services.js';
import { resumeResultsFromEvents } from '../resume.js';
import { RunStore, type RunMeta } from './run-store.js';

export interface ServerOptions {
  root: string;
  runsDir?: string;
  registry?: NodeRegistry;
  services?: RunServices;
  /** 每個 mock agent 呼叫的延遲（讓 UI 看得到執行中狀態），預設 250ms */
  mockDelayMs?: number;
  /** 'mock'（預設）或 'claude'（需 ANTHROPIC_API_KEY） */
  runtime?: string;
  /** 前端 build（web/dist），存在時由 server 一併提供 */
  staticDir?: string;
  logger?: boolean;
  /** 存放 workflow JSON 的資料夾（預設 <root>/workflows；subflow 也從這裡載入） */
  workflowsDir?: string;
}

interface ActiveRun {
  meta: RunMeta;
  events: RunEvent[];
  listeners: Set<(e: RunEvent) => void>;
  ac: AbortController;
  done: Promise<unknown>;
}

interface StartBody {
  workflow?: WorkflowGraph;
  workflow_id?: string;
  inputs?: Record<string, unknown>;
  /** demo mock agents 的情境：pass（第 N 輪測試通過）或 fail（永遠不通過） */
  scenario?: 'pass' | 'fail';
  pass_on?: number;
  mock_delay_ms?: number;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };

export function buildServer(opts: ServerOptions): FastifyInstance & { runs: Map<string, ActiveRun> } {
  const root = opts.root;
  const registry = opts.registry ?? loadRegistry(path.join(root, 'registry/builtin'), path.join(root, 'registry/agents'));
  const workflowsDir = opts.workflowsDir ?? path.join(root, 'workflows');
  const services = opts.services ?? { ...nodeServices({ root, registry }), loadWorkflow: createWorkflowLoader(workflowsDir) };
  const store = new RunStore(opts.runsDir ?? path.join(root, '.runs'));
  const runs = new Map<string, ActiveRun>();
  const activeIds = () => new Set([...runs.values()].filter((r) => r.meta.status === 'running').map((r) => r.meta.run_id));
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 }) as unknown as FastifyInstance & { runs: Map<string, ActiveRun> };
  app.runs = runs;

  const readWorkflow = (id: string): WorkflowGraph | undefined => {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) return undefined;
    const f = path.join(workflowsDir, `${id.replace(/\.json$/, '')}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
  };

  function startRun(wf: WorkflowGraph, body: StartBody, extra: { workflow_id?: string; resume?: { fromRunId: string; events: RunEvent[] } } = {}) {
    const compiled = compileWorkflow(wf, registry);
    if (!compiled.ok) return { error: { errors: compiled.errors, warnings: compiled.warnings } };
    const scenario = body.scenario ?? 'pass';
    const mock: AgentRuntime = demoRuntime({
      passOnIteration: scenario === 'fail' ? null : (body.pass_on ?? 2),
      flakyCoder: true,
      delayMs: body.mock_delay_ms ?? opts.mockDelayMs ?? 250,
    });
    const rt = resolveRuntimeMode(opts.runtime);
    const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const inputs = body.inputs ?? { request: '修正 parser 空字串 bug 並讓測試通過', repository: 'github.com/acme/parser' };
    const meta: RunMeta = {
      run_id: runId,
      workflow_name: wf.name ?? extra.workflow_id ?? '(unsaved)',
      workflow_id: extra.workflow_id,
      status: 'running',
      started_at: Date.now(),
      source: 'server',
      runtime: rt.mode,
      scenario,
      inputs,
      resumed_from: extra.resume?.fromRunId,
    };
    const writer = store.begin(meta, wf);
    const active: ActiveRun = { meta, events: [], listeners: new Set(), ac: new AbortController(), done: Promise.resolve() };
    runs.set(runId, active);
    const onEvent = (e: RunEvent) => {
      active.events.push(e);
      writer.append(e);
      for (const l of active.listeners) l(e);
    };
    active.done = runWorkflow(compiled.graph!, inputs, {
      runId,
      runtime: mock,
      selectRuntime: makeRuntimeSelector(mock, { runtime: opts.runtime }),
      onEvent,
      services,
      signal: active.ac.signal,
      resume: extra.resume ? { fromRunId: extra.resume.fromRunId, results: resumeResultsFromEvents(extra.resume.events) } : undefined,
    })
      .then((result) => {
        active.meta = writer.finish(result, active.ac.signal.aborted ? 'cancelled' : result.status);
      })
      .catch((e: Error) => {
        active.meta = writer.fail(e.message);
        onEvent({ seq: active.events.length + 1, ts: Date.now(), run_id: runId, type: 'run_completed', data: { status: 'failed', error: e.message } });
      })
      .finally(() => {
        for (const l of active.listeners) l({ seq: -1, ts: Date.now(), run_id: runId, type: 'run_completed', data: { closed: true } } as RunEvent);
        active.listeners.clear();
      });
    return { run_id: runId, warnings: compiled.warnings };
  }

  // ---------------------------------------------------------------- API
  app.get('/api/health', async () => ({ ok: true, runtime: resolveRuntimeMode(opts.runtime), registry: registry.list().length }));

  app.get('/api/registry', async () => ({ definitions: registry.list() }));

  app.get('/api/workflows', async () =>
    fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        const wf = JSON.parse(fs.readFileSync(path.join(workflowsDir, f), 'utf8')) as WorkflowGraph;
        return { id: f.replace(/\.json$/, ''), name: wf.name, nodes: wf.nodes?.length ?? 0 };
      }),
  );

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const wf = readWorkflow(req.params.id);
    return wf ?? reply.code(404).send({ error: 'workflow not found' });
  });

  /**
   * 存回 workflows/<id>.json（例如從 subflow drill-in 按「開啟來源 workflow 編輯」後存檔）。
   * 有驗證錯誤就拒絕（422）：這份 workflow 可能被其他 workflow 以 subflow 引用，不能存成跑不動的版本。
   */
  app.put<{ Params: { id: string }; Body: WorkflowGraph }>('/api/workflows/:id', async (req, reply) => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return reply.code(400).send({ error: 'invalid workflow id' });
    const wf = req.body;
    if (!wf || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) return reply.code(400).send({ error: 'body must be a workflow { nodes, edges }' });
    const r = compileWorkflow(wf, registry);
    if (!r.ok) return reply.code(422).send({ error: 'workflow has validation errors', errors: r.errors, warnings: r.warnings });
    fs.writeFileSync(path.join(workflowsDir, `${id}.json`), JSON.stringify({ ...wf, id }, null, 2) + '\n');
    return { ok: true, id, warnings: r.warnings };
  });

  app.post<{ Body: { workflow?: WorkflowGraph } }>('/api/validate', async (req, reply) => {
    if (!req.body?.workflow) return reply.code(400).send({ error: 'body.workflow is required' });
    const r = compileWorkflow(req.body.workflow, registry);
    return { ok: r.ok, errors: r.errors, warnings: r.warnings };
  });

  app.post<{ Body: StartBody }>('/api/runs', async (req, reply) => {
    const body = req.body ?? {};
    const wf = body.workflow ?? (body.workflow_id ? readWorkflow(body.workflow_id) : undefined);
    if (!wf) return reply.code(400).send({ error: 'workflow or a valid workflow_id is required' });
    const r = startRun(wf, body, { workflow_id: body.workflow_id });
    if ('error' in r) return reply.code(422).send({ error: 'workflow does not compile', ...r.error });
    return reply.code(202).send(r);
  });

  app.get('/api/runs', async () => store.list(activeIds()));

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    if (!RunStore.validId(req.params.id)) return reply.code(400).send({ error: 'invalid run id' });
    const r = store.get(req.params.id, activeIds());
    if (!r) return reply.code(404).send({ error: 'run not found' });
    const active = runs.get(req.params.id);
    return active && active.meta.status === 'running' ? { ...r, meta: active.meta, events: active.events } : r;
  });

  /** SSE：先重播已發生的事件（?after=seq 可略過），執行中的 run 接著即時推送，run_completed 後關閉 */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/runs/:id/events', async (req, reply) => {
    const id = req.params.id;
    if (!RunStore.validId(id) || (!runs.has(id) && !store.exists(id))) return reply.code(404).send({ error: 'run not found' });
    const after = Number(req.query.after ?? req.headers['last-event-id'] ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (e: RunEvent) => {
      if (e.seq > 0) res.write(`id: ${e.seq}\nevent: run\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const end = () => {
      res.write(`event: end\ndata: {}\n\n`);
      res.end();
    };
    const active = runs.get(id);
    if (active && active.meta.status === 'running') {
      let last = after;
      for (const e of active.events) if (e.seq > last) (send(e), (last = e.seq));
      const listener = (e: RunEvent) => {
        if (e.seq > last) (send(e), (last = e.seq));
        if (e.type === 'run_completed') {
          active.listeners.delete(listener);
          end();
        }
      };
      active.listeners.add(listener);
      req.raw.on('close', () => active.listeners.delete(listener));
      return;
    }
    for (const e of store.events(id)) if (e.seq > after) send(e);
    end();
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) => {
    const active = runs.get(req.params.id);
    if (!active || active.meta.status !== 'running') return reply.code(409).send({ error: 'run is not running in this server' });
    active.ac.abort();
    await active.done;
    return { ok: true, status: active.meta.status };
  });

  /** Resume：用原 run 的 workflow，沿用已成功的 agent 節點輸出，其餘重新執行，產生新的 run_id */
  app.post<{ Params: { id: string }; Body: StartBody }>('/api/runs/:id/resume', async (req, reply) => {
    const id = req.params.id;
    if (!RunStore.validId(id)) return reply.code(400).send({ error: 'invalid run id' });
    if (runs.get(id)?.meta.status === 'running') return reply.code(409).send({ error: 'run is still running' });
    const prev = store.get(id);
    if (!prev?.workflow) return reply.code(404).send({ error: 'run (or its saved workflow) not found' });
    const r = startRun(prev.workflow, { scenario: prev.meta.scenario as 'pass' | 'fail', inputs: prev.meta.inputs, ...(req.body ?? {}) }, { workflow_id: prev.meta.workflow_id, resume: { fromRunId: id, events: prev.events } });
    if ('error' in r) return reply.code(422).send({ error: 'workflow does not compile', ...r.error });
    return reply.code(202).send({ ...r, resumed_from: id });
  });

  // ------------------------------------------------------- static web/dist
  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    const base = path.resolve(opts.staticDir);
    app.get('/*', async (req, reply) => {
      const url = decodeURIComponent((req.url.split('?')[0] || '/').replace(/^\/+/, ''));
      let f = path.resolve(base, url || 'index.html');
      if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(base, 'index.html');
      return reply.type(MIME[path.extname(f)] ?? 'application/octet-stream').send(fs.readFileSync(f));
    });
  }

  return app;
}
