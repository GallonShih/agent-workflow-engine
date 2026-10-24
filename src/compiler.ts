import type { DataPortDef, Edge, LoopConfig, NodeDefinition, WorkflowGraph, WorkflowNode } from './types.js';
import type { NodeRegistry } from './registry.js';
import { isCompatible, typeLabel, validateValue } from './schema.js';
import { evalRule } from './rules.js';
import { builtins, type PortSet } from './nodes/builtins.js';
import { normalizeWorkflow, isV1 } from './dsl.js';
import { maxPermission, permissionOf, type WorkspacePermission } from './workspace-policy.js';
import { tierOf } from './registry.js';
import { fixFor, closest, V1_ALTERNATIVES } from './fixes.js';

export { evalRule };

/** 編譯後的節點：定義 + 實例 + 解析後的「有效 ports」（含 dynamic ports） */
export interface CompiledNode {
  id: string;
  node: WorkflowNode;
  def: NodeDefinition;
  inputs: Record<string, DataPortDef>;
  outputs: Record<string, DataPortDef>;
  controlInputs: string[];
  controlOutputs: string[];
  body?: CompiledGraph; // loop composite
}

export interface CompiledGraph {
  nodes: Map<string, CompiledNode>;
  edges: Edge[];
  /** v1：沒有 control edge，engine 依資料相依排程 */
  v1?: boolean;
  /** 以 advanced 旗標編譯（engine 才允許 foreach / subflow / join 等進階行為） */
  advanced?: boolean;
}

export interface CompileOptions {
  /** 開啟進階功能：舊版 hybrid 格式（control edges）、advanced 節點、巢狀 loop、loop carry / on_body_failure */
  advanced?: boolean;
  /**
   * 這次 run 有沒有 workspace：false = 沒有 → 需要 read / write 的 agent 節點會產生 WORKSPACE_REQUIRED 錯誤；
   * undefined = 不檢查（例如只是驗證），結果的 workspace_required 仍會列出需求。
   */
  workspace?: boolean;
}

export interface Diagnostic {
  code: string;
  message: string;
  node?: string;
  edge?: number;
  path?: string;
  /** 具體的修正建議（給人與 MCP agent 看） */
  fix?: string;
}

export interface CompileResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  graph?: CompiledGraph;
  /** 正規化後的 workflow（v1 字串 edges 已展開） */
  workflow?: WorkflowGraph;
  /** workflow 需要的 workspace 權限（所有 scope 的 agent 節點取最高）與需要的節點 */
  workspace_required: WorkspacePermission;
  workspace_nodes: { node: string; access: WorkspacePermission }[];
}

/** 不允許 Workflow JSON（例如 Planner 產生的）覆寫的安全相關欄位：權限只能來自 Node Registry */
const POLICY_FIELDS = ['runtime', 'allowed_tools', 'mcp', 'skills', 'system_prompt', 'model', 'workspace'];

/** composite（loop / foreach）的 body 看到的 ports：loop_in 的輸出與 loop_out 的輸入 */
export interface BodyPorts {
  bodyIn: Record<string, DataPortDef>;
  bodyOut: Record<string, DataPortDef>;
}
export type ResolvedPorts = PortSet & { body?: BodyPorts };

const COMPOSITES = ['loop', 'foreach'];

/**
 * 解析一個節點實例實際的 ports：
 * - start / end / template / set / loop / foreach / subflow 的 dynamic ports（node.ports）
 * - loop_in / loop_out 繼承所在 composite 的 body ports
 * - output_overrides：實例可收窄 any 輸出的型別（transform.result、http_request.body ...）
 * - builtins[type].ports：依 config 產生 ports（Merge 輸入數、Switch cases、Join 輸入數 ...）
 * Compiler 與前端 Rete editor / 屬性面板共用，兩邊看到的 port / 型別一致。
 */
