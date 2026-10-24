import { expect } from 'vitest';
import { compileWorkflow } from '../../src/compiler.js';
import { runWorkflow } from '../../src/engine.js';
import type { MockAgentRuntime } from '../../src/runtime/mock.js';
import type { WorkflowNode } from '../../src/types.js';
import { registry } from '../helpers.js';

export const v1 = (nodes: WorkflowNode[], edges: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, nodes, edges, ...extra });
export const codes = (w: unknown, opts = {}) => compileWorkflow(w, registry(), opts).errors.map((e) => e.code);

export async function runV1(w: unknown, runtime: MockAgentRuntime, inputs: Record<string, unknown> = {}) {
  const c = compileWorkflow(w, registry());
  expect(c.errors).toEqual([]);
  const res = await runWorkflow(c.graph!, inputs, { runtime, runId: 'r1' });
  const rec = (key: string) => res.records.find((r) => r.key === `r1/root/${key}`);
  return { res, rec, status: (key: string) => rec(key)?.status };
}
