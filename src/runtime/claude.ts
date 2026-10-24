import { ClaudeAgent, type QueryFn } from '../vendor/circuit/agents/claude.js';
import type { AgentEvent, TokenUsage } from '../types.js';
import type { AgentRunRequest, AgentRunResult, AgentRuntime } from './types.js';
import type { SDKMCPServersConfig } from '../vendor/circuit/mcp/config-converter.js';

/**
 * Claude Agent SDK runtime：直接重用 Circuit 的 ClaudeAgent（src/vendor/circuit/agents/claude.ts），
 * 這層只負責：NodeDefinition → ClaudeNodeConfig、output ports → JSON Schema structured output、
 * structured_output → 各個 output port、收集事件與 token 用量。
 */
export class ClaudeAgentRuntime implements AgentRuntime {
  name = 'claude_agent_sdk';
  constructor(private opts: { mcpServers?: SDKMCPServersConfig; queryFn?: QueryFn } = {}) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const { def } = req;
    const servers: SDKMCPServersConfig = {};
    for (const name of def.mcp ?? []) if (this.opts.mcpServers?.[name]) servers[name] = this.opts.mcpServers[name];
    const mcpConfig = Object.keys(servers).length
      ? { mcpServers: servers, env: {}, allowedToolPatterns: Object.keys(servers).map((n) => `mcp__${n}__*`) }
      : undefined;
    const skillNote = def.skills?.length ? `\n\n可用 Skills：${def.skills.join(', ')}` : '';
    const agent = new ClaudeAgent(
      { model: def.model, systemPrompt: (def.system_prompt ?? '') + skillNote, tools: def.allowed_tools, maxTurns: def.config?.max_turns },
      mcpConfig,
      this.opts.queryFn,
    );
    const onAbort = () => void agent.interrupt();
    req.signal.addEventListener('abort', onAbort);
    const events: AgentEvent[] = [];
    let usage: TokenUsage | undefined;
    let error: string | undefined;
    try {
      for await (const ev of agent.execute(
        { prompt: req.prompt, workingDirectory: req.workingDirectory, outputConfig: { format: 'json', schema: JSON.stringify(req.outputSchema) } },
        { workflowId: '', executionId: '', nodeOutputs: new Map(), variables: new Map(), workingDirectory: req.workingDirectory },
      )) {
        if (ev.type === 'usage') usage = { input_tokens: ev.input_tokens, output_tokens: ev.output_tokens, cost_usd: ev.cost_usd };
        else events.push(ev);
        if (ev.type === 'error') error = ev.message;
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
    if (error) throw new Error(error);
    const parsed = agent.getStructuredOutput()?.parsedJson;
    if (!parsed || typeof parsed !== 'object') throw new Error('Claude agent returned no structured output');
    return { outputs: parsed as Record<string, unknown>, events, usage };
  }
}
