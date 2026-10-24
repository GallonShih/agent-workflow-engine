import { describe, expect, it } from 'vitest';
import { isV1, normalizeWorkflow, parseEdge, serializeV1 } from '../../src/dsl.js';

describe('DSL v1 file format', () => {
  it('parses compact edge strings and {from,to} objects into data edges', () => {
    expect(parseEdge('a.out -> b.in')).toEqual({ kind: 'data', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } });
    expect(parseEdge({ from: 'a.out', to: 'b.in' })).toEqual({ kind: 'data', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } });
    expect(typeof parseEdge('a.out -> b')).toBe('string');
    expect(typeof parseEdge('nonsense')).toBe('string');
    expect(typeof parseEdge(42)).toBe('string');
  });

  it('isV1 only for version 1 documents', () => {
    expect(isV1({ version: 1, nodes: [], edges: [] })).toBe(true);
    expect(isV1({ nodes: [], edges: [] })).toBe(false);
    expect(isV1(null)).toBe(false);
  });

  it('normalize reports bad edges with their index; nested loop bodies are normalized too', () => {
    const { graph, errors } = normalizeWorkflow({
      version: 1,
      nodes: [{ id: 'l', type: 'loop', body: { nodes: [], edges: ['loop_in.x -> loop_out.x'] } }],
      edges: ['a.x -> b.y', 'broken'],
    });
    expect(graph.edges).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ index: 1 });
    expect(graph.nodes[0].body!.edges[0]).toMatchObject({ kind: 'data', from: { node: 'loop_in', port: 'x' } });
  });

  it('serializeV1 round-trips to compact strings', () => {
    const src = { version: 1, name: 'x', nodes: [{ id: 'a', type: 'start' }], edges: ['a.x -> b.y'] };
    const out = serializeV1(normalizeWorkflow(src).graph);
    expect(out).toMatchObject({ version: 1, name: 'x', edges: ['a.x -> b.y'] });
  });
});
