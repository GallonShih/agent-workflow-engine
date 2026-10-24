import path from 'node:path';
import { loadRegistry } from '../src/registry-fs.js';
import type { NodeRegistry } from '../src/registry.js';
import type { Edge, WorkflowGraph, WorkflowNode } from '../src/types.js';

export const root = path.resolve(import.meta.dirname, '..');

export function registry(): NodeRegistry {
  const reg = loadRegistry(path.join(root, 'registry/builtin'), path.join(root, 'registry/agents'));
  // 測試用小型節點
  reg.register({ name: 'producer', runtime: 'mock', outputs: { text: { type: 'string' }, count: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } } });
  reg.register({ name: 'needs_text', runtime: 'mock', inputs: { text: { type: 'string' } }, outputs: { echo: { type: 'string' } } });
  reg.register({ name: 'needs_number', runtime: 'mock', inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } } });
  reg.register({ name: 'two_inputs', runtime: 'mock', inputs: { a: { type: 'string' }, b: { type: 'string' } }, outputs: { joined: { type: 'string' } } });
  reg.register({ name: 'flaky', runtime: 'mock', outputs: { ok: { type: 'boolean' } }, config: { retry: { max_attempts: 3, backoff_ms: 1 } } });
  reg.register({ name: 'slow', runtime: 'mock', outputs: { ok: { type: 'boolean' } }, config: { timeout_seconds: 0.05 } });
  return reg;
}

export const n = (id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, type, ...extra });
export const data = (from: string, to: string): Edge => {
  const [fn, fp] = from.split('.');
  const [tn, tp] = to.split('.');
  return { kind: 'data', from: { node: fn, port: fp }, to: { node: tn, port: tp } };
};
export const ctl = (from: string, to: string): Edge => {
  const [fn, fp] = from.split('.');
  const [tn, tp] = to.split('.');
  return { kind: 'control', from: { node: fn, port: fp }, to: { node: tn, port: tp ?? 'execute' } };
};
export const wf = (nodes: WorkflowNode[], edges: Edge[]): WorkflowGraph => ({ nodes, edges });
