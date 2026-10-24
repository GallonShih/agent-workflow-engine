import type { AgentEvent, JSONSchema, NodeDefinition, Scope, TokenUsage } from '../types.js';
import type { WorkspacePermission } from '../workspace-policy.js';

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
  /** 只有 workspace 權限是 read / write 時才有（none = undefined，不可退回 process.cwd()） */
  workingDirectory?: string;
  /** registry 定義的 workspace 權限 */
  workspaceAccess: WorkspacePermission;
  /** 依權限過濾後的 allowed_tools（runtime 必須用這個，不是 def.allowed_tools） */
  allowedTools: string[];
  /** 被權限拿掉的工具（Claude runtime 放進 disallowedTools） */
  disallowedTools: string[];
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
