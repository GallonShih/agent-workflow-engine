import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkflow } from './adv.js';
import { runWorkflow } from './adv.js';
import { boundaryAnnotations, bodyPortsAt, getGraphAt, setGraphAt } from '../../src/graph-path.js';
import { MockAgentRuntime } from '../../src/runtime/mock.js';
import { createWorkflowLoader } from '../../src/services-node.js';
import type { RunEvent, WorkflowGraph, WorkflowNode } from '../../src/types.js';
import { ctl, data, n, registry, wf } from '../helpers.js';

const reg = registry();
const int = { type: 'integer' };

/** inner：acc 從外層 iteration 開始，每輪 +1，跑 3 輪 */
const inner = (): WorkflowNode =>
  n('inner', 'loop', {
    config: { max_iterations: 3, carry: [{ from: 'acc', to: 'acc' }] },
    ports: { inputs: { acc: { schema: int } }, outputs: { acc: { schema: int } } } as never,
    body: wf(
      [n('loop_in', 'loop_in'), n('inc', 'transform', { config: { expression: '$input + 1' }, ports: { outputs: { result: { schema: int } } } as never }), n('loop_out', 'loop_out')],
      [ctl('loop_in.success', 'inc'), ctl('inc.success', 'loop_out'), data('loop_in.acc', 'inc.input'), data('inc.result', 'loop_out.acc')],
    ),
  });

const nested = (): WorkflowGraph =>
  wf(
    [
      n('start', 'start', { ports: { outputs: {} } }),
      n('outer', 'loop', {
        config: { max_iterations: 2 },
        ports: { inputs: {}, outputs: { total: { schema: int } } } as never,
        body: wf([n('loop_in', 'loop_in'), inner(), n('loop_out', 'loop_out')], [ctl('loop_in.success', 'inner'), ctl('inner.completed', 'loop_out'), data('loop_in.iteration', 'inner.acc'), data('inner.acc', 'loop_out.total')]),
      }),
      n('end', 'end', { ports: { inputs: { total: { schema: int } } } as never, config: { status: 'success' } }),
    ],
    [ctl('start.success', 'outer'), ctl('outer.completed', 'end'), data('outer.total', 'end.total')],
  );

describe('nested loops (loop inside loop)', () => {
  it('compiles and reports errors with the nested path', () => {
    expect(compileWorkflow(nested(), reg).errors).toEqual([]);
    const bad = nested();
    getGraphAt(bad, ['outer', 'inner'])!.edges.push(data('loop_in.acc', 'loop_out.nope'));
    const errs = compileWorkflow(bad, reg).errors;
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].path).toBe('outer.body/inner.body/');
    expect(errs[0].message).toContain('outer.body/inner.body/');
  });

  it('runs with records keyed outer#i/inner#j and per-iteration data', async () => {
    const c = compileWorkflow(nested(), reg);
    const events: RunEvent[] = [];
    const res = await runWorkflow(c.graph!, {}, { runtime: new MockAgentRuntime(), runId: 'r', onEvent: (e) => events.push(e) });
    const rec = (k: string) => res.records.find((r) => r.key === `r/${k}`);
    expect(res.status).toBe('success');
    expect(rec('outer#0/inner#2/inc')?.outputs).toEqual({ result: 3 });
    expect(rec('outer#1/inner#0/inc')?.inputs).toEqual({ input: 1 });
    expect(rec('outer#1/inner#2/inc')?.outputs).toEqual({ result: 4 });
    expect(rec('root/end')?.inputs).toEqual({ total: 4 });
    // 內層 iteration 事件的 scope 帶完整路徑，前端才能分開選外層 / 內層輪次
    const innerIters = events.filter((e) => e.type === 'loop_iteration_started' && e.node_id === 'inner');
    expect(innerIters.map((e) => e.scope!.map((s) => `${s.loop}#${s.iteration}`).join('/'))).toEqual([
      'outer#0/inner#0', 'outer#0/inner#1', 'outer#0/inner#2', 'outer#1/inner#0', 'outer#1/inner#1', 'outer#1/inner#2',
    ]);
  });
});

