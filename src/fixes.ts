import type { CompiledNode, Ctx, Diagnostic } from './compiler.js';
import { isCompatible, typeLabel } from './schema.js';
import type { JSONSchema } from './types.js';

/**
 * 編譯錯誤的「可執行的修正建議」（Diagnostic.fix）。
 * 目標讀者是人與 MCP agent：盡量給出可以直接照抄的 edge 字串 / config 片段 / 正確名稱。
 */

export const V1_ALTERNATIVES: Record<string, string> = {
  join: 'Not needed in v1: a node waits until ALL of its connected inputs have values. Connect each branch output directly into the next node.',
  switch: 'Use one or more condition nodes (each routes its data to a "true" or "false" output).',
  merge: 'Connect both branch outputs into the same input port; the value from the branch that actually ran is used.',
  set: 'Use constant inputs (nodes[].inputs.<port>) or a template node.',
  filter: 'Use a transform node with a JSONata expression, e.g. "items[price > 10]".',
  foreach: 'foreach is an advanced feature. In v1, process the list inside one agent node, or enable advanced mode.',
  subflow: 'subflow is an advanced feature. Copy the steps into this workflow, or enable advanced mode.',
  schema_validate: 'Use json_parse (+ optional ports.outputs.value schema) followed by a condition node.',
  delay: 'delay is an advanced node; enable advanced mode if you really need it.',
  file_read: 'File access is an advanced node; let an agent node read files with its own tools, or enable advanced mode.',
  file_write: 'File access is an advanced node; let an agent node write files with its own tools, or enable advanced mode.',
};

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let score = Infinity;
  for (const c of candidates) {
    const d = c.includes(name) || name.includes(c) ? Math.abs(c.length - name.length) * 0.5 : levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < score) (best = c), (score = d);
  }
  return best !== undefined && score <= Math.max(2, Math.floor(name.length / 2)) ? best : undefined;
}

const didYouMean = (name: string, cands: string[]) => {
  const c = closest(name, cands);
  return c ? `Did you mean "${c}"? ` : '';
};

const portsList = (ports: Record<string, { schema: JSONSchema }>) =>
  Object.entries(ports).map(([k, p]) => `${k}: ${typeLabel(p.schema)}`).join(', ') || '(none)';

function summarizeConfig(schema: JSONSchema | undefined, hide: string[] = []): string {
  if (!schema) return 'this node takes no config';
  const props = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, JSONSchema>).filter(([k]) => !hide.includes(k)));
  const req = (schema.required ?? []) as string[];
  const parts = Object.entries(props).map(([k, p]) => {
    const t = p.enum ? `one of ${(p.enum as unknown[]).map((x) => JSON.stringify(x)).join('|')}` : p.$type ?? p.type ?? 'any';
    const range = p.minimum !== undefined || p.maximum !== undefined ? ` [${p.minimum ?? ''}..${p.maximum ?? ''}]` : '';
    return `${k}${req.includes(k) ? ' (required)' : ''}: ${t}${range}`;
  });
  return `valid config keys: ${parts.join('; ') || '(none)'}${schema.additionalProperties === false ? '; no other keys allowed' : ''}`;
}

const CONFIG_EXAMPLES: Record<string, string> = {
  condition: '{"rule": {"op": "eq", "value": true}}  (ops: eq, neq, gt, gte, lt, lte, truthy, falsy, contains, is_empty, not_empty; optional "path": "a.b")',
  loop: '{"max_iterations": 3, "until": {"port": "passed", "op": "eq", "value": true}}',
  template: '{"template": "Summary: {{inputs.summary}}"}',
  transform: '{"expression": "items[price > 10].name"}',
  http_request: '{"method": "GET", "url": "https://api.example.com/items"}',
  end: '{"status": "success"}',
  log: '{"level": "info"}',
};

const CONTROL_NAMES = ['success', 'failure', 'completed', 'execute'];

