import type { DataPortDef, Edge, LoopConfig, NodeDefinition, Rule, WorkflowGraph, WorkflowNode } from './types.js';
import type { NodeRegistry } from './registry.js';
import { isCompatible, typeLabel, validateValue } from './schema.js';

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
const RULE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsy', 'contains', 'is_empty', 'not_empty'];

interface LoopPorts {
  inputs: Record<string, DataPortDef>;
  outputs: Record<string, DataPortDef>;
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
  loop: LoopPorts | undefined,
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
    if (n.ports && !def.dynamic_ports) err('DYNAMIC_PORTS_NOT_ALLOWED', `node type "${n.type}" does not allow dynamic ports`, { node: n.id });

    let inputs = def.inputs;
    let outputs = def.outputs;
    try {
      const dynIn = n.ports?.inputs ? registry.normalizePorts(n.ports.inputs, `${n.id}.ports.inputs`) : {};
      const dynOut = n.ports?.outputs ? registry.normalizePorts(n.ports.outputs, `${n.id}.ports.outputs`) : {};
      switch (n.type) {
        case 'start':
          outputs = dynOut;
          break;
        case 'end':
          inputs = Object.fromEntries(Object.entries(dynIn).map(([k, p]) => [k, { ...p, required: p.required ?? false }]));
          break;
        case 'template':
          inputs = dynIn;
          break;
        case 'loop':
          inputs = dynIn;
          outputs = { ...dynOut, iterations: { schema: { type: 'integer' } } };
          break;
        case 'loop_in':
          outputs = { ...(loop?.inputs ?? {}), iteration: { schema: { type: 'integer' } } };
          break;
        case 'loop_out':
          inputs = loop?.outputs ?? {};
          break;
      }
    } catch (e) {
      err('INVALID_PORT_SCHEMA', (e as Error).message, { node: n.id });
    }
    const cn: CompiledNode = { id: n.id, node: n, def, inputs, outputs, controlInputs: def.control_inputs, controlOutputs: def.control_outputs };
    checkBuiltinConfig(cn, err);
    if (n.type === 'loop') {
      if (!n.body) err('LOOP_WITHOUT_BODY', `loop "${n.id}" needs a body subgraph`, { node: n.id });
      else {
        const bodyOutputs = Object.fromEntries(Object.entries(outputs).filter(([k]) => k !== 'iterations'));
        cn.body = compileGraph(n.body, registry, errors, warnings, `${prefix}${n.id}.body/`, { inputs, outputs: bodyOutputs });
        const types = n.body.nodes.map((b) => b.type);
        if (types.filter((t) => t === 'loop_in').length !== 1 || types.filter((t) => t === 'loop_out').length !== 1)
          err('LOOP_BODY_PORTS', `loop "${n.id}" body needs exactly one loop_in and one loop_out`, { node: n.id });
      }
      checkLoopConfig(cn, err);
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

function checkRule(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object') return 'rule must be an object {op, value?, path?}';
  const r = rule as Rule;
  if (!RULE_OPS.includes(r.op)) return `unknown op "${String(r.op)}" (allowed: ${RULE_OPS.join(', ')})`;
  return null;
}

function checkBuiltinConfig(cn: CompiledNode, err: (c: string, m: string, x?: Partial<Diagnostic>) => void) {
  const cfg = cn.node.config ?? {};
  if (cn.def.name === 'condition') {
    const r = checkRule(cfg.rule);
    if (r) err('INVALID_CONFIG', `condition "${cn.id}": ${r}`, { node: cn.id });
  }
  if (cn.def.name === 'join' && cfg.policy !== undefined && !['all', 'any'].includes(cfg.policy as string))
    err('INVALID_CONFIG', `join "${cn.id}": policy must be all | any`, { node: cn.id });
  if (cn.def.name === 'end' && cfg.status !== undefined && !['success', 'failed'].includes(cfg.status as string))
    err('INVALID_CONFIG', `end "${cn.id}": status must be success | failed`, { node: cn.id });
  if (cn.def.name === 'template' && typeof cfg.template !== 'string') err('INVALID_CONFIG', `template "${cn.id}": config.template must be a string`, { node: cn.id });
}

function checkLoopConfig(cn: CompiledNode, err: (c: string, m: string, x?: Partial<Diagnostic>) => void) {
  const cfg = (cn.node.config ?? {}) as unknown as LoopConfig;
  if (!Number.isInteger(cfg.max_iterations) || cfg.max_iterations < 1 || cfg.max_iterations > 100)
    err('INVALID_CONFIG', `loop "${cn.id}": max_iterations must be an integer 1..100`, { node: cn.id });
  if (cfg.until) {
    if (!cn.outputs[cfg.until.port]) err('INVALID_CONFIG', `loop "${cn.id}": until.port "${cfg.until.port}" is not a loop output`, { node: cn.id });
    const r = checkRule(cfg.until);
    if (r) err('INVALID_CONFIG', `loop "${cn.id}" until: ${r}`, { node: cn.id });
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

export function evalRule(rule: Rule, input: unknown): boolean {
  let v: unknown = input;
  if (rule.path) for (const p of rule.path.split('.')) v = v == null ? undefined : (v as Record<string, unknown>)[p];
  const x = rule.value;
  switch (rule.op) {
    case 'eq': return JSON.stringify(v) === JSON.stringify(x);
    case 'neq': return JSON.stringify(v) !== JSON.stringify(x);
    case 'gt': return Number(v) > Number(x);
    case 'gte': return Number(v) >= Number(x);
    case 'lt': return Number(v) < Number(x);
    case 'lte': return Number(v) <= Number(x);
    case 'truthy': return Boolean(v);
    case 'falsy': return !v;
    case 'contains': return Array.isArray(v) ? v.some((i) => JSON.stringify(i) === JSON.stringify(x)) : String(v ?? '').includes(String(x));
    case 'is_empty': return v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' ? Object.keys(v as object).length === 0 : String(v).trim() === '');
    case 'not_empty': return !evalRule({ ...rule, op: 'is_empty', path: undefined }, v);
  }
}