describe('nested JSON save path (graph-path)', () => {
  it('getGraphAt / setGraphAt write back to the right nested body without touching siblings', () => {
    const w = nested();
    const g = structuredClone(getGraphAt(w, ['outer', 'inner'])!);
    g.nodes.push(n('log_1', 'log', { config: { level: 'info' } }));
    g.edges.push(ctl('inc.success', 'log_1'), data('inc.result', 'log_1.message'));
    const w2 = setGraphAt(w, ['outer', 'inner'], g);
    expect(getGraphAt(w2, ['outer', 'inner'])!.nodes.map((x) => x.id)).toEqual(['loop_in', 'inc', 'loop_out', 'log_1']);
    expect(getGraphAt(w, ['outer', 'inner'])!.nodes).toHaveLength(3); // 原物件不變
    expect(w2.nodes.find((x) => x.id === 'end')).toEqual(w.nodes.find((x) => x.id === 'end'));
    expect(compileWorkflow(w2, reg).errors).toEqual([]);
    // 外層存檔（帶舊 body 的節點）不會蓋掉剛剛內層的修改
    const outerStale = structuredClone(getGraphAt(w, ['outer'])!);
    outerStale.nodes.find((x) => x.id === 'inner')!.ui = { x: 10, y: 20 };
    const w3 = setGraphAt(w2, ['outer'], outerStale);
    expect(getGraphAt(w3, ['outer', 'inner'])!.nodes.map((x) => x.id)).toContain('log_1');
    expect(getGraphAt(w3, ['outer'])!.nodes.find((x) => x.id === 'inner')!.ui).toEqual({ x: 10, y: 20 });
    expect(() => setGraphAt(w, ['outer', 'nope'], g)).toThrow(/path not found/);
  });

  it('bodyPortsAt + boundaryAnnotations expose the outer → inner port mapping', () => {
    const w = nested();
    expect(Object.keys(bodyPortsAt(w, ['outer', 'inner'], reg)!.bodyIn)).toEqual(['acc', 'iteration']);
    const ann = boundaryAnnotations(getGraphAt(w, ['outer'])!, getGraphAt(w, ['outer'])!.nodes.find((x) => x.id === 'inner')!, getGraphAt(w, ['outer', 'inner'])!);
    expect(ann.loop_in['d:acc']).toContain('← loop_in.iteration');
    expect(ann.loop_in['d:acc']).toContain('carry(loop_out.acc)');
    expect(ann.loop_out['d:acc']).toContain('→ inner.acc → loop_out.total');
  });
});

describe('sub-workflow run records', () => {
  it('emits subflow_started with a workflow snapshot and records child nodes under sub#0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sub2-'));
    const child = wf(
      [n('start', 'start', { ports: { outputs: { x: { schema: int } } } as never }), n('dbl', 'transform', { config: { expression: '$input * 2' }, ports: { outputs: { result: { schema: int } } } as never }), n('end', 'end', { ports: { inputs: { y: { schema: int } } } as never, config: { status: 'success' } })],
      [ctl('start.success', 'dbl'), ctl('dbl.success', 'end'), data('start.x', 'dbl.input'), data('dbl.result', 'end.y')],
    );
    fs.writeFileSync(path.join(dir, 'double.json'), JSON.stringify(child));
    const parent = wf(
      [n('start', 'start', { ports: { outputs: { v: { schema: int } } } as never }), n('sub', 'subflow', { config: { workflow: 'double' }, ports: { inputs: { x: { schema: int } }, outputs: { y: { schema: int } } } as never })],
      [ctl('start.success', 'sub'), data('start.v', 'sub.x')],
    );
    const c = compileWorkflow(parent, reg);
    expect(c.errors).toEqual([]);
    const events: RunEvent[] = [];
    const res = await runWorkflow(c.graph!, { v: 21 }, { runtime: new MockAgentRuntime(), runId: 'r', onEvent: (e) => events.push(e), services: { loadWorkflow: createWorkflowLoader(dir), registry: reg } });
    const keys = res.records.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['r/root/sub', 'r/sub#0/start', 'r/sub#0/dbl', 'r/sub#0/end']));
    expect(res.records.find((r) => r.key === 'r/sub#0/dbl')!.outputs).toEqual({ result: 42 });
    expect(res.records.find((r) => r.key === 'r/root/sub')!.outputs).toEqual({ y: 42 });
    const ev = events.find((e) => e.type === 'subflow_started')!;
    expect(ev.node_id).toBe('sub');
    expect(ev.scope).toEqual([{ loop: 'sub', iteration: 0 }]);
    expect((ev.data as { workflow_id: string }).workflow_id).toBe('double');
    expect((ev.data as { workflow: WorkflowGraph }).workflow.nodes.map((x) => x.id)).toEqual(['start', 'dbl', 'end']);
  });
});