export function resolveNodePorts(n: WorkflowNode, def: NodeDefinition, registry: NodeRegistry, body?: BodyPorts, opts: { v1?: boolean } = {}): ResolvedPorts {
  let ports: ResolvedPorts = { inputs: def.inputs, outputs: def.outputs, controlInputs: def.control_inputs, controlOutputs: def.control_outputs };
  const dynIn = n.ports?.inputs ? registry.normalizePorts(n.ports.inputs, `${n.id}.ports.inputs`) : {};
  const dynOut = n.ports?.outputs ? registry.normalizePorts(n.ports.outputs, `${n.id}.ports.outputs`) : {};
  const integer = { schema: { type: 'integer' } };
  switch (n.type) {
    case 'start':
    case 'set':
      ports.outputs = dynOut;
      break;
    case 'end':
      ports.inputs = Object.fromEntries(Object.entries(dynIn).map(([k, p]) => [k, { ...p, required: p.required ?? false }]));
      break;
    case 'template':
      ports.inputs = dynIn;
      break;
    case 'subflow':
      ports.inputs = dynIn;
      ports.outputs = dynOut;
      break;
    case 'loop':
      ports.inputs = dynIn;
      ports.outputs = { ...dynOut, iterations: integer };
      ports.body = { bodyIn: { ...dynIn, iteration: integer }, bodyOut: dynOut };
      break;
    case 'foreach': {
      const items = dynIn.items ?? def.inputs.items;
      const extra = Object.fromEntries(Object.entries(dynIn).filter(([k]) => k !== 'items'));
      ports.inputs = { items, ...extra };
      ports.outputs = {
        ...Object.fromEntries(Object.entries(dynOut).map(([k, p]) => [k, { schema: { type: 'array', items: p.schema } }])),
        count: integer,
      };
      ports.body = { bodyIn: { ...extra, item: { schema: (items.schema.items as Record<string, unknown>) ?? {} }, index: integer }, bodyOut: dynOut };
      break;
    }
    case 'loop_in':
      ports.outputs = body?.bodyIn ?? {};
      break;
    case 'loop_out':
      ports.inputs = body?.bodyOut ?? {};
      break;
  }
  for (const k of def.output_overrides ?? []) if (dynOut[k] && def.outputs[k]) ports.outputs = { ...ports.outputs, [k]: dynOut[k] };
  const spec = builtins[n.type];
  if (spec?.ports) ports = { ...spec.ports(n.config ?? {}, ports), body: ports.body };
  if (opts.v1) {
    // v1：沒有 control ports。condition 用資料路由（true / false 輸出），loop 多一個 done 輸出
    ports = { ...ports, controlInputs: [], controlOutputs: [] };
    if (n.type === 'condition') ports.outputs = { true: { schema: {}, required: false }, false: { schema: {}, required: false } };
    if (n.type === 'loop') ports.outputs = { ...ports.outputs, done: { schema: { type: 'boolean' } } };
  }
  return ports;
}

/**
 * v1 condition 的 true / false 輸出型別 = 接到 data（沒有就 value）的上游輸出型別。
 * compiler 與前端 editor 共用（前端連線檢查才會跟 compiler 一致）。
 */
export function inferPassThroughTypes(nodes: Map<string, { node: WorkflowNode; outputs: Record<string, DataPortDef> }>, edges: Edge[]): void {
  for (let pass = 0; pass < 4; pass++) {
    for (const [id, cn] of nodes) {
      if (cn.node.type !== 'condition' || !('true' in cn.outputs)) continue;
      const e = edges.find((x) => x.kind === 'data' && x.to.node === id && x.to.port === 'data') ?? edges.find((x) => x.kind === 'data' && x.to.node === id && x.to.port === 'value');
      const schema = e ? nodes.get(e.from.node)?.outputs[e.from.port]?.schema : undefined;
      if (schema) cn.outputs = { true: { schema, required: false }, false: { schema, required: false } };
    }
  }
}

/**
 * Graph Compiler：Workflow JSON → CompiledGraph。
 * 檢查 unknown node/port、edge kind、Ajv/JSON Schema 型別相容、必填輸入、常數值、fan-in、
 * 外層 DAG cycle、builtin 設定（condition/join/loop），並遞迴編譯 loop body。
 */
