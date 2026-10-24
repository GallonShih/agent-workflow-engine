import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkflow } from './adv.js';
import { isCompatible } from '../../src/schema.js';
import { TypedSocket, controlSocket } from '../../src/sockets.js';
import { ctl, data, n, registry, root, wf } from '../helpers.js';

const codes = (w: Parameters<typeof compileWorkflow>[0]) => compileWorkflow(w, registry()).errors.map((e) => e.code);

describe('schema compatibility (Ajv / JSON Schema)', () => {
  it('integer → number ok, string → number rejected', () => {
    expect(isCompatible({ type: 'integer' }, { type: 'number' }).ok).toBe(true);
    expect(isCompatible({ type: 'string' }, { type: 'number' }).ok).toBe(false);
  });
  it('array items and object required properties are checked', () => {
    const task = { type: 'object', required: ['id', 'title'], properties: { id: { type: 'string' }, title: { type: 'string' } } };
    expect(isCompatible({ type: 'array', items: task }, { type: 'array', items: { type: 'object' } }).ok).toBe(true);
    expect(isCompatible({ type: 'array', items: { type: 'object' } }, { type: 'array', items: task }).ok).toBe(false);
    expect(isCompatible({ type: 'array', items: { type: 'number' } }, { type: 'array', items: { type: 'string' } }).ok).toBe(false);
  });
  it('enum subset and any-target', () => {
    expect(isCompatible({ enum: ['low', 'high'] }, { enum: ['low', 'medium', 'high'] }).ok).toBe(true);
    expect(isCompatible({ type: 'string' }, { enum: ['low'] }).ok).toBe(false);
    expect(isCompatible({ type: 'string' }, {}).ok).toBe(true);
  });
  it('Rete sockets use the same rule (frontend connection check)', () => {
    expect(new TypedSocket({ type: 'integer' }).isCompatibleWith(new TypedSocket({ type: 'number' }))).toBe(true);
    expect(new TypedSocket({ type: 'string' }).isCompatibleWith(new TypedSocket({ type: 'number' }))).toBe(false);
    expect(new TypedSocket({ type: 'string' }).isCompatibleWith(controlSocket)).toBe(false);
  });
});

describe('graph compiler', () => {
  it('compiles the demo workflow without errors', () => {
    const w = JSON.parse(fs.readFileSync(path.join(root, 'test/advanced/fixtures/fix-until-tests-pass.json'), 'utf8'));
    const res = compileWorkflow(w, registry());
    expect(res.errors).toEqual([]);
    expect(res.graph!.nodes.get('fix_loop')!.body!.nodes.size).toBe(4);
  });
  it('rejects unknown node types and ports', () => {
    expect(codes(wf([n('a', 'nope')], []))).toContain('UNKNOWN_NODE_TYPE');
    expect(codes(wf([n('a', 'producer'), n('b', 'needs_text')], [ctl('a.success', 'b'), data('a.missing', 'b.text')]))).toContain('UNKNOWN_PORT');
  });
  it('rejects incompatible port types', () => {
    expect(codes(wf([n('a', 'producer'), n('b', 'needs_number')], [ctl('a.success', 'b'), data('a.text', 'b.n')]))).toContain('TYPE_MISMATCH');
    expect(codes(wf([n('a', 'producer'), n('b', 'needs_number')], [ctl('a.success', 'b'), data('a.count', 'b.n')]))).toEqual([]);
  });
  it('rejects data edge into a control port and vice versa', () => {
    expect(codes(wf([n('a', 'producer'), n('b', 'needs_text')], [data('a.text', 'b.execute'), data('a.text', 'b.text')]))).toContain('EDGE_KIND_MISMATCH');
    expect(codes(wf([n('a', 'producer'), n('b', 'needs_text')], [ctl('a.text', 'b.execute'), data('a.text', 'b.text')]))).toContain('EDGE_KIND_MISMATCH');
  });
  it('requires required inputs to be connected (or constant)', () => {
    expect(codes(wf([n('b', 'needs_text')], []))).toContain('MISSING_REQUIRED_INPUT');
    expect(codes(wf([n('b', 'needs_text', { inputs: { text: 'hi' } })], []))).toEqual([]);
    expect(codes(wf([n('b', 'needs_text', { inputs: { text: 42 } })], []))).toContain('INVALID_CONSTANT');
  });
  it('rejects fan-in into a single input but allows fan-out', () => {
    const w = wf([n('a', 'producer'), n('c', 'producer'), n('b', 'needs_text'), n('d', 'needs_text')], [ctl('a.success', 'b'), data('a.text', 'b.text'), data('c.text', 'b.text')]);
    expect(compileWorkflow(w, registry()).errors.map((e) => e.code)).toContain('MULTIPLE_DATA_INPUTS');
    const fanout = wf([n('a', 'producer'), n('b', 'needs_text'), n('d', 'needs_text')], [ctl('a.success', 'b'), ctl('a.success', 'd'), data('a.text', 'b.text'), data('a.text', 'd.text')]);
    expect(codes(fanout)).toEqual([]);
  });
  it('rejects cycles in the outer DAG', () => {
    const w = wf([n('a', 'needs_text'), n('b', 'needs_text')], [data('a.echo', 'b.text'), data('b.echo', 'a.text')]);
    expect(codes(w)).toContain('CYCLE');
  });
  it('rejects policy overrides from workflow JSON (planner cannot grant tools)', () => {
    expect(codes(wf([n('a', 'producer', { config: { allowed_tools: ['Bash'] } })], []))).toContain('POLICY_OVERRIDE');
  });
  it('validates loop config and body', () => {
    const loop = n('l', 'loop', { ports: { outputs: { ok: { type: 'boolean' } } }, config: { max_iterations: 0, until: { port: 'nope', op: 'eq', value: true } }, body: wf([n('loop_in', 'loop_in')], []) });
    const c = codes(wf([loop], []));
    expect(c).toContain('INVALID_CONFIG');
    expect(c).toContain('LOOP_BODY_PORTS');
    expect(codes(wf([n('x', 'loop_in')], []))).toContain('LOOP_PORT_OUTSIDE_LOOP');
  });
});
