/**
 * 三種獨立資料結構（需求文件「四、Graph Definition」）：
 *   1. NodeDefinition   — Node Registry 裡可重複使用的節點定義（YAML/JSON）
 *   2. WorkflowGraph    — Workflow JSON DSL（節點實例 + data/control edges）
 *   3. Run state        — 執行狀態，以 run_id + scope(loop iteration) + node_id 為鍵
 */

export type JSONSchema = Record<string, unknown>;

export interface DataPortDef {
  schema: JSONSchema;
  /** 預設 true：必填輸入在執行前必須有值 */
  required?: boolean;
  /** 允許多條 data edge 匯入（值會收集成陣列，類似 Rete dataflow 的 input array） */
  multiple?: boolean;
  description?: string;
  default?: unknown;
}

export type NodeKind = 'agent' | 'builtin';
/**
 * control：需要 control edge 觸發（沒有 incoming control edge 的就是入口節點）
 * data：純資料節點（無副作用），下游需要時才 lazy 計算（Rete DataflowEngine 的 pull 語意）
 */
export type ExecMode = 'control' | 'data';

export interface RetryPolicy {
  max_attempts: number; // 含第一次
  backoff_ms?: number;
}

export interface AgentConfig {
  max_turns?: number;
  timeout_seconds?: number;
  retry?: RetryPolicy;
}

export interface NodeDefinition {
  name: string;
  version: number;
  kind: NodeKind;
  mode: ExecMode;
  description?: string;
  category?: string;
  // ---- agent 專屬 ----
  runtime?: 'claude_agent_sdk' | 'mock' | string;
  model?: string;
  system_prompt?: string;
  prompt?: string;
  mcp?: string[];
  skills?: string[];
  allowed_tools?: string[];
  config?: AgentConfig;
  // ---- ports ----
  inputs: Record<string, DataPortDef>;
  outputs: Record<string, DataPortDef>;
  control_inputs: string[];
  control_outputs: string[];
  /** 是否允許 workflow 實例在 node.ports 動態宣告 port（Loop 用） */
  dynamic_ports?: boolean;
  /** 從哪個檔案載入（除錯用） */
  source?: string;
}

export interface PortRef {
  node: string;
  port: string;
}

export interface Edge {
  kind: 'data' | 'control';
  from: PortRef;
  to: PortRef;
}

export interface Rule {
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'truthy' | 'falsy' | 'contains' | 'is_empty' | 'not_empty';
  value?: unknown;
  /** 讀取物件內欄位，例如 "summary.passed" */
  path?: string;
}

export interface LoopConfig {
  max_iterations: number;
  /** 終止條件：對 loop_out 的某個 port 套用規則，成立就結束 */
  until?: { port: string } & Rule;
  /** 上一輪 loop_out.from → 下一輪 loop_in.to（例如 failures → feedback） */
  carry?: { from: string; to: string }[];
  /** body 失敗時：fail = 整個 loop 失敗；continue = 算一輪，繼續重試 */
  on_body_failure?: 'fail' | 'continue';
}

export interface WorkflowNode {
  id: string;
  type: string;
  label?: string;
  /** 常數輸入值（沒有接 data edge 時使用） */
  inputs?: Record<string, unknown>;
  /** builtin 節點參數（condition rules、template、join policy、loop config...） */
  config?: Record<string, unknown>;
  /** dynamic ports（目前只給 loop / start / end 使用） */
  ports?: { inputs?: Record<string, DataPortDef | JSONSchema>; outputs?: Record<string, DataPortDef | JSONSchema> };
  /** 編輯器座標（Rete editor 存檔用，engine 不看） */
  ui?: { x: number; y: number };
  /** loop composite 的內部子圖 */
  body?: WorkflowGraph;
}

export interface WorkflowGraph {
  id?: string;
  name?: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: Edge[];
}

export type NodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

/** 迴圈作用域，例如 [{loop:'fix_loop', iteration:1}] */
export type Scope = { loop: string; iteration: number }[];

export interface NodeRunRecord {
  run_id: string;
  node_id: string;
  scope: Scope;
  /** run_id/scopeKey/node_id，例如 run_x/fix_loop#1/coder */
  key: string;
  iteration: number | null;
  status: NodeStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  fired?: string[];
  error?: string;
  attempts?: number;
  started_at?: number;
  duration_ms?: number;
  token_usage?: TokenUsage;
  runtime?: string;
  agent_events?: AgentEvent[];
}

// Agent 事件格式直接沿用 Circuit（src/vendor/circuit/workflows/types.ts）
export type { AgentEvent } from './vendor/circuit/workflows/types.js';
import type { AgentEvent } from './vendor/circuit/workflows/types.js';

export interface RunEvent {
  seq: number;
  ts: number;
  run_id: string;
  type:
    | 'run_started'
    | 'run_completed'
    | 'node_triggered'
    | 'node_started'
    | 'node_succeeded'
    | 'node_failed'
    | 'node_skipped'
    | 'node_retry'
    | 'control_fired'
    | 'agent_event'
    | 'loop_iteration_started'
    | 'loop_iteration_completed';
  node_id?: string;
  key?: string;
  scope?: Scope;
  data?: Record<string, unknown>;
}

export interface RunResult {
  run_id: string;
  status: 'success' | 'failed';
  records: NodeRunRecord[];
  events: RunEvent[];
  duration_ms: number;
  token_usage: TokenUsage;
}