export function compileWorkflow(raw: WorkflowGraph | unknown, registry: NodeRegistry, opts: CompileOptions = {}): CompileResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const v1 = isV1(raw);
  const advanced = !!opts.advanced;
  const { graph: wf, errors: edgeErrors } = normalizeWorkflow(raw);
  for (const e of edgeErrors) errors.push({ code: 'INVALID_EDGE', message: `${e.path}edges[${e.index}]: ${e.message}`, edge: e.index, path: e.path, fix: e.fix });
  if (!v1 && !advanced && raw && typeof raw === 'object') {
    errors.push({
      code: 'LEGACY_FORMAT',
      message: 'workflow is not v1 (missing "version": 1); the hybrid data+control format is an advanced feature',
      path: '',
      fix: 'Add "version": 1 and write edges as data connections only, e.g. "edges": ["start.request -> planner.request"]. Existing files can be converted with `npm run convert -- <file>` (convertToV1).',
    });
  }
  const ctx: Ctx = { registry, errors, warnings, v1, advanced, all: [] };
  const graph = compileGraph(wf, ctx, '', undefined);
  const workspace_nodes = ctx.all.flatMap(({ prefix, nodes }) =>
    [...nodes.values()].map((cn) => ({ node: prefix + cn.id, access: permissionOf(cn.def) })).filter((x) => x.access !== 'none'),
  );
  const workspace_required = workspace_nodes.reduce<WorkspacePermission>((a, x) => maxPermission(a, x.access), 'none');
  if (opts.workspace === false && workspace_required !== 'none')
    errors.push({
      code: 'WORKSPACE_REQUIRED',
      message: `workflow needs a workspace (${workspace_nodes.map((x) => `${x.node}: ${x.access}`).join(', ')}) but this run has none`,
      path: '',
      fix: 'Pass "workspace": "/absolute/path/to/your/repo" when running (REST body, MCP run_workflow, CLI --workspace, or the UI workspace field). The path must be inside WORKSPACE_ROOTS.',
    });
  for (const d of errors) d.fix ??= fixFor(d, ctx);
  for (const d of warnings) d.fix ??= fixFor(d, ctx);
  return { ok: errors.length === 0, errors, warnings, graph: errors.length === 0 ? graph : undefined, workflow: wf, workspace_required, workspace_nodes };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** 不信任的 JSON（API / MCP 傳入）：形狀不對的 node / edge 回報錯誤後丟掉，避免後續編譯 throw */
function sanitizeShape(wf: WorkflowGraph, err: (code: string, message: string, extra?: Partial<Diagnostic>) => void): WorkflowGraph {
  const nodes = wf.nodes.filter((n, i) => {
    if (!isObj(n) || typeof n.id !== 'string' || typeof n.type !== 'string') {
      err('INVALID_NODE', `nodes[${i}] must be an object with string "id" and "type"`, { fix: 'e.g. {"id": "planner", "type": "planner_agent", "config": {}}' });
      return false;
    }
    if ((n.config !== undefined && n.config !== null && !isObj(n.config)) || (n.ports !== undefined && !isObj(n.ports))) {
      err('INVALID_NODE', `node "${n.id}": "config" / "ports" must be objects`, { node: n.id });
      return false;
    }
    return true;
  });
  const endpoint = (x: unknown) => isObj(x) && typeof x.node === 'string' && (x.port === undefined || typeof x.port === 'string');
  const edges = wf.edges.filter((e, i) => {
    if (isObj(e) && endpoint(e.from) && endpoint(e.to)) return true;
    err('INVALID_EDGE', `edges[${i}] must be {from: {node, port}, to: {node, port}}`, { edge: i });
    return false;
  });
  return nodes.length === wf.nodes.length && edges.length === wf.edges.length ? wf : { ...wf, nodes, edges };
}

export interface Ctx {
  registry: NodeRegistry;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  v1: boolean;
  advanced: boolean;
  /** 所有 scope 的節點（產生修正建議用） */
  all: { prefix: string; nodes: Map<string, CompiledNode>; edges: Edge[] }[];
}

