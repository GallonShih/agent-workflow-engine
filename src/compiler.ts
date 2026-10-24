import type { DataPortDef, Edge, LoopConfig, NodeDefinition, Rule, WorkflowGraph, WorkflowNode } from './types.js';
import type { NodeRegistry } from './registry.js';
import { isCompatible, typeLabel, validateValue } from './schema.js';
import { evalRule } from './rules.js';
import { builtins, type PortSet } from './nodes/builtins.js';

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
}

export interface Diagnostic {
  code: string;
  message: string;
  node?: string;
  edge?: number;
  path?: string;
}

export interface CompileResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  graph?: CompiledGraph;
}

/** 不允許 Workflow JSON（例如 Planner 產生的）覆寫的安全相關欄位：權限只能來自 Node Registry */
const POLICY_FIELDS = ['runtime', 'allowed_tools', 'mcp', 'skills', 'system_prompt', 'model'];

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
export function resolveNodePorts(n: WorkflowNode, def: NodeDefinition, registry: NodeRegistry, body?: BodyPorts): ResolvedPorts {
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
  return ports;
}

/**
 * Graph Compiler：Workflow JSON → CompiledGraph。
 * 檢查 unknown node/port、edge kind、Ajv/JSON Schema 型別相容、必填輸入、常數值、fan-in、
 * 外層 DAG cycle、builtin 設定（condition/join/loop），並遞迴編譯 loop body。
 */
export function compileWorkflow(wf: WorkflowGraph, registry: NodeRegistry): CompileResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const graph = compileGraph(wf, registry, errors, warnings, '', undefined);
  return { ok: errors.length === 0, errors, warnings, graph: errors.length === 0 ? graph : undefined };
}

function compileGraph(
  wf: WorkflowGraph,
  registry: NodeRegistry,
  errors: Diagnostic[],
  warnings: Diagnostic[],
  prefix: string,
  loop: BodyPorts | undefined,
): CompiledGraph {
  const err = (code: string, message: string, extra: Partial<Diagnostic> = {}) =>
    errors.push({ code, message: prefix + message, ...extra, node: extra.node ? prefix + extra.node : undefined });
  const nodes = new Map<string, CompiledNode>();

  if (!Array.isArray(wf?.nodes) || !Array.isArray(wf?.edges)) {
    err('INVALID_WORKFLOW', 'workflow must have nodes[] and edges[]');
    return { nodes, edges: [] };
  }

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
      ports = resolveNodePorts(n, def, registry, loop);
    } catch (e) {
      err('INVALID_PORT_SCHEMA', (e as Error).message, { node: n.id });
    }
    const cn: CompiledNode = { id: n.id, node: n, def, inputs: ports.inputs, outputs: ports.outputs, controlInputs: ports.controlInputs, controlOutputs: ports.controlOutputs };
    for (const m of builtins[n.type]?.check?.(n.config ?? {}, ports) ?? []) err('INVALID_CONFIG', `${n.type} "${n.id}": ${m}`, { node: n.id });
    if (COMPOSITES.includes(n.type)) {
      if (!n.body) err('LOOP_WITHOUT_BODY', `${n.type} "${n.id}" needs a body subgraph`, { node: n.id });
      else {
        cn.body = compileGraph(n.body, registry, errors, warnings, `${prefix}${n.id}.body/`, ports.body);
        const types = n.body.nodes.map((b) => b.type);
        if (types.filter((t) => t === 'loop_in').length !== 1 || types.filter((t) => t === 'loop_out').length !== 1)
          err('LOOP_BODY_PORTS', `${n.type} "${n.id}" body needs exactly one loop_in and one loop_out`, { node: n.id });
      }
      if (n.type === 'loop') checkLoopConfig(cn, err);
    }
    nodes.set(n.id, cn);
  }

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
    if (e.kind === 'data') {
      const out = src.outputs[e.from.port];
      const inp = dst.inputs[e.to.port];
      if (!out) err(src.controlOutputs.includes(e.from.port) ? 'EDGE_KIND_MISMATCH' : 'UNKNOWN_PORT', `data edge ${label}: "${e.from.port}" is not a data output of ${src.def.name}`, { edge: i });
      if (!inp) err(dst.controlInputs.includes(e.to.port) ? 'EDGE_KIND_MISMATCH' : 'UNKNOWN_PORT', `data edge ${label}: "${e.to.port}" is not a data input of ${dst.def.name}`, { edge: i });
      if (out && inp) {
        const c = isCompatible(out.schema, inp.schema);
        if (!c.ok) err('TYPE_MISMATCH', `data edge ${label}: ${typeLabel(out.schema)} → ${typeLabel(inp.schema)} incompatible (${c.reason})`, { edge: i });
        const k = `${e.to.node}.${e.to.port}`;
        dataIn.set(k, (dataIn.get(k) ?? 0) + 1);
        if (dataIn.get(k)! > 1 && !inp.multiple) err('MULTIPLE_DATA_INPUTS', `input ${k} already has a data edge (set multiple: true to collect)`, { edge: i });
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
    const hasControlIn = wf.edges.some((e) => e.kind === 'control' && e.to.node === cn.id);
    if (cn.def.mode === 'control' && cn.controlInputs.length > 0 && !hasControlIn)
      warnings.push({ code: 'ENTRY_NODE', message: `${prefix}node "${cn.id}" has no incoming control edge — it runs as an entry node`, node: cn.id });
  }

  // ---- 外層 DAG：不允許 cycle（Loop 必須用 composite node 表達） ----
  const cycle = findCycle([...nodes.keys()], wf.edges.filter((e) => nodes.has(e.from.node) && nodes.has(e.to.node)));
  if (cycle) err('CYCLE', `cycle detected: ${cycle.join(' → ')} (use a loop composite node instead of a back-edge)`);

  return { nodes, edges: wf.edges.filter((e) => nodes.has(e.from?.node) && nodes.has(e.to?.node)) };
}

function checkLoopConfig(cn: CompiledNode, err: (c: string, m: string, x?: Partial<Diagnostic>) => void) {
  const cfg = (cn.node.config ?? {}) as unknown as LoopConfig;
  if (cfg.until) {
    if (!cn.outputs[cfg.until.port]) err('INVALID_CONFIG', `loop "${cn.id}": until.port "${cfg.until.port}" is not a loop output`, { node: cn.id });
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