export function fixFor(d: Diagnostic, ctx: Ctx): string | undefined {
  const scope = ctx.all.find((s) => s.prefix === (d.path ?? '')) ?? ctx.all[0];
  const nodeId = d.node && scope ? d.node.slice(scope.prefix.length) : undefined;
  const cn = nodeId ? scope?.nodes.get(nodeId) : undefined;
  const edge = d.edge !== undefined && d.code !== 'INVALID_EDGE' ? scope?.edges[d.edge] : undefined;
  const types = ctx.registry.list({ advanced: ctx.advanced }).map((x) => x.name);
  const v1 = ctx.v1;

  switch (d.code) {
    case 'UNKNOWN_NODE_TYPE': {
      const t = d.message.match(/unknown type "([^"]+)"/)?.[1] ?? '';
      return `${didYouMean(t, types)}Available node types: ${types.join(', ')}. Use get_node_type to see ports.`;
    }
    case 'UNKNOWN_PORT':
    case 'EDGE_KIND_MISMATCH': {
      if (!edge || !scope) return undefined;
      const src = scope.nodes.get(edge.from.node);
      const dst = scope.nodes.get(edge.to.node);
      const tips: string[] = [];
      if (v1 && (CONTROL_NAMES.includes(edge.from.port) || CONTROL_NAMES.includes(edge.to.port)))
        tips.push('v1 has no control ports ("success", "execute"...): connect a data output to a data input, and the order follows automatically.');
      if (src && !src.outputs[edge.from.port]) tips.push(`${didYouMean(edge.from.port, Object.keys(src.outputs))}"${src.id}" (${src.def.name}) outputs: ${portsList(src.outputs)}.`);
      if (dst && !dst.inputs[edge.to.port]) tips.push(`${didYouMean(edge.to.port, Object.keys(dst.inputs))}"${dst.id}" (${dst.def.name}) inputs: ${portsList(dst.inputs)}.`);
      if (dst?.def.dynamic_ports && !dst.inputs[edge.to.port] && !CONTROL_NAMES.includes(edge.to.port)) tips.push(`${dst.def.name} has dynamic ports: declare it in nodes[].ports.inputs.${edge.to.port}.`);
      return tips.join(' ') || undefined;
    }
    case 'TYPE_MISMATCH': {
      if (!edge || !scope) return cn ? undefined : undefined;
      const src = scope.nodes.get(edge.from.node);
      const dst = scope.nodes.get(edge.to.node);
      if (!src || !dst) return undefined;
      const target = dst.inputs[edge.to.port];
      const source = src.outputs[edge.from.port];
      const tips: string[] = [];
      const goodOuts = target ? Object.entries(src.outputs).filter(([, p]) => isCompatible(p.schema, target.schema).ok).map(([k]) => k) : [];
      if (goodOuts.length) tips.push(`"${src.id}" outputs that fit ${dst.id}.${edge.to.port} (${typeLabel(target!.schema)}): ${goodOuts.map((k) => `"${src.id}.${k} -> ${dst.id}.${edge.to.port}"`).join(', ')}.`);
      else if (target) {
        const others: string[] = [];
        for (const o of scope.nodes.values())
          if (o.id !== dst.id && o.id !== src.id) for (const [k, p] of Object.entries(o.outputs)) if (isCompatible(p.schema, target.schema).ok) others.push(`"${o.id}.${k} -> ${dst.id}.${edge.to.port}"`);
        if (others.length) tips.push(`Outputs in this graph that fit ${dst.id}.${edge.to.port} (${typeLabel(target.schema)}): ${others.slice(0, 4).join(', ')}.`);
      }
      const goodIns = source ? Object.entries(dst.inputs).filter(([, p]) => isCompatible(source.schema, p.schema).ok).map(([k]) => k) : [];
      if (goodIns.length) tips.push(`${src.id}.${edge.from.port} (${typeLabel(source!.schema)}) fits these inputs of "${dst.id}": ${goodIns.join(', ')}.`);
      tips.push(`Or convert the value with a transform node (set ports.outputs.result to ${target ? typeLabel(target.schema) : 'the target type'}) / a template node (→ string).`);
      return tips.join(' ');
    }
    case 'MISSING_REQUIRED_INPUT': {
      if (!cn || !scope) return undefined;
      const port = d.message.match(/required input "([^":]+):/)?.[1];
      const p = port ? cn.inputs[port] : undefined;
      if (!port || !p) return undefined;
      const cands: string[] = [];
      for (const other of scope.nodes.values()) {
        if (other.id === cn.id) continue;
        for (const [k, o] of Object.entries(other.outputs)) if (isCompatible(o.schema, p.schema).ok) cands.push(`"${other.id}.${k} -> ${cn.id}.${port}"`);
      }
      return `${cands.length ? `Connect a compatible output, e.g. ${cands.slice(0, 4).join(' or ')}. ` : `No node in this graph outputs ${typeLabel(p.schema)} yet; add one (or a start port). `}Or set a constant: nodes[id="${cn.id}"].inputs.${port}.`;
    }
    case 'INVALID_CONFIG':
    case 'V1_LOOP_CONFIG': {
      const def = cn?.def;
      if (!def) return undefined;
      const ex = CONFIG_EXAMPLES[def.name];
      return `${summarizeConfig(def.config_schema, v1 && !ctx.advanced && def.name === 'loop' ? ['carry', 'on_body_failure'] : [])}.${ex ? ` Example: ${ex}` : ''}`;
    }
    case 'POLICY_OVERRIDE':
      return 'Remove this key from config. Model, tools, MCP servers, skills and system prompt are locked by the registry definition; only max_turns / timeout_seconds / retry may be set per node.';
    case 'CYCLE':
      return v1
        ? 'Remove the back-edge. To repeat steps until something holds, put them inside a loop node body (loop_in → steps → loop_out) and set config.until; a loop output named like a loop input (e.g. "feedback") is fed into the next iteration.'
        : 'Remove the back-edge and use a loop composite node instead.';
    case 'DUPLICATE_NODE':
      return 'Every node needs a unique, non-empty "id" (letters, digits, _ or -).';
    case 'LOOP_WITHOUT_BODY':
    case 'LOOP_BODY_PORTS':
      return 'Add "body": {"nodes": [{"id": "loop_in", "type": "loop_in"}, ...steps..., {"id": "loop_out", "type": "loop_out"}], "edges": ["loop_in.<input> -> step.<in>", "step.<out> -> loop_out.<output>"]}. loop_in exposes the loop inputs (+ iteration); loop_out takes the loop outputs.';
    case 'LOOP_PORT_OUTSIDE_LOOP':
      return 'loop_in / loop_out only exist inside a loop body. At the top level use start / end.';
    case 'DYNAMIC_PORTS_NOT_ALLOWED':
      return cn ? `"${cn.def.name}" has fixed ports — remove nodes[].ports. Inputs: ${portsList(cn.def.inputs)}; outputs: ${portsList(cn.def.outputs)}.` : undefined;
    case 'INVALID_CONSTANT':
      return 'Fix the constant in nodes[].inputs so it matches the port type (see get_node_type), or connect an edge instead.';
    case 'MULTIPLE_DATA_INPUTS':
      return 'Connect only one edge to this input (or set multiple: true on the port to collect an array).';
    case 'END_UNCONNECTED': {
      const id = cn?.id ?? 'end';
      const conds = scope ? [...scope.nodes.values()].filter((o) => o.def.name === 'condition').map((o) => `"${o.id}.false -> ${id}.reason"`) : [];
      return `Connect at least one output into this end node (declare the port in nodes[].ports.inputs), e.g. ${conds[0] ?? `"report.report -> ${id}.report"`}. The end node runs when its inputs arrive — an end fed by a condition branch only runs on that branch.`;
    }
    case 'NESTED_LOOP_NOT_IN_V1':
    case 'NODE_NOT_IN_V1':
    case 'LEGACY_FORMAT':
    case 'INVALID_EDGE':
    case 'CONTROL_EDGE_IN_V1':
      return undefined;
    case 'INVALID_PORT_SCHEMA':
      return 'Port schemas are JSON Schema, e.g. {"type": "string"} or {"type": "array", "items": {"$type": "Task"}}; optional ports: {"schema": {...}, "required": false}.';
    case 'ENTRY_NODE':
      return undefined;
  }
  return undefined;
}

export type { CompiledNode };