function compileGraph(wf: WorkflowGraph, ctx: Ctx, prefix: string, loop: BodyPorts | undefined): CompiledGraph {
  const { registry, errors, warnings, v1, advanced } = ctx;
  const err = (code: string, message: string, extra: Partial<Diagnostic> = {}) =>
    errors.push({ code, message: prefix + message, ...extra, node: extra.node ? prefix + extra.node : undefined, path: prefix });
  const nodes = new Map<string, CompiledNode>();

  if (!Array.isArray(wf?.nodes) || !Array.isArray(wf?.edges)) {
    err('INVALID_WORKFLOW', 'workflow must have nodes[] and edges[]', { fix: 'A workflow is {"version": 1, "nodes": [{"id": "start", "type": "start", ...}], "edges": ["a.out -> b.in"]}.' });
    return { nodes, edges: [] };
  }
  wf = sanitizeShape(wf, err);
  ctx.all.push({ prefix, nodes, edges: wf.edges });

  for (const n of wf.nodes) {
    if (!n.id || nodes.has(n.id)) {
      err('DUPLICATE_NODE', `node id "${n.id}" is missing or duplicated`, { node: n.id });
      continue;
    }
    const def = registry.get(n.type);
    if (!def) {
      err('UNKNOWN_NODE_TYPE', `node "${n.id}" uses unknown type "${n.type}" (not in Node Registry)`, { node: n.id });
      continue;
    }
    const tier = tierOf(def);
    if (tier === 'advanced' && !advanced)
      err('NODE_NOT_IN_V1', `node "${n.id}" uses "${n.type}", an advanced node (not enabled in v1)`, { node: n.id, fix: V1_ALTERNATIVES[n.type] ?? `Use one of the v1 node types (list_node_types), or enable advanced mode.` });
    if (v1 && (n.type === 'join' || n.type === 'switch'))
      err('NODE_NOT_IN_V1', `node "${n.id}": "${n.type}" only exists in the legacy control-edge format`, { node: n.id, fix: V1_ALTERNATIVES[n.type] });
    if (v1 && n.type === 'loop' && loop && !advanced)
      err('NESTED_LOOP_NOT_IN_V1', `loop "${n.id}" is nested inside another loop body (nested loops are an advanced feature)`, { node: n.id, fix: 'Flatten it: use a single loop whose body contains all the steps, or enable advanced mode.' });
    for (const f of POLICY_FIELDS) {
      if (n.config && f in n.config) err('POLICY_OVERRIDE', `node "${n.id}" may not override "${f}" — permissions come from the Node Registry`, { node: n.id });
    }
    if ((n.type === 'loop_in' || n.type === 'loop_out') && !loop) err('LOOP_PORT_OUTSIDE_LOOP', `"${n.type}" is only allowed inside a loop body`, { node: n.id });
    if (n.ports && !def.dynamic_ports) {
      const allowed = def.output_overrides ?? [];
      const bad = [...Object.keys(n.ports.inputs ?? {}), ...Object.keys(n.ports.outputs ?? {}).filter((k) => !allowed.includes(k))];
      if (bad.length || n.ports.inputs)
        err('DYNAMIC_PORTS_NOT_ALLOWED', `node type "${n.type}" does not allow dynamic ports${allowed.length ? ` (only ports.outputs.{${allowed.join(',')}} may narrow types)` : ''}`, { node: n.id });
    }

    // 實例 config 用 registry 的 config_schema（Ajv）驗證；agent 的權限欄位另由 POLICY_OVERRIDE 報錯
    if (def.config_schema) {
      const cfg = Object.fromEntries(Object.entries(n.config ?? {}).filter(([k]) => !(def.kind === 'agent' && POLICY_FIELDS.includes(k))));
      const v = validateValue(def.config_schema, cfg);
      if (!v.ok) err('INVALID_CONFIG', `${n.type} "${n.id}" config: ${String(v.errors).replace(/\bdata\b/g, "config")}`, { node: n.id });
    }

    let ports: ResolvedPorts = { inputs: def.inputs, outputs: def.outputs, controlInputs: def.control_inputs, controlOutputs: def.control_outputs };
    try {
      ports = resolveNodePorts(n, def, registry, loop, { v1 });
    } catch (e) {
      err('INVALID_PORT_SCHEMA', (e as Error).message, { node: n.id });
    }
    const cn: CompiledNode = { id: n.id, node: n, def, inputs: ports.inputs, outputs: ports.outputs, controlInputs: ports.controlInputs, controlOutputs: ports.controlOutputs };
    for (const m of builtins[n.type]?.check?.(n.config ?? {}, ports) ?? []) err('INVALID_CONFIG', `${n.type} "${n.id}": ${m}`, { node: n.id });
    if (COMPOSITES.includes(n.type)) {
      if (!n.body) err('LOOP_WITHOUT_BODY', `${n.type} "${n.id}" needs a body subgraph`, { node: n.id });
      else {
        cn.body = compileGraph(n.body, ctx, `${prefix}${n.id}.body/`, ports.body);
        const types = n.body.nodes.map((b) => b.type);
        if (types.filter((t) => t === 'loop_in').length !== 1 || types.filter((t) => t === 'loop_out').length !== 1)
          err('LOOP_BODY_PORTS', `${n.type} "${n.id}" body needs exactly one loop_in and one loop_out`, { node: n.id });
      }
      if (n.type === 'loop') checkLoopConfig(cn, err, ctx);
    }
    nodes.set(n.id, cn);
  }
  if (v1) inferPassThroughTypes(nodes, wf.edges);

  // ---- edges ----
  const dataIn = new Map<string, number>();
  wf.edges.forEach((e, i) => {
    const src = nodes.get(e.from?.node);
    const dst = nodes.get(e.to?.node);
    if (!src || !dst) {
      if (!src) err('UNKNOWN_EDGE_NODE', `edge #${i} references unknown node "${e.from?.node}"`, { edge: i });
      if (!dst) err('UNKNOWN_EDGE_NODE', `edge #${i} references unknown node "${e.to?.node}"`, { edge: i });
      return;
    }
    const label = `${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`;
    if (v1 && e.kind !== 'data') {
      err('CONTROL_EDGE_IN_V1', `edge #${i} ${label} is a control edge; v1 has data connections only`, { edge: i, fix: 'Remove it. A node runs when all its connected inputs have values; connect a data output instead.' });
    } else if (e.kind === 'data') {
      const out = src.outputs[e.from.port];
      const inp = dst.inputs[e.to.port];
      if (!out) err(src.controlOutputs.includes(e.from.port) ? 'EDGE_KIND_MISMATCH' : 'UNKNOWN_PORT', `data edge ${label}: "${e.from.port}" is not a data output of ${src.def.name}`, { edge: i });
      if (!inp) err(dst.controlInputs.includes(e.to.port) ? 'EDGE_KIND_MISMATCH' : 'UNKNOWN_PORT', `data edge ${label}: "${e.to.port}" is not a data input of ${dst.def.name}`, { edge: i });
      if (out && inp) {
        const c = isCompatible(out.schema, inp.schema);
        if (!c.ok) err('TYPE_MISMATCH', `data edge ${label}: ${typeLabel(out.schema)} → ${typeLabel(inp.schema)} incompatible (${c.reason})`, { edge: i });
        const k = `${e.to.node}.${e.to.port}`;
        dataIn.set(k, (dataIn.get(k) ?? 0) + 1);
        if (dataIn.get(k)! > 1 && !inp.multiple && !v1) err('MULTIPLE_DATA_INPUTS', `input ${k} already has a data edge (set multiple: true to collect)`, { edge: i });
      }
    } else if (e.kind === 'control') {
      if (!src.controlOutputs.includes(e.from.port)) err(src.outputs[e.from.port] ? 'EDGE_KIND_MISMATCH' : 'UNKNOWN_PORT', `control edge ${label}: "${e.from.port}" is not a control output of ${src.def.name} (${src.controlOutputs.join(', ') || 'none'})`, { edge: i });
      if (!dst.controlInputs.includes(e.to.port)) err(dst.inputs[e.to.port] ? 'EDGE_KIND_MISMATCH' : 'UNKNOWN_PORT', `control edge ${label}: "${e.to.port}" is not a control input of ${dst.def.name} (${dst.controlInputs.join(', ') || 'none'})`, { edge: i });
      if (dst.def.mode === 'data') err('EDGE_KIND_MISMATCH', `control edge ${label}: ${dst.def.name} is a pure data node`, { edge: i });
    } else {
      err('INVALID_EDGE_KIND', `edge #${i} kind must be "data" or "control"`, { edge: i });
    }
  });

  // ---- required inputs & constants ----
  for (const cn of nodes.values()) {
    for (const [name, port] of Object.entries(cn.inputs)) {
      const connected = dataIn.has(`${cn.id}.${name}`);
      const constant = cn.node.inputs?.[name];
      if (constant !== undefined) {
        const v = validateValue(port.schema, constant);
        if (!v.ok) err('INVALID_CONSTANT', `node "${cn.id}" constant input "${name}": ${v.errors}`, { node: cn.id });
      }
      if (port.required !== false && port.default === undefined && constant === undefined && !connected)
        err('MISSING_REQUIRED_INPUT', `node "${cn.id}" (${cn.def.name}) required input "${name}: ${typeLabel(port.schema)}" is not connected`, { node: cn.id });
    }
    if (v1 && cn.def.name === 'end' && !wf.edges.some((e) => e.to.node === cn.id))
      err('END_UNCONNECTED', `end node "${cn.id}" has no incoming connection — it would finish the run immediately`, { node: cn.id });
    const hasControlIn = wf.edges.some((e) => e.kind === 'control' && e.to.node === cn.id);
    if (!v1 && cn.def.mode === 'control' && cn.controlInputs.length > 0 && !hasControlIn)
      warnings.push({ code: 'ENTRY_NODE', message: `${prefix}node "${cn.id}" has no incoming control edge — it runs as an entry node`, node: prefix + cn.id, path: prefix });
  }

  // ---- 外層 DAG：不允許 cycle（Loop 必須用 composite node 表達） ----
  const cycle = findCycle([...nodes.keys()], wf.edges.filter((e) => nodes.has(e.from.node) && nodes.has(e.to.node)));
  if (cycle) err('CYCLE', `cycle detected: ${cycle.join(' → ')} (use a loop composite node instead of a back-edge)`);

  return { nodes, edges: wf.edges.filter((e) => nodes.has(e.from?.node) && nodes.has(e.to?.node)), v1: v1 || undefined, advanced: advanced || undefined };
}

