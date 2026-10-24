import type { AgentEvent, JSONSchema, NodeDefinition, Scope, TokenUsage } from '../types.js';

export interface AgentRunRequest {
  def: NodeDefinition;
  nodeId: string;
  inputs: Record<string, unknown>;
  prompt: string;
  /** 由 output ports 組成的 object schema，交給 SDK 的 structured output */
  outputSchema: JSONSchema;
  scope: Scope;
  iteration: number | null;
  attempt: number;
  signal: AbortSignal;
  workingDirectory: string;
}

export interface AgentRunResult {
  outputs: Record<string, unknown>;
  events: AgentEvent[];
  usage?: TokenUsage;
}

/** Agent Runtime Adapter：Claude Agent SDK、Mock、未來的其他 SDK（Python ADK 等）都實作這個介面 */
export interface AgentRuntime {
  name: string;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
