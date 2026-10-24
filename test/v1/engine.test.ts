import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkflow } from '../../src/compiler.js';
import { runWorkflow } from '../../src/engine.js';
import { MockAgentRuntime, sleep } from '../../src/runtime/mock.js';
import { demoRuntime } from '../../src/demo/scenario.js';
import type { WorkflowNode } from '../../src/types.js';
import { n, registry, root } from '../helpers.js';
import { runV1, v1 } from './v1helpers.js';

const gate = (op: string, value?: unknown) => n('g', 'condition', { config: { rule: { op, value } } });
const endNode = (id: string, ports: NonNullable<NonNullable<WorkflowNode['ports']>['inputs']>, status = 'success') => n(id, 'end', { config: { status }, ports: { inputs: ports } });

describe('engine (DSL v1: data edges only)', () => {
  it('execution order follows data dependencies; fan-out feeds every consumer', async () => {
    const order: string[] = [];
    const rt = new MockAgentRuntime({
      producer: async () => { await sleep(10); order.push('p'); return { text: 'hi', count: 2, tags: [] }; },
      needs_text: ({ nodeId, inputs }) => { order.push(nodeId); return { echo: `${inputs.text}!` }; },
      two_inputs: ({ inputs }) => { order.push('j'); return { joined: `${inputs.a}+${inputs.b}` }; },
    });
    const { res, rec } = await runV1(v1([n('p', 'producer'), n('a', 'needs_text'), n('b', 'needs_text'), n('j', 'two_inputs')], ['p.text -> a.text', 'p.text -> b.text', 'a.echo -> j.a', 'b.echo -> j.b']), rt);
    expect(res.status).toBe('success');
    expect(order[0]).toBe('p');
    expect(order.at(-1)).toBe('j');
    expect(rec('j')!.outputs).toEqual({ joined: 'hi!+hi!' });
  });

  it('condition routes data to one side; the other side and everything below it is skipped', async () => {
    const rt = new MockAgentRuntime({ producer: () => ({ text: 'payload', count: 0, tags: [] }), needs_text: ({ inputs }) => ({ echo: String(inputs.text) }) });
    const w = v1(
      [n('p', 'producer'), gate('gt', 5), n('yes', 'needs_text'), n('no', 'needs_text'), n('after_yes', 'needs_text')],
      ['p.count -> g.value', 'p.text -> g.data', 'g.true -> yes.text', 'g.false -> no.text', 'yes.echo -> after_yes.text'],
    );
    const { res, rec, status } = await runV1(w, rt);
    expect(res.status).toBe('success');
    expect(rec('g')!.outputs).toEqual({ result: false, false: 'payload' });
    expect(status('no')).toBe('success');
    expect(rec('no')!.outputs).toEqual({ echo: 'payload' });
    expect(status('yes')).toBe('skipped');
    expect(status('after_yes')).toBe('skipped');
  });

  it('branches merge by fan-in onto the same input; only the matching end runs', async () => {
    for (const count of [0, 9]) {
      const rt = new MockAgentRuntime({ producer: () => ({ text: 't', count, tags: [] }), needs_text: ({ nodeId }) => ({ echo: nodeId }) });
      const w = v1(
        [n('p', 'producer'), gate('gt', 5), n('big', 'needs_text'), n('small', 'needs_text'), endNode('done', { echo: { type: 'string' } }), endNode('alarm', { reason: {} }, 'failed')],
        ['p.count -> g.value', 'p.text -> g.data', 'g.true -> big.text', 'g.false -> small.text', 'big.echo -> done.echo', 'small.echo -> done.echo', 'g.false -> alarm.reason'],
      );
      const c = compileWorkflow(w, registry());
      expect(c.errors).toEqual([]);
      const res = await runWorkflow(c.graph!, {}, { runtime: rt, runId: 'r' });
      const done = res.records.find((r) => r.key === 'r/root/done')!;
      expect(done.status).toBe('success');
      expect(JSON.stringify(done)).toContain(count > 5 ? '"big"' : '"small"');
      expect(res.records.find((r) => r.key === 'r/root/alarm')!.status).toBe(count > 5 ? 'skipped' : 'success');
      expect(res.status).toBe(count > 5 ? 'success' : 'failed');
    }
  });

  it('a failing node fails the run and skips its downstream', async () => {
    const rt = new MockAgentRuntime({ producer: () => ({ text: 't', count: 1, tags: [] }), needs_text: ({ nodeId }) => { if (nodeId === 'a') throw new Error('boom'); return { echo: 'x' }; } });
    const { res, status } = await runV1(v1([n('p', 'producer'), n('a', 'needs_text'), n('b', 'needs_text')], ['p.text -> a.text', 'a.echo -> b.text']), rt);
    expect(res.status).toBe('failed');
    expect(status('a')).toBe('failed');
    expect(status('b')).toBe('skipped');
  });

  it('retry (registry config) and timeout still apply', async () => {
    let calls = 0;
    const rt = new MockAgentRuntime({ flaky: () => { calls++; if (calls < 3) throw new Error('flaky'); return { ok: true }; }, slow: async ({ signal }) => { await sleep(500, signal); return { ok: true }; } });
    const a = await runV1(v1([n('f', 'flaky')], []), rt);
    expect(a.status('f')).toBe('success');
    expect(a.rec('f')!.attempts).toBe(3);
    const b = await runV1(v1([n('s', 'slow')], []), rt);
    expect(b.status('s')).toBe('failed');
    expect(b.res.status).toBe('failed');
  });

  it('agent outputs are validated against the output schema', async () => {
    const rt = new MockAgentRuntime({ producer: () => ({ text: 5, count: 'x', tags: [] }) });
    const { status } = await runV1(v1([n('p', 'producer')], []), rt);
    expect(status('p')).toBe('failed');
  });

  it('demo: loop retries with auto-carried feedback until tests pass; never-pass ends on end_fail', async () => {
    const w = JSON.parse(fs.readFileSync(path.join(root, 'workflows/fix-until-tests-pass.json'), 'utf8'));
    const inputs = { request: 'fix bug', repository: 'acme/parser' };
    const ok = await runV1(w, demoRuntime({ passOnIteration: 2, flakyCoder: false }), inputs);
    expect(ok.res.status).toBe('success');
    expect(ok.status('end_ok')).toBe('success');
    expect(ok.status('end_fail')).toBe('skipped');
    expect(ok.rec('fix_loop')!.outputs).toMatchObject({ passed: true, iterations: 3, done: true });
    const coder2 = ok.res.records.find((r) => r.key === 'r1/fix_loop#2/coder')!;
    expect(JSON.stringify(coder2.inputs)).toContain('iter1'); // feedback from iteration 1 was carried in
    const bad = await runV1(w, demoRuntime({ passOnIteration: null, flakyCoder: false }), inputs);
    expect(bad.res.status).toBe('failed');
    expect(bad.status('end_fail')).toBe('success');
    expect(bad.status('end_ok')).toBe('skipped');
    expect(bad.status('report')).toBe('skipped');
  });

  it('advanced behaviours are guarded at run time too', async () => {
    const c = compileWorkflow(v1([n('p', 'producer')], []), registry());
    await expect(runWorkflow(c.graph!, {}, { runtime: new MockAgentRuntime(), resume: { fromRunId: 'x', results: new Map() } })).rejects.toThrow(/advanced/);
  });
});
