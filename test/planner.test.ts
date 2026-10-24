import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPlannerPrompt, mockPlanGenerator, planWorkflow } from '../src/planner.js';
import { runWorkflow } from '../src/engine.js';
import { demoRuntime } from '../src/demo/scenario.js';
import { loadRegistry } from '../src/registry-fs.js';
import type { WorkflowGraph } from '../src/types.js';

const registry = loadRegistry(path.join(import.meta.dirname, '../registry/builtin'), path.join(import.meta.dirname, '../registry/agents'));
const template: WorkflowGraph = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../workflows/fix-until-tests-pass.json'), 'utf8'));

describe('Phase 4 planner (prototype)', () => {
  it('prompt 只列出 registry 節點，不洩漏 system prompt / tools', () => {
    const p = buildPlannerPrompt(registry, '修 bug');
    expect(p).toContain('coding_agent');
    expect(p).toContain('loop');
    expect(p).not.toMatch(/allowed_tools:\s*\[/);
    expect(p).not.toContain('system_prompt:');
  });

  it('第一版用了不存在的節點與偷改 tools → compiler 擋下 → 帶錯誤修正後通過並可執行', async () => {
    const res = await planWorkflow({ goal: '修正 parser bug，測試失敗最多 3 次重試', registry, generate: mockPlanGenerator(template) });
    expect(res.ok).toBe(true);
    expect(res.attempts).toHaveLength(2);
    const codes = res.attempts[0].errors.map((e) => e.code);
    expect(codes).toContain('UNKNOWN_NODE_TYPE');
    expect(codes).toContain('POLICY_OVERRIDE');
    expect(res.workflow!.nodes.find((n) => n.type === 'loop')!.config!.max_iterations).toBe(3);
    const run = await runWorkflow(res.compiled!.graph!, { request: 'x', repository: 'y' }, { runtime: demoRuntime({ passOnIteration: 2 }) });
    expect(run.status).toBe('success');
  });

  it('一直產生不合法 JSON → 用完次數後失敗並保留每次錯誤', async () => {
    const res = await planWorkflow({ goal: 'g', registry, generate: async () => 'not json', maxAttempts: 2 });
    expect(res.ok).toBe(false);
    expect(res.attempts.map((a) => !!a.parseError)).toEqual([true, true]);
  });
});