function checkLoopConfig(cn: CompiledNode, err: (c: string, m: string, x?: Partial<Diagnostic>) => void, ctx: Ctx) {
  const cfg = (cn.node.config ?? {}) as unknown as LoopConfig;
  if (cfg.until !== undefined && (!isObj(cfg.until) || typeof cfg.until.port !== 'string')) {
    err('INVALID_CONFIG', `loop "${cn.id}": until must be a rule object {port, op, value}`, { node: cn.id });
    return;
  }
  if (cfg.carry !== undefined && (!Array.isArray(cfg.carry) || !cfg.carry.every((c) => isObj(c) && typeof c.from === 'string' && typeof c.to === 'string'))) {
    err('INVALID_CONFIG', `loop "${cn.id}": carry must be an array of {from, to}`, { node: cn.id });
    return;
  }
  if (cfg.until) {
    if (!cn.outputs[cfg.until.port])
      err('INVALID_CONFIG', `loop "${cn.id}": until.port "${cfg.until.port}" is not a loop output`, { node: cn.id, fix: `until.port must be one of the loop outputs: ${Object.keys(cn.outputs).join(', ')}${closest(cfg.until.port, Object.keys(cn.outputs)) ? ` (did you mean "${closest(cfg.until.port, Object.keys(cn.outputs))}"?)` : ''}` });
  }
  if (ctx.v1) {
    const declared = Object.keys((cn.node.ports?.outputs ?? {}) as object);
    if (declared.includes('done')) err('INVALID_PORT_SCHEMA', `loop "${cn.id}": output name "done" is reserved in v1 (true when until was met)`, { node: cn.id, fix: 'Rename the loop output.' });
    if (!ctx.advanced) {
      if (cfg.carry) err('V1_LOOP_CONFIG', `loop "${cn.id}": config.carry is an advanced option`, { node: cn.id, fix: 'Remove config.carry. In v1, a loop output with the same name as a loop input (e.g. "feedback") is passed into the next iteration automatically.' });
      if (cfg.on_body_failure) err('V1_LOOP_CONFIG', `loop "${cn.id}": config.on_body_failure is an advanced option`, { node: cn.id, fix: 'Remove config.on_body_failure (v1: a failing iteration fails the loop; agent nodes already retry via config.retry).' });
    }
    for (const name of Object.keys(cn.outputs).filter((k) => k in cn.inputs && k !== 'iterations' && k !== 'done')) {
      const ok = isCompatible(cn.outputs[name].schema, cn.inputs[name].schema);
      if (!ok.ok) err('TYPE_MISMATCH', `loop "${cn.id}": output "${name}" is fed back into input "${name}" next iteration but types differ (${ok.reason})`, { node: cn.id, fix: `Give the loop output and input "${name}" the same type, or rename one of them.` });
    }
  }
  for (const c of cfg.carry ?? []) {
    const from = cn.outputs[c.from];
    const to = cn.inputs[c.to];
    if (!from || !to) {
      err('INVALID_CONFIG', `loop "${cn.id}": carry ${c.from} → ${c.to} must map a loop output to a loop input`, { node: cn.id });
      continue;
    }
    const ok = isCompatible(from.schema, to.schema);
    if (!ok.ok) err('TYPE_MISMATCH', `loop "${cn.id}": carry ${c.from} → ${c.to}: ${ok.reason}`, { node: cn.id });
  }
}

export function findCycle(ids: string[], edges: Edge[]): string[] | null {
  const adj = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of edges) adj.get(e.from.node)?.push(e.to.node);
  const color = new Map<string, number>();
  const stack: string[] = [];
  const dfs = (u: string): string[] | null => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === 1) return [...stack.slice(stack.indexOf(v)), v];
      if (!color.get(v)) {
        const c = dfs(v);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  };
  for (const id of ids) if (!color.get(id)) {
    const c = dfs(id);
    if (c) return c;
  }
  return null;
}

