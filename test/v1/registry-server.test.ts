import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { registry, root } from '../helpers.js';

describe('node tiers', () => {
  it('registry lists ~10 v1 builtins + agents by default; advanced nodes only on request', () => {
    const reg = registry();
    const v1Builtins = reg.list().filter((d) => d.kind === 'builtin').map((d) => d.name).sort();
    expect(v1Builtins).toEqual(['condition', 'end', 'http_request', 'json_parse', 'log', 'loop', 'start', 'template', 'transform']);
    const adv = reg.list({ advanced: true }).map((d) => d.name);
    for (const a of ['join', 'foreach', 'subflow', 'switch', 'delay', 'file_read']) expect(adv).toContain(a);
    expect(reg.list({ advanced: true }).map((d) => d.name)).not.toContain('loop_in');
    expect(reg.list({ all: true }).map((d) => d.name)).toContain('loop_in');
  });
});

describe('backend in v1 mode (default)', () => {
  const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-v1-'));
  for (const f of fs.readdirSync(path.join(root, 'workflows'))) fs.copyFileSync(path.join(root, 'workflows', f), path.join(wfDir, f));
  const app = buildServer({ root, workflowsDir: wfDir, runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wf-v1-runs-')), mockDelayMs: 0 });
  afterAll(() => app.close());

  it('registry endpoint hides advanced nodes unless ?advanced=1', async () => {
    const names = (await app.inject('/api/registry')).json().definitions.map((d: { name: string }) => d.name);
    expect(names).toContain('condition');
    expect(names).not.toContain('join');
    const all = (await app.inject('/api/registry?advanced=1')).json().definitions.map((d: { name: string }) => d.name);
    expect(all).toContain('join');
  });

  it('list shows version; PUT saves v1 in compact form and rejects legacy without advanced', async () => {
    const list = (await app.inject('/api/workflows')).json();
    expect(list.find((w: { id: string }) => w.id === 'fix-until-tests-pass').version).toBe(1);
    const wf = (await app.inject('/api/workflows/plan-subflow')).json();
    const put = await app.inject({ method: 'PUT', url: '/api/workflows/copy', payload: { ...wf, edges: wf.edges.map((e: string) => { const [f, t] = e.split(' -> '); return { from: f, to: t }; }) } });
    expect(put.statusCode).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(wfDir, 'copy.json'), 'utf8'));
    expect(saved.version).toBe(1);
    expect(typeof saved.edges[0]).toBe('string');
    const legacy = JSON.parse(fs.readFileSync(path.join(root, 'test/advanced/fixtures/plan-subflow.json'), 'utf8'));
    const bad = await app.inject({ method: 'PUT', url: '/api/workflows/legacy', payload: legacy });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].code).toBe('LEGACY_FORMAT');
  });

  it('runs the v1 demo to success; resume is advanced-only (403)', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow_id: 'fix-until-tests-pass', mock_delay_ms: 0 } });
    expect(start.statusCode).toBe(202);
    const id = start.json().run_id;
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await app.inject(`/api/runs/${id}`)).json();
      if (run.meta.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(run.meta.status).toBe('success');
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/resume`, payload: {} })).statusCode).toBe(403);
  });
});
