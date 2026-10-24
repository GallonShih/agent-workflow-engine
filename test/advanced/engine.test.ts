import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkflow } from './adv.js';
import { runWorkflow } from './adv.js';
import { MockAgentRuntime, sleep } from '../../src/runtime/mock.js';
import { demoRuntime } from '../../src/demo/scenario.js';
import type { WorkflowGraph } from '../../src/types.js';
import { ctl, data, n, registry, root, wf, WS } from '../helpers.js';

async function run(w: WorkflowGraph, runtime: MockAgentRuntime, inputs: Record<string, unknown> = {}) {
  const c = compileWorkflow(w, registry());
  expect(c.errors).toEqual([]);
  const res = await runWorkflow(c.graph!, inputs, { runtime, runId: 'r1', workspace: WS });
  const rec = (key: string) => res.records.find((r) => r.key === `r1/${key}`)!;
  return { res, rec };
}

const demo = () => JSON.parse(fs.readFileSync(path.join(root, 'test/advanced/fixtures/fix-until-tests-pass.json'), 'utf8'));
const demoInputs = { request: 'fix bug', repository: 'acme/parser' };

describe('hybrid dataflow + control flow', () => {
  it('typed multi-output + fan-out: one output feeds two consumers', async () => {
    const rt = new MockAgentRuntime({ producer: () => ({ text: 'hello', count: 2, tags: [] }), needs_text: ({ inputs }) => ({ echo: `${inputs.text}!` }) });
    const { rec } = await run(
      wf([n('p', 'producer'), n('a', 'needs_text'), n('b', 'needs_text')], [ctl('p.success', 'a'), ctl('p.success', 'b'), data('p.text', 'a.text'), data('p.text', 'b.text')]),
      rt,
    );
    expect(rec('root/a').outputs).toEqual({ echo: 'hello!' });
    expect(rec('root/b').outputs).toEqual({ echo: 'hello!' });
  });

  it('a data edge alone does not trigger: node on an untaken branch is skipped although its data is ready', async () => {
    const rt = new MockAgentRuntime({ producer: () => ({ text: 'x', count: 0, tags: [] }), needs_text: () => ({ echo: 'ran' }) });
    const { rec } = await run(
      wf(
        [n('p', 'producer'), n('gate', 'condition', { config: { rule: { op: 'gt', value: 5 } } }), n('t', 'needs_text')],
        [ctl('p.success', 'gate'), data('p.count', 'gate.value'), ctl('gate.true', 't'), data('p.text', 't.text')],
      ),
      rt,
    );
    expect(rec('root/gate').outputs).toEqual({ result: false });
    expect(rec('root/t').status).toBe('skipped');
  });

  it('multi-input node triggered early waits until its slow data producer settles', async () => {
    const order: string[] = [];
    const rt = new MockAgentRuntime({
      producer: async ({ nodeId }) => { if (nodeId === 'slow') await sleep(30); order.push(nodeId); return { text: nodeId, count: 1, tags: [] }; },
      two_inputs: ({ inputs }) => { order.push('join'); return { joined: `${inputs.a}+${inputs.b}` }; },
    });
    const { rec } = await run(
      wf([n('fast', 'producer'), n('slow', 'producer'), n('j', 'two_inputs')], [ctl('fast.success', 'j'), data('fast.text', 'j.a'), data('slow.text', 'j.b')]),
      rt,
    );
    expect(order).toEqual(['fast', 'slow', 'join']);
    expect(rec('root/j').outputs).toEqual({ joined: 'fast+slow' });
  });

  it('failure port routes control; required input from a failed producer fails the consumer', async () => {
    const rt = new MockAgentRuntime({ needs_text: () => { throw new Error('boom'); }, producer: () => ({ text: 'ok', count: 1, tags: [] }) });
    const { rec, res } = await run(
      wf(
        [n('a', 'needs_text', { inputs: { text: 'x' } }), n('onfail', 'producer'), n('onok', 'producer')],
        [ctl('a.success', 'onok'), ctl('a.failure', 'onfail')],
      ),
      rt,
    );
    expect(rec('root/a').status).toBe('failed');
    expect(rec('root/onfail').status).toBe('success');
    expect(rec('root/onok').status).toBe('skipped');
    expect(res.status).toBe('success'); // failure 有被處理
  });

  it('unhandled failure fails the run', async () => {
    const rt = new MockAgentRuntime({ needs_text: () => { throw new Error('boom'); } });
    const { res } = await run(wf([n('a', 'needs_text', { inputs: { text: 'x' } })], []), rt);
    expect(res.status).toBe('failed');
  });

  it('retry policy and timeout', async () => {
    let calls = 0;
    const rt = new MockAgentRuntime({
      flaky: () => { calls++; if (calls < 3) throw new Error('transient'); return { ok: true }; },
      slow: async ({ signal }) => { await sleep(500, signal); return { ok: true }; },
    });
    const { rec } = await run(wf([n('f', 'flaky'), n('s', 'slow')], []), rt);
    expect(rec('root/f').status).toBe('success');
    expect(rec('root/f').attempts).toBe(3);
    expect(rec('root/s').status).toBe('failed');
    expect(rec('root/s').error).toMatch(/timeout/);
  });

  it('agent output that violates its output schema fails the node', async () => {
    const rt = new MockAgentRuntime({ needs_number: () => ({ doubled: 'not a number' }) });
    const { rec } = await run(wf([n('a', 'needs_number', { inputs: { n: 1 } })], []), rt);
    expect(rec('root/a').status).toBe('failed');
    expect(rec('root/a').error).toMatch(/schema/);
  });

  it('join(all) waits for parallel branches; pure data node (template) is pulled lazily', async () => {
    const rt = new MockAgentRuntime({ producer: async ({ nodeId }) => { await sleep(nodeId === 'b' ? 20 : 1); return { text: nodeId, count: 1, tags: [] }; }, needs_text: ({ inputs }) => ({ echo: String(inputs.text) }) });
    const { rec } = await run(
      wf(
        [
          n('a', 'producer'), n('b', 'producer'), n('j', 'join'),
          n('tpl', 'template', { ports: { inputs: { x: { type: 'string' }, y: { type: 'string' } } }, config: { template: '{{inputs.x}}&{{inputs.y}}' } }),
          n('out', 'needs_text'),
        ],
        [ctl('a.success', 'j.in'), ctl('b.success', 'j.in'), ctl('j.success', 'out'), data('a.text', 'tpl.x'), data('b.text', 'tpl.y'), data('tpl.text', 'out.text')],
      ),
      rt,
    );
    expect(rec('root/out').outputs).toEqual({ echo: 'a&b' });
  });
});

