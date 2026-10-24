import type { RuleOp } from './rules.js';
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
  /** 是否允許 workflow 實例在 node.ports 動態宣告 port（start / end / loop / foreach / set ...） */
  dynamic_ports?: boolean;
  /** 允許實例用 node.ports.outputs.<name> 收窄型別的 any 輸出（例如 transform.result、http_request.body） */
  output_overrides?: string[];
  /** 節點實例 config 的 JSON Schema：compiler 用 Ajv 驗證、前端屬性面板依此產生表單 */
  config_schema?: JSONSchema;
  /** agent：實例可以覆寫的 config 欄位（預設 max_turns / timeout_seconds / retry）；權限欄位永遠不行 */
  instance_overridable?: string[];
  /** 從哪個檔案載入（除錯用） */
  source?: string;
  /**
   * 分層：v1 = 預設可用的精簡節點；advanced = 需開啟 advanced 旗標；internal = 使用者不直接建立（loop_in / loop_out）。
   * agent 節點預設 v1。
   */
  tier?: NodeTier;
}

export type NodeTier = 'v1' | 'advanced' | 'internal';

export interface PortRef {
  node: string;
  port: string;
}

/**
 * 內部（正規化後）的 edge。v1 檔案格式只有資料連線，可寫成字串 "a.port -> b.port"，
 * 載入時（dsl.ts normalizeWorkflow）轉成 {kind:'data', from, to}；kind:'control' 只存在舊版（advanced）格式。
 */
export interface Edge {
  kind: 'data' | 'control';
  from: PortRef;
  to: PortRef;
}

export interface Rule {
  op: RuleOp;
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
  /** 1 = v1 精簡 DSL（只有資料連線，執行順序由資料相依推導）；省略 = 舊版 hybrid（data + control edges，advanced） */
  version?: 1;
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
  /** resume 時沿用先前 run 的結果、沒有重新執行 */
  resumed_from?: string;
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
    | 'loop_iteration_completed'
    | 'subflow_started'
    | 'log';
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
