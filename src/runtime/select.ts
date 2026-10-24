import type { NodeDefinition } from '../types.js';
import type { AgentRuntime } from './types.js';
import { ClaudeAgentRuntime } from './claude.js';

/** runtime: claude_agent_sdk 且有 ANTHROPIC_API_KEY（且沒指定 --mock）才用真的 Claude，否則用 mock */
export function makeRuntimeSelector(mock: AgentRuntime, opts: { forceMock?: boolean } = {}) {
  const claude = new ClaudeAgentRuntime();
  const useClaude = !opts.forceMock && !!process.env.ANTHROPIC_API_KEY;
  return (def: NodeDefinition): AgentRuntime => (useClaude && def.runtime === 'claude_agent_sdk' ? claude : mock);
}
