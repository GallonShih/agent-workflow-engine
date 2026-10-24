// Shim：只保留 Circuit backend/src/workflows/types.ts 中 agents/claude.ts、base.ts 會用到的型別
// （欄位名稱與 upstream 相同，方便之後同步 upstream）。
export interface ExecutionContext {
  workflowId: string;
  executionId: string;
  nodeOutputs: Map<string, unknown>;
  variables: Map<string, unknown>;
  workingDirectory: string;
}
export interface AgentTodoItem { text: string; completed: boolean }
export type AgentEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'tool-use'; id?: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; name: string; result: string }
  | { type: 'thinking'; content: string }
  | { type: 'todo-list'; items: AgentTodoItem[] }
  | { type: 'complete'; result: string }
  | { type: 'error'; message: string }
  | { type: 'run-start'; runCount: number; nodeName: string }
  // PoC 新增：result message 的用量（上游沒有這個事件）
  | { type: 'usage'; input_tokens: number; output_tokens: number; cost_usd?: number; num_turns?: number };
export type AgentOutputFormat = 'text' | 'json';
export interface AgentOutputConfig { format?: AgentOutputFormat; filePath?: string; schema?: string }
export interface AgentInput {
  prompt: string;
  context?: Record<string, unknown>;
  previousOutputs?: Record<string, unknown>;
  workingDirectory?: string;
  sessionId?: string;
  outputConfig?: AgentOutputConfig;
  requiresJsonOutput?: boolean;
}
export interface AgentStructuredOutput { format: AgentOutputFormat; filePath: string; content: string; parsedJson?: unknown }
export interface ClaudeNodeConfig {
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  maxTurns?: number;
}
