import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkflow } from '../../src/compiler.js';
import { n, registry, root } from '../helpers.js';
import { codes, v1 } from './v1helpers.js';

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

describe('compiler (DSL v1)', () => {
  it('the bundled demo workflows compile as v1 (nested-review needs advanced)', () => {
    expect(compileWorkflow(read('workflows/fix-until-tests-pass.json'), registry()).errors).toEqual([]);
    expect(compileWorkflow(read('workflows/plan-subflow.json'), registry()).errors).toEqual([]);
    const nested = read('workflows/nested-review.json');
    expect(compileWorkflow(nested, registry()).ok).toBe(false);
    expect(compileWorkflow(nested, registry(), { advanced: true }).errors).toEqual([]);
  });

  it('every error in invalid-example.json carries a concrete fix suggestion', () => {
    const r = compileWorkflow(read('workflows/invalid-example.json'), registry());
    expect(r.errors.length).toBeGreaterThanOrEqual(10);
    for (const e of r.errors) expect(e.fix, `${e.code}: ${e.message}`).toBeTruthy();
    expect(new Set(r.errors.map((e) => e.code))).toEqual(
      new Set(['INVALID_EDGE', 'POLICY_OVERRIDE', 'UNKNOWN_NODE_TYPE', 'INVALID_CONFIG', 'LOOP_BODY_PORTS', 'TYPE_MISMATCH', 'UNKNOWN_PORT', 'MISSING_REQUIRED_INPUT', 'CYCLE']),
    );
  });

  it('legacy (control-edge) format is rejected without advanced, accepted with it', () => {
    const legacy = read('test/advanced/fixtures/fix-until-tests-pass.json');
    expect(codes(legacy)[0]).toBe('LEGACY_FORMAT');
    expect(compileWorkflow(legacy, registry(), { advanced: true }).errors).toEqual([]);
  });

  it('control edges, advanced nodes, join/switch, nested loops and carry are not v1', () => {
    expect(codes(v1([n('p', 'producer'), n('a', 'needs_text')], [{ kind: 'control', from: 'p.success', to: 'a.execute' }, 'p.text -> a.text']))).toContain('INVALID_EDGE');
    expect(codes(v1([n('d', 'delay', { config: { ms: 1 } })], []))).toContain('NODE_NOT_IN_V1');
    expect(codes(v1([n('d', 'delay', { config: { ms: 1 } })], []), { advanced: true })).not.toContain('NODE_NOT_IN_V1');
    expect(codes(v1([n('j', 'join')], []), { advanced: true })).toContain('NODE_NOT_IN_V1');
    const inner = n('inner', 'loop', { config: { max_iterations: 2 }, ports: { inputs: {}, outputs: {} }, body: { nodes: [n('loop_in', 'loop_in'), n('loop_out', 'loop_out')], edges: [] } });
    const outer = n('outer', 'loop', { config: { max_iterations: 2, carry: [{ from: 'x', to: 'y' }] }, ports: { inputs: {}, outputs: {} }, body: { nodes: [n('loop_in', 'loop_in'), inner, n('loop_out', 'loop_out')], edges: [] } });
    const c = codes(v1([outer], []));
    expect(c).toContain('NESTED_LOOP_NOT_IN_V1');
    expect(c).toContain('V1_LOOP_CONFIG');
  });

  it('type checking: incompatible edge → TYPE_MISMATCH with a suggested compatible edge', () => {
    const r = compileWorkflow(v1([n('p', 'producer'), n('t', 'needs_text')], ['p.count -> t.text']), registry());
    const e = r.errors.find((x) => x.code === 'TYPE_MISMATCH')!;
    expect(e.fix).toContain('"p.text -> t.text"');
  });

  it('permission lock: agent config may not override model / tools', () => {
    expect(codes(v1([n('c', 'coding_agent', { config: { model: 'x', allowed_tools: ['Bash'] }, inputs: { tasks: [] } })], []))).toEqual(['POLICY_OVERRIDE', 'POLICY_OVERRIDE']);
  });

  it('unknown types get a "did you mean" fix; end without connection is an error', () => {
    const r = compileWorkflow(v1([n('a', 'codng_agent'), n('e', 'end', { ports: { inputs: { x: { type: 'string' } } } })], []), registry());
    expect(r.errors.find((e) => e.code === 'UNKNOWN_NODE_TYPE')!.fix).toContain('coding_agent');
    expect(r.errors.map((e) => e.code)).toContain('END_UNCONNECTED');
  });

  it('condition outputs take the type of their data source (pass-through typing)', () => {
    const ok = v1([n('p', 'producer'), n('g', 'condition', { config: { rule: { op: 'gt', value: 1 } } }), n('t', 'needs_text')], ['p.count -> g.value', 'p.text -> g.data', 'g.true -> t.text']);
    expect(codes(ok)).toEqual([]);
    const bad = v1([n('p', 'producer'), n('g', 'condition', { config: { rule: { op: 'gt', value: 1 } } }), n('t', 'needs_text')], ['p.count -> g.value', 'g.true -> t.text']);
    expect(codes(bad)).toEqual(['TYPE_MISMATCH']);
  });

  it('fan-in onto one input is allowed in v1 (branches merge, first value wins); cycles are not', () => {
    const w = v1(
      [n('p', 'producer'), n('g', 'condition', { config: { rule: { op: 'truthy' } } }), n('a', 'needs_text'), n('b', 'needs_text'), n('e', 'end', { ports: { inputs: { echo: { type: 'string' } } } })],
      ['p.count -> g.value', 'p.text -> g.data', 'g.true -> a.text', 'g.false -> b.text', 'a.echo -> e.echo', 'b.echo -> e.echo'],
    );
    expect(codes(w)).toEqual([]);
    expect(codes(v1([n('a', 'needs_text'), n('b', 'needs_text')], ['a.echo -> b.text', 'b.echo -> a.text']))).toContain('CYCLE');
  });
});
