import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    const sdk = sdkPermissionOptions(req);
    const agent = new ClaudeAgent(
      { model: def.model, systemPrompt: (def.system_prompt ?? '') + skillNote, tools: req.allowedTools, maxTurns: def.config?.max_turns },
      mcpConfig,
      this.opts.queryFn,
      sdk,
    );
    const onAbort = () => void agent.interrupt();
    req.signal.addEventListener('abort', onAbort);
    const events: AgentEvent[] = [];
    let usage: TokenUsage | undefined;
    let error: string | undefined;
    try {
      for await (const ev of agent.execute(
        { prompt: req.prompt, workingDirectory: sdk.cwd, outputConfig: { format: 'json', schema: JSON.stringify(req.outputSchema) } },
        { workflowId: '', executionId: '', nodeOutputs: new Map(), variables: new Map(), workingDirectory: sdk.cwd },
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

let emptyDir: string | undefined;
/** none 權限用的空目錄：SDK 的 cwd 預設是 process.cwd()，不能讓沒有 workspace 的 agent 落在 server 目錄 */
function noWorkspaceDir() {
  if (!emptyDir || !fs.existsSync(emptyDir)) emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-no-workspace-'));
  return emptyDir;
}

/**
 * workspace 權限 → Claude Agent SDK Options（依 @anthropic-ai/claude-agent-sdk sdk.d.ts）：
 * - cwd：read / write = workspace；none = 空的暫存目錄
 * - tools：可用的內建工具清單（[] = 關掉所有內建工具）
 * - disallowedTools：被權限拿掉的工具（從 model context 移除）
 * - permissionMode：write = 'acceptEdits'（自動接受 workspace 內的編輯）；none / read = 'dontAsk'（沒在 allowedTools 的一律拒絕，不會跳出詢問）
 * 注意：Bash 沒有被 sandbox 在 workspace 內（SDK 的 cwd 只是起始目錄）。
 */
export function sdkPermissionOptions(req: Pick<AgentRunRequest, 'workspaceAccess' | 'workingDirectory' | 'allowedTools' | 'disallowedTools'>): Record<string, unknown> & { cwd: string } {
  const write = req.workspaceAccess === 'write';
  if (req.workspaceAccess !== 'none' && !req.workingDirectory) throw new Error(`workspace access "${req.workspaceAccess}" needs a workingDirectory`);
  return {
    cwd: req.workspaceAccess === 'none' ? noWorkspaceDir() : req.workingDirectory!,
    tools: req.allowedTools,
    disallowedTools: req.disallowedTools,
    permissionMode: write ? 'acceptEdits' : 'dontAsk',
  };
}
