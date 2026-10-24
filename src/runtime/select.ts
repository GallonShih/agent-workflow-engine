import type { NodeDefinition } from '../types.js';
import type { AgentRuntime } from './types.js';
import { ClaudeAgentRuntime } from './claude.js';

export type RuntimeMode = 'mock' | 'claude';

/**
 * 預設一律用 mock runtime。只有明確指定 runtime = 'claude'（CLI `--runtime claude` 或 AGENT_RUNTIME=claude）
 * 且有 ANTHROPIC_API_KEY 時，`runtime: claude_agent_sdk` 的節點才改走 Circuit 的 Claude adapter。
 */
export function resolveRuntimeMode(requested?: string): { mode: RuntimeMode; reason: string } {
  const want = (requested ?? process.env.AGENT_RUNTIME ?? 'mock').toLowerCase();
  if (want !== 'claude') return { mode: 'mock', reason: 'default mock runtime' };
  if (!process.env.ANTHROPIC_API_KEY) return { mode: 'mock', reason: 'claude requested but ANTHROPIC_API_KEY is not set → mock' };
  return { mode: 'claude', reason: 'claude requested and ANTHROPIC_API_KEY set' };
}

export function makeRuntimeSelector(mock: AgentRuntime, opts: { runtime?: string } = {}) {
  const { mode } = resolveRuntimeMode(opts.runtime);
  const claude = mode === 'claude' ? new ClaudeAgentRuntime() : undefined;
  return (def: NodeDefinition): AgentRuntime => (claude && def.runtime === 'claude_agent_sdk' ? claude : mock);
}
