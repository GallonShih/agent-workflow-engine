import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server/app.js';
import type { NodeRunRecord, RunEvent } from '../src/types.js';
import { root } from './helpers.js';

const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runs-'));
const app = buildServer({ root, runsDir, mockDelayMs: 0 });
let base = '';

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => app.close());

const startRun = async (payload: Record<string, unknown>) => {
  const r = await app.inject({ method: 'POST', url: '/api/runs', payload });
  expect(r.statusCode).toBe(202);
  return r.json().run_id as string;
};

async function readSse(url: string): Promise<RunEvent[]> {
  const res = await fetch(url);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await res.text(); // stream closes after run_completed
  return text
    .split('\n\n')
    .filter((b) => b.includes('event: run'))
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
}

describe('backend API (Fastify)', () => {
  it('GET /api/health, /api/registry and /api/workflows', async () => {
    expect((await app.inject('/api/health')).json()).toMatchObject({ ok: true, runtime: { mode: 'mock' } });
    const reg = (await app.inject('/api/registry')).json();
    const names = reg.definitions.map((d: { name: string }) => d.name);
    for (const t of ['condition', 'switch', 'loop', 'merge', 'transform', 'http_request', 'json_parse', 'schema_validate', 'foreach', 'subflow', 'coding_agent']) expect(names).toContain(t);
    expect(reg.definitions.find((d: { name: string }) => d.name === 'http_request').config_schema.properties.method.enum).toContain('POST');
    const wfs = (await app.inject('/api/workflows')).json();
    expect(wfs.map((w: { id: string }) => w.id)).toContain('fix-until-tests-pass');
    expect((await app.inject('/api/workflows/fix-until-tests-pass')).json().nodes.length).toBe(10);
    expect((await app.inject('/api/workflows/..%2Fpackage')).statusCode).toBe(404);
  });

  it('POST /api/validate returns diagnostics', async () => {
    const wf = JSON.parse(fs.readFileSync(path.join(root, 'workflows/invalid-example.json'), 'utf8'));
    const r = (await app.inject({ method: 'POST', url: '/api/validate', payload: { workflow: wf } })).json();
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(5);
    expect((await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow: wf } })).statusCode).toBe(422);
  });

  it('POST /api/runs → background run persisted to .runs (meta, workflow, events.jsonl, records)', async () => {
    const id = await startRun({ workflow_id: 'fix-until-tests-pass', scenario: 'pass', pass_on: 1 });
    await app.runs.get(id)!.done;
    const r = (await app.inject(`/api/runs/${id}`)).json();
    expect(r.meta).toMatchObject({ run_id: id, status: 'success', source: 'server', runtime: 'mock', workflow_id: 'fix-until-tests-pass' });
    expect(r.records.find((x: NodeRunRecord) => x.key === `${id}/fix_loop#1/tester`).outputs.passed).toBe(true);
    expect(r.events.at(-1).type).toBe('run_completed');
    for (const ext of ['meta.json', 'workflow.json', 'events.jsonl', 'records.json']) expect(fs.existsSync(path.join(runsDir, `${id}.${ext}`))).toBe(true);
    const list = (await app.inject('/api/runs')).json();
    expect(list[0].run_id).toBe(id);
    expect((await app.inject('/api/runs/nope')).statusCode).toBe(404);
  });

  it('GET /api/runs/:id/events streams live events over SSE, then replays finished runs', async () => {
    const id = await startRun({ workflow_id: 'fix-until-tests-pass', scenario: 'fail', mock_delay_ms: 15 });
    const live = await readSse(`${base}/api/runs/${id}/events`);
    expect(live[0].type).toBe('run_started');
    expect(live.at(-1)).toMatchObject({ type: 'run_completed', data: { status: 'failed' } });
    expect(live.map((e) => e.seq)).toEqual([...live.keys()].map((i) => i + 1)); // no gaps / duplicates
    expect(live.some((e) => e.type === 'loop_iteration_started' && e.scope?.[0]?.iteration === 2)).toBe(true);
    const replay = await readSse(`${base}/api/runs/${id}/events`);
    expect(replay.length).toBe(live.length);
    const tail = await readSse(`${base}/api/runs/${id}/events?after=${live.length - 3}`);
    expect(tail.length).toBe(3);
  });

  it('cancel + resume: successful agent nodes are reused, the rest re-run under a new run_id', async () => {
    const id = await startRun({ workflow_id: 'fix-until-tests-pass', scenario: 'pass', pass_on: 1, mock_delay_ms: 40 });
    const active = app.runs.get(id)!;
    await new Promise<void>((resolve) => {
      const l = (e: RunEvent) => {
        if (e.type === 'node_succeeded' && e.node_id === 'coder') (active.listeners.delete(l), resolve());
      };
      active.listeners.add(l);
    });
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/cancel` })).json()).toMatchObject({ status: 'cancelled' });
    const before = (await app.inject(`/api/runs/${id}`)).json();
    expect(before.meta.status).toBe('cancelled');

    const r = await app.inject({ method: 'POST', url: `/api/runs/${id}/resume`, payload: { mock_delay_ms: 0 } });
    expect(r.statusCode).toBe(202);
    const id2 = r.json().run_id;
    await app.runs.get(id2)!.done;
    const after = (await app.inject(`/api/runs/${id2}`)).json();
    expect(after.meta).toMatchObject({ status: 'success', resumed_from: id });
    const rec = (k: string) => after.records.find((x: NodeRunRecord) => x.key === `${id2}/${k}`);
    expect(rec('root/planner')).toMatchObject({ status: 'success', runtime: 'resumed', resumed_from: id });
    expect(rec('fix_loop#0/coder')).toMatchObject({ runtime: 'resumed' });
    expect(rec('fix_loop#1/coder')).toMatchObject({ status: 'success', runtime: 'mock' });
  });

  it('runs left "running" by a dead server are listed as interrupted; legacy CLI runs (events only) are listed', async () => {
    fs.writeFileSync(path.join(runsDir, 'run_ghost.meta.json'), JSON.stringify({ run_id: 'run_ghost', workflow_name: 'x', status: 'running', started_at: 1, source: 'server', runtime: 'mock' }));
    fs.writeFileSync(path.join(runsDir, 'run_old.events.jsonl'), JSON.stringify({ seq: 1, ts: 2, run_id: 'run_old', type: 'run_started' }) + '\n');
    const list = (await app.inject('/api/runs')).json() as { run_id: string; status: string; legacy?: boolean }[];
    expect(list.find((r) => r.run_id === 'run_ghost')?.status).toBe('interrupted');
    expect(list.find((r) => r.run_id === 'run_old')).toMatchObject({ status: 'interrupted', legacy: true });
  });
});

describe('nested-review demo + workflow save (backend)', () => {
  const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dir-'));
  for (const f of fs.readdirSync(path.join(root, 'workflows'))) fs.copyFileSync(path.join(root, 'workflows', f), path.join(wfDir, f));
  const app2 = buildServer({ root, runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runs2-')), mockDelayMs: 0, workflowsDir: wfDir });
  afterAll(() => app2.close());

  it('runs subflow + nested loops; run record keeps the subflow snapshot and outer#i/inner#j records', async () => {
    const wf = (await app2.inject('/api/workflows/nested-review')).json();
    const r = await app2.inject({ method: 'POST', url: '/api/runs', payload: { workflow: wf, workflow_id: 'nested-review', inputs: { request: 'x', repository: 'y' } } });
    expect(r.statusCode).toBe(202);
    const id = r.json().run_id as string;
    await app2.runs.get(id)!.done;
    const run = (await app2.inject(`/api/runs/${id}`)).json();
    expect(run.meta.status).toBe('success');
    const keys = run.records.map((x: NodeRunRecord) => x.key.slice(id.length + 1));
    expect(keys).toEqual(expect.arrayContaining(['plan#0/planner', 'review_rounds#0/fix_loop#2/tester', 'review_rounds#1/fix_loop#0/coder', 'review_rounds#1/note']));
    const snap = run.events.find((e: RunEvent) => e.type === 'subflow_started');
    expect(snap.data.workflow_id).toBe('plan-subflow');
    expect(snap.data.workflow.nodes.map((n: { id: string }) => n.id)).toEqual(['start', 'planner', 'end']);
  });

  it('PUT /api/workflows/:id saves valid workflows and rejects invalid ones (422)', async () => {
    const wf = (await app2.inject('/api/workflows/plan-subflow')).json();
    wf.name = '改過的子流程';
    const ok = await app2.inject({ method: 'PUT', url: '/api/workflows/plan-subflow', payload: wf });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(wfDir, 'plan-subflow.json'), 'utf8')).name).toBe('改過的子流程');
    wf.edges.push({ kind: 'data', from: { node: 'start', port: 'nope' }, to: { node: 'end', port: 'plan' } });
    const bad = await app2.inject({ method: 'PUT', url: '/api/workflows/plan-subflow', payload: wf });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.length).toBeGreaterThan(0);
    expect((await app2.inject({ method: 'PUT', url: '/api/workflows/..%2Fx', payload: wf })).statusCode).toBe(400);
  });
});
