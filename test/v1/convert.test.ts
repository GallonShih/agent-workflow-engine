import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileWorkflow } from '../../src/compiler.js';
import { runWorkflow } from '../../src/engine.js';
import { convertToV1 } from '../../src/convert.js';
import { demoRuntime } from '../../src/demo/scenario.js';
import { ctl, data, n, registry, root, wf, WS } from '../helpers.js';

const fixture = (f: string) => JSON.parse(fs.readFileSync(path.join(root, 'test/advanced/fixtures', f), 'utf8'));

describe('legacy → v1 converter', () => {
  it('converts the legacy demo workflows into compiling v1 documents', () => {
    for (const [f, needsAdvanced] of [['fix-until-tests-pass.json', false], ['plan-subflow.json', false], ['nested-review.json', true]] as const) {
      const { workflow, notes } = convertToV1(fixture(f), registry());
      expect(workflow.version).toBe(1);
      expect((workflow.edges as unknown[]).every((e) => typeof e === 'string')).toBe(true);
      expect(compileWorkflow(workflow, registry(), { advanced: needsAdvanced }).errors, f).toEqual([]);
      expect(Array.isArray(notes)).toBe(true);
    }
  });

  it('converted demo behaves like the original (success path and failure path)', async () => {
    const { workflow } = convertToV1(fixture('fix-until-tests-pass.json'), registry());
    const c = compileWorkflow(workflow, registry());
    for (const [pass, expected, endId] of [[2, 'success', 'end_ok'], [null, 'failed', 'end_fail']] as const) {
      const res = await runWorkflow(c.graph!, { request: 'x', repository: 'y' }, { runtime: demoRuntime({ passOnIteration: pass, flakyCoder: false }), runId: 'r', workspace: WS });
      expect(res.status).toBe(expected);
      expect(res.records.find((r) => r.key === `r/root/${endId}`)!.status).toBe('success');
    }
  });

  it('removes joins, drops redundant control edges and gates condition branches via data', () => {
    const legacy = wf(
      [
        n('p', 'producer'),
        n('g', 'condition', { config: { rule: { op: 'gt', value: 1 } } }),
        n('a', 'needs_text'),
        n('b', 'needs_text'),
        n('j', 'join', { config: { inputs: 2 } }),
        n('e', 'end', { ports: { inputs: { x: { type: 'string' } } } }),
      ],
      [ctl('p.success', 'g'), data('p.count', 'g.value'), ctl('g.true', 'a'), data('p.text', 'a.text'), ctl('p.success', 'b'), data('p.text', 'b.text'), ctl('a.success', 'j.in_0'), ctl('b.success', 'j.in_1'), ctl('j.success', 'e'), data('a.echo', 'e.x')],
    );
    const { workflow, notes } = convertToV1(legacy, registry());
    const nodes = (workflow.nodes as { id: string; type: string }[]).map((x) => x.type);
    expect(nodes).not.toContain('join');
    expect(compileWorkflow(workflow, registry()).errors).toEqual([]);
    const edges = workflow.edges as string[];
    expect(edges).toContain('g_a.true -> a.text'); // a is gated by a copy of the condition forwarding its data
    expect(edges).toContain('b.echo -> e.after_b'); // ordering-only join input became a data dependency
    expect((workflow.nodes as { id: string }[]).map((x) => x.id)).not.toContain('g'); // unused original condition removed
    expect(notes.join('\n')).toMatch(/removed join "j"/);
  });

  it('v1 input is returned unchanged', () => {
    const v = { version: 1, nodes: [{ id: 'p', type: 'producer' }], edges: [] };
    expect(convertToV1(v as never, registry()).notes).toEqual(['already v1']);
  });
});
