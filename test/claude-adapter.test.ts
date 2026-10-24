import { describe, expect, it } from 'vitest';
import { ClaudeAgentRuntime } from '../src/runtime/claude.js';
import { registry } from './helpers.js';

// 不需要 API key：注入假的 SDK query()，驗證 Circuit ClaudeAgent → output ports 的對應
describe('Claude Agent SDK adapter (vendored Circuit ClaudeAgent, fake query)', () => {
  it('passes options to the SDK and maps structured_output to ports', async () => {
    let seen: Record<string, unknown> = {};
    const queryFn = (params: { prompt: string; options: Record<string, unknown> }) => {
      seen = params.options;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's1' };
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } };
        yield { type: 'result', subtype: 'success', result: 'done', structured_output: { passed: true, failures: [], report: 'ok' }, usage: { input_tokens: 120, output_tokens: 30 }, total_cost_usd: 0.001, num_turns: 2 };
      })();
    };
    const rt = new ClaudeAgentRuntime({ queryFn });
    const def = registry().get('testing_agent')!;
    const res = await rt.run({
      def, nodeId: 'tester', inputs: {}, prompt: 'run tests', iteration: 0, attempt: 1, scope: [], signal: new AbortController().signal, workingDirectory: '/tmp', workspaceAccess: 'write', allowedTools: ['Read', 'Bash'], disallowedTools: [],
      outputSchema: { type: 'object', properties: { passed: { type: 'boolean' } } },
    });
    expect(res.outputs).toEqual({ passed: true, failures: [], report: 'ok' });
    expect(res.usage).toMatchObject({ input_tokens: 120, output_tokens: 30 });
    expect(res.events.some((e) => e.type === 'tool-use' && e.name === 'Bash')).toBe(true);
    expect(seen.model).toBe('claude-sonnet-4-5');
    expect(seen.allowedTools).toEqual(['Read', 'Bash']);
    expect(seen.maxTurns).toBe(8);
    expect(seen.outputFormat).toMatchObject({ type: 'json_schema' });
    expect(seen).toMatchObject({ cwd: '/tmp', tools: ['Read', 'Bash'], permissionMode: 'acceptEdits' });
  });

  it('maps workspace access to SDK cwd / tools / disallowedTools / permissionMode', async () => {
    const seen: Record<string, unknown>[] = [];
    const queryFn = (params: { prompt: string; options: Record<string, unknown> }) => {
      seen.push(params.options);
      return (async function* () { yield { type: 'result', subtype: 'success', result: '', structured_output: { plan: 'p', tasks: [], acceptance_criteria: [] } }; })();
    };
    const rt = new ClaudeAgentRuntime({ queryFn });
    const def = registry().get('coding_agent')!;
    const base = { def, nodeId: 'n', inputs: {}, prompt: '', iteration: null, attempt: 1, scope: [], signal: new AbortController().signal, outputSchema: {} };
    const { toolsFor } = await import('../src/workspace-policy.js');
    const all = ['Read', 'Glob', 'Edit', 'Write', 'Bash'];
    const mk = (access: 'none' | 'read' | 'write') => ({ ...base, workspaceAccess: access, workingDirectory: access === 'none' ? undefined : '/repo', allowedTools: toolsFor(access, all).allowed, disallowedTools: toolsFor(access, all).removed });
    await rt.run(mk('none'));
    await rt.run(mk('read'));
    await rt.run(mk('write'));
    expect(seen[0]).toMatchObject({ tools: [], permissionMode: 'dontAsk', disallowedTools: all });
    expect(seen[0].cwd).not.toBe(process.cwd());
    expect(String(seen[0].cwd)).toMatch(/awf-no-workspace-/);
    expect(seen[1]).toMatchObject({ cwd: '/repo', tools: ['Read', 'Glob'], allowedTools: ['Read', 'Glob'], disallowedTools: ['Edit', 'Write', 'Bash'], permissionMode: 'dontAsk' });
    expect(seen[2]).toMatchObject({ cwd: '/repo', tools: all, allowedTools: all, disallowedTools: [], permissionMode: 'acceptEdits' });
    await expect(rt.run({ ...mk('write'), workingDirectory: undefined })).rejects.toThrow(/needs a workingDirectory/);
  });

  it('SDK error result becomes a node failure', async () => {
    const queryFn = () => (async function* () { yield { type: 'result', subtype: 'error_max_turns', errors: ['max turns'] }; })();
    const rt = new ClaudeAgentRuntime({ queryFn });
    await expect(rt.run({ def: registry().get('testing_agent')!, nodeId: 't', inputs: {}, prompt: '', iteration: null, attempt: 1, scope: [], signal: new AbortController().signal, workingDirectory: '/tmp', workspaceAccess: 'write', allowedTools: [], disallowedTools: [], outputSchema: {} })).rejects.toThrow(/max turns/);
  });
});

describe('runtime selection', () => {
  it('defaults to mock; claude only with explicit opt-in AND an API key', async () => {
    const { resolveRuntimeMode } = await import('../src/runtime/select.js');
    const saved = { key: process.env.ANTHROPIC_API_KEY, rt: process.env.AGENT_RUNTIME };
    try {
      delete process.env.AGENT_RUNTIME;
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      expect(resolveRuntimeMode().mode).toBe('mock');
      expect(resolveRuntimeMode('claude').mode).toBe('claude');
      delete process.env.ANTHROPIC_API_KEY;
      expect(resolveRuntimeMode('claude')).toMatchObject({ mode: 'mock', reason: expect.stringContaining('ANTHROPIC_API_KEY is not set') });
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.rt !== undefined) process.env.AGENT_RUNTIME = saved.rt;
    }
  });
});