describe('loop composite + demo chain (planning → coding → testing → condition → retry < 3)', () => {
  it('passes on the 3rd iteration; each iteration reads only its own data; feedback carried forward', async () => {
    const { res, rec } = await run(demo(), demoRuntime({ passOnIteration: 2, flakyCoder: true }), demoInputs);
    expect(res.status).toBe('success');
    expect(rec('root/fix_loop').outputs).toMatchObject({ passed: true, iterations: 3 });
    expect(rec('root/fix_loop').fired).toEqual(['completed', 'done']);
    for (const i of [0, 1, 2]) {
      expect(rec(`fix_loop#${i}/tester`).inputs!.files_modified).toEqual([`src/parser.ts@iter${i}`, `test/parser.test.ts@iter${i}`]);
      expect(rec(`fix_loop#${i}/coder`).iteration).toBe(i);
    }
    expect(rec('fix_loop#0/coder').inputs!.feedback).toEqual([]);
    expect(rec('fix_loop#1/coder').inputs!.feedback).toEqual(['iter0: parser.test.ts > 空字串應回傳 [] 失敗']);
    expect(rec('fix_loop#0/coder').attempts).toBe(2); // retry policy inside the loop
    expect(rec('root/end_ok').status).toBe('success');
    expect(rec('root/end_fail').status).toBe('skipped');
    expect(String(rec('root/report').outputs!.report)).toContain('第 3 輪測試通過');
    expect(res.token_usage.input_tokens).toBeGreaterThan(0);
  });

  it('stops early when tests pass on the first iteration', async () => {
    const { rec } = await run(demo(), demoRuntime({ passOnIteration: 0 }), demoInputs);
    expect(rec('root/fix_loop').outputs).toMatchObject({ iterations: 1 });
    expect(rec('fix_loop#1/coder')).toBeUndefined();
  });

  it('max iterations reached → condition FAIL → FAILED end; join/report skipped', async () => {
    const { res, rec } = await run(demo(), demoRuntime({ passOnIteration: null }), demoInputs);
    expect(res.status).toBe('failed');
    expect(rec('root/fix_loop').fired).toEqual(['completed', 'exhausted']);
    expect(rec('root/fix_loop').outputs).toMatchObject({ passed: false, iterations: 3 });
    expect(rec('root/gate').fired).toEqual(['false']);
    expect(rec('root/join').status).toBe('skipped');
    expect(rec('root/report').status).toBe('skipped');
    expect(rec('root/end_fail').status).toBe('success');
    expect(rec('root/end_fail').outputs).toMatchObject({ status: 'failed' });
  });

  it('events are keyed by run_id + scope(iteration) + node_id', async () => {
    const { res } = await run(demo(), demoRuntime({ passOnIteration: 1 }), demoInputs);
    const keys = res.events.filter((e) => e.type === 'node_succeeded' && e.node_id === 'tester').map((e) => e.key);
    expect(keys).toEqual(['r1/fix_loop#0/tester', 'r1/fix_loop#1/tester']);
  });
});
