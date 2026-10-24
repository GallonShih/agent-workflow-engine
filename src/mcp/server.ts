import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Backend } from './backend.js';
import type { NodeDefinition, RunEvent } from '../types.js';
import { typeLabel } from '../schema.js';

/**
 * Agent Workflow MCP server：讓 Claude Desktop / Claude Code / Cursor 等 agent 列節點、寫 v1 workflow、驗證、存檔、執行、看結果。
 * 所有工具都轉呼叫既有 backend REST API（見 backend.ts）。用低階 Server API 是為了直接提供手寫的 JSON Schema。
 */

export const INSTRUCTIONS = `Agent Workflow (DSL v1) — how to author a workflow:
- A workflow is {"version": 1, "name": "...", "nodes": [...], "edges": [...]}.
- Node: {"id": "planner", "type": "planning_agent", "config": {...}, "inputs": {<constant input values>}, "ports": {...}}.
- Edge: a data connection string "fromNode.outputPort -> toNode.inputPort". There are NO control edges: a node runs as soon as all of its connected inputs have values.
- start declares the run inputs as ports.outputs; end declares what it collects as ports.inputs (config.status "success" | "failed").
- condition: config.rule {op, value, path?} is applied to input "value"; the data (input "data", or "value") comes out of output "true" OR "false". Nodes downstream of the side not taken are skipped automatically.
- loop (retry-until): config {max_iterations, until: {port, op, value}}; its body is {nodes, edges} with one loop_in (= loop inputs + iteration) and one loop_out (= loop outputs). A loop output with the same name as a loop input (e.g. "feedback") is fed into the next iteration. Extra outputs: iterations, done.
- Agent nodes (…_agent) have fixed ports and locked permissions (model/tools/MCP cannot be overridden); per-node config may only set max_turns, timeout_seconds, retry.
Workflow: list_node_types → get_node_type for each type you use → validate_workflow (fix every error using its "fix" hint) → save_workflow → run_workflow → poll get_run until status is success/failed.
- Workspace: agent nodes declare workspace access in the registry (none | read | write; e.g. planning_agent = read, coding_agent / testing_agent = write). A workflow that contains read/write agents needs run_workflow "workspace": an absolute path to a local repo/dir inside the server's WORKSPACE_ROOTS. validate_workflow reports workspace_required. get_run shows the workspace, its git branch/HEAD at start, and the files changed during the run.
Agents run on the deterministic mock runtime (no API key).`;

const WORKFLOW_SCHEMA = {
  type: 'object',
  description: 'Workflow DSL v1 document.',
  required: ['version', 'nodes', 'edges'],
  properties: {
    version: { const: 1, description: 'Always 1.' },
    id: { type: 'string' },
    name: { type: 'string', description: 'Human readable name.' },
    description: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'type'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]*$', description: 'Unique node id, used in edges.' },
          type: { type: 'string', description: 'Node type name from list_node_types.' },
          label: { type: 'string' },
          config: { type: 'object', description: 'Node config; must match the type\'s config_schema (get_node_type).' },
          inputs: { type: 'object', description: 'Constant values for inputs that are not connected.' },
          ports: {
            type: 'object',
            description: 'Dynamic ports (start: outputs; end/template: inputs; loop: inputs + outputs). Values are JSON Schemas, or {"schema": {...}, "required": false}.',
            properties: { inputs: { type: 'object' }, outputs: { type: 'object' } },
          },
          body: { type: 'object', description: 'Loop body: {"nodes": [...loop_in, steps, loop_out], "edges": ["loop_in.x -> step.x", ...]}.' },
        },
      },
    },
    edges: {
      type: 'array',
      description: 'Data connections, e.g. "start.request -> planner.request".',
      items: { type: 'string', pattern: '^\\s*[A-Za-z_][\\w-]*\\.[A-Za-z_][\\w-]*\\s*->\\s*[A-Za-z_][\\w-]*\\.[A-Za-z_][\\w-]*\\s*$' },
    },
  },
} as const;

export const TOOLS: Tool[] = [
  {
    name: 'list_node_types',
    description: 'List the node types you can use in a v1 workflow (name, category, input/output ports with types, config keys). Call this first. Set advanced: true to also see advanced nodes (not allowed in plain v1).',
    inputSchema: { type: 'object', properties: { advanced: { type: 'boolean', default: false } } },
  },
  {
    name: 'get_node_type',
    description: 'Full definition of one node type: every input/output port with its JSON Schema and whether it is required, the config JSON Schema, and an example node + edges. Use it before wiring a node.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', description: 'e.g. "condition", "loop", "coding_agent"' } } },
  },
  {
    name: 'list_workflows',
    description: 'List saved workflows (id, name, node count, DSL version) that run_workflow / get_workflow accept.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_workflow',
    description: 'Get a saved workflow document by id (v1 files use compact "a.out -> b.in" edges).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'validate_workflow',
    description: 'Type-check a workflow without saving it. Returns ok plus errors/warnings; every error has a code, a message, the node it concerns and a concrete "fix" suggestion (e.g. the exact edge string to add). Iterate until ok is true.',
    inputSchema: {
      type: 'object',
      required: ['workflow'],
      properties: {
        workflow: WORKFLOW_SCHEMA,
        advanced: { type: 'boolean', default: false, description: 'Allow advanced features.' },
        workspace: { type: 'string', description: 'Optional: the workspace you plan to run with. If given, the path is checked against WORKSPACE_ROOTS too.' },
      },
    },
  },
  {
    name: 'save_workflow',
    description: 'Validate and save a workflow as workflows/<id>.json. Invalid workflows are rejected with the same errors + fixes as validate_workflow; nothing is written then.',
    inputSchema: {
      type: 'object',
      required: ['id', 'workflow'],
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'File id (letters, digits, _ or -).' }, workflow: WORKFLOW_SCHEMA },
    },
  },
  {
    name: 'run_workflow',
    description:
      'Start a run in the background (mock agent runtime) and return its run_id immediately. Pass workflow_id of a saved workflow, or an inline workflow. inputs must match the start node outputs. ' +
      'If the workflow has agents with workspace access read/write (planning/coding/testing/... agents), pass workspace = absolute path of the local repo/dir they should work in; it must be inside WORKSPACE_ROOTS (errors include a "fix"). Agents operate directly in that directory (no copy / worktree). Then poll get_run (it lists the changed files).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string' },
        workflow: WORKFLOW_SCHEMA,
        inputs: { type: 'object', description: 'Run inputs keyed by the start node output names.' },
        scenario: { type: 'string', enum: ['pass', 'fail'], default: 'pass', description: 'Demo mock agents: "pass" = tests pass on iteration pass_on; "fail" = they never pass.' },
        pass_on: { type: 'integer', minimum: 0, default: 2, description: '0-based loop iteration on which the mock testing_agent passes.' },
        mock_delay_ms: { type: 'integer', minimum: 0, maximum: 5000, description: 'Delay per mock agent call.' },
        workspace: { type: 'string', description: 'Absolute path to the local repo/dir agents work in (must be inside the server env WORKSPACE_ROOTS; ~ allowed). Required when any agent has workspace access read or write.' },
        mock_writes: { type: 'boolean', default: false, description: 'Mock runtime demo: the mock coding_agent writes files under <workspace>/agent-workflow-demo/ so the changed-files list has content.' },
      },
    },
  },
  {
    name: 'get_run',
    description: 'Status of a run with a per-node summary (status, attempts, duration, error, short output preview; loop iterations appear as separate keys like fix_loop#1/coder) and the end-node outputs. status is running | success | failed | cancelled. workspace = {path, git: {branch, head, head_after}, changed_files, diff_stat} (changed files appear once the run has finished).',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: { type: 'string' } } },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a run that is still running (status becomes cancelled; in-flight nodes are aborted). Errors if the run already finished.',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: { type: 'string' } } },
  },
];

const text = (v: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }], ...(isError ? { isError: true } : {}) });

function preview(v: unknown, max = 160): unknown {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s.length <= max ? v : s.slice(0, max) + '…';
}

const portSummary = (ports: NodeDefinition['inputs']) =>
  Object.fromEntries(Object.entries(ports).map(([k, p]) => [k, `${typeLabel(p.schema)}${p.required === false || p.default !== undefined ? ' (optional)' : ''}`]));

const DYNAMIC_NOTE: Record<string, string> = {
  start: 'Declare run inputs in ports.outputs, e.g. {"request": {"type": "string"}}.',
  end: 'Declare collected values in ports.inputs (all optional). Runs when its connected inputs arrive.',
  template: 'Declare inputs in ports.inputs; reference them as {{inputs.name}} in config.template. Output: text.',
  loop: 'Declare ports.inputs and ports.outputs; body needs loop_in (outputs = loop inputs + iteration) and loop_out (inputs = loop outputs). Extra outputs: iterations (integer), done (boolean, true when until was met). Same-name output→input is carried to the next iteration.',
  condition: 'Outputs "true" and "false" carry the "data" input (or "value" if data is not connected); only one fires. Their type equals the connected source type.',
};

const EXAMPLES: Record<string, unknown> = {
  condition: { node: { id: 'gate', type: 'condition', config: { rule: { op: 'eq', value: true } } }, edges: ['tests.passed -> gate.value', 'tests.report -> gate.data', 'gate.true -> report.headline', 'gate.false -> end_fail.reason'] },
  loop: {
    node: {
      id: 'fix_loop', type: 'loop', config: { max_iterations: 3, until: { port: 'passed', op: 'eq', value: true } },
      ports: { inputs: { tasks: { type: 'array', items: { $type: 'Task' } }, acceptance_criteria: { type: 'array', items: { type: 'string' } }, feedback: { schema: { type: 'array', items: { type: 'string' } }, required: false, default: [] } }, outputs: { passed: { type: 'boolean' }, feedback: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
      body: {
        nodes: [{ id: 'loop_in', type: 'loop_in' }, { id: 'coder', type: 'coding_agent' }, { id: 'tester', type: 'testing_agent' }, { id: 'loop_out', type: 'loop_out' }],
        edges: ['loop_in.tasks -> coder.tasks', 'loop_in.feedback -> coder.feedback', 'loop_in.acceptance_criteria -> tester.acceptance_criteria', 'coder.files_modified -> tester.files_modified', 'coder.summary -> loop_out.summary', 'tester.passed -> loop_out.passed', 'tester.failures -> loop_out.feedback'],
      },
    },
    edges: ['planner.tasks -> fix_loop.tasks', 'planner.acceptance_criteria -> fix_loop.acceptance_criteria', 'fix_loop.passed -> gate.value'],
  },
  start: { node: { id: 'start', type: 'start', ports: { outputs: { request: { type: 'string' }, repository: { type: 'string' } } } }, edges: ['start.request -> planner.request'] },
  end: { node: { id: 'end_ok', type: 'end', config: { status: 'success' }, ports: { inputs: { report: { type: 'string' } } } }, edges: ['report.report -> end_ok.report'] },
  template: { node: { id: 'headline', type: 'template', ports: { inputs: { summary: { type: 'string' } } }, config: { template: 'Done: {{inputs.summary}}' } }, edges: ['fix_loop.summary -> headline.summary'] },
};

async function definitions(backend: Backend, advanced: boolean): Promise<NodeDefinition[]> {
  const r = await backend.request('GET', `/api/registry${advanced ? '?advanced=1' : ''}`);
  return ((r.json as { definitions: NodeDefinition[] }).definitions ?? []).filter((d) => d.tier !== 'internal' && !(advanced ? false : d.tier === 'advanced'));
}

/** run 事件 → 每個節點（含 loop iteration scope）一行摘要；執行中也能用（不依賴結束時才寫的 records） */
export function summarizeRun(events: RunEvent[]) {
  const nodes = new Map<string, Record<string, unknown>>();
  let status = 'running';
  let unhandled: unknown;
  for (const e of events) {
    if (e.type === 'run_completed' && e.seq > 0) {
      status = String(e.data?.status ?? 'failed');
      unhandled = e.data?.unhandled_failures;
    }
    if (!e.key || !e.node_id || !e.type.startsWith('node_')) continue;
    const k = e.key.replace(/^[^/]*\/(root\/)?/, '');
    const n = nodes.get(k) ?? { key: k, node: e.node_id, status: 'pending' };
    if (e.type === 'node_triggered') n.status = 'queued';
    if (e.type === 'node_started') n.status = 'running';
    if (e.type === 'node_retry') n.retries = ((n.retries as number) ?? 0) + 1;
    if (e.type === 'node_succeeded') Object.assign(n, { status: 'success', duration_ms: e.data?.duration_ms, attempts: e.data?.attempts, outputs: preview(e.data?.outputs) });
    if (e.type === 'node_failed') Object.assign(n, { status: 'failed', duration_ms: e.data?.duration_ms, attempts: e.data?.attempts, error: e.data?.error });
    if (e.type === 'node_skipped') Object.assign(n, { status: 'skipped', reason: e.data?.reason });
    nodes.set(k, n);
  }
  return { status, nodes: [...nodes.values()], unhandled_failures: unhandled };
}

export function createMcpServer(backend: Backend): Server {
  const server = new Server({ name: 'agent-workflow', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await callTool(backend, req.params.name, a);
    } catch (e) {
      return text(`tool ${req.params.name} failed: ${(e as Error).message}`, true);
    }
  });
  return server;
}

export async function callTool(backend: Backend, name: string, a: Record<string, unknown>) {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (name) {
    case 'list_node_types': {
      const defs = await definitions(backend, a.advanced === true);
      return text({
        dsl: 'v1 — edges are "from.port -> to.port" strings; no control edges',
        node_types: defs.map((d) => ({
          name: d.name,
          kind: d.kind,
          category: d.category,
          tier: d.tier ?? (d.kind === 'agent' ? 'v1' : 'advanced'),
          description: d.description,
          inputs: d.dynamic_ports && ['start', 'end', 'template', 'loop'].includes(d.name) ? (d.name === 'start' ? {} : 'dynamic (ports.inputs)') : portSummary(d.inputs),
          outputs: d.name === 'condition' ? { true: 'same type as data/value', false: 'same type as data/value' } : d.dynamic_ports && ['start', 'loop'].includes(d.name) ? 'dynamic (ports.outputs)' : portSummary(d.outputs),
          config_keys: Object.keys(((d.config_schema as { properties?: object })?.properties ?? {}) as object).filter((k) => !(d.name === 'loop' && ['carry', 'on_body_failure'].includes(k))),
        })),
      });
    }
    case 'get_node_type': {
      const defs = await definitions(backend, true);
      const d = defs.find((x) => x.name === str('name'));
      if (!d) return text({ error: `unknown node type "${str('name')}"`, available: defs.filter((x) => x.tier !== 'advanced').map((x) => x.name) }, true);
      const { system_prompt: _sp, source: _src, prompt: _p, ...pub } = d;
      if (d.name === 'loop' && pub.config_schema) {
        // carry / on_body_failure 是進階選項；v1 不顯示
        const cs = structuredClone(pub.config_schema) as { properties?: Record<string, unknown> };
        delete cs.properties?.carry;
        delete cs.properties?.on_body_failure;
        pub.config_schema = cs as typeof pub.config_schema;
      }
      return text({
        ...pub,
        permissions_locked: d.kind === 'agent' ? 'model, allowed_tools, mcp, skills and system_prompt come from the registry and cannot be overridden' : undefined,
        dynamic_ports_note: DYNAMIC_NOTE[d.name],
        example: EXAMPLES[d.name] ?? (d.kind === 'agent' ? { node: { id: d.name.replace(/_agent$/, ''), type: d.name, config: { retry: { max_attempts: 2, backoff_ms: 500 } } }, inputs: Object.keys(d.inputs), outputs: Object.keys(d.outputs) } : undefined),
      });
    }
    case 'list_workflows':
      return text((await backend.request('GET', '/api/workflows')).json);
    case 'get_workflow': {
      const r = await backend.request('GET', `/api/workflows/${encodeURIComponent(str('id'))}`);
      return text(r.json, r.status !== 200);
    }
    case 'validate_workflow': {
      const r = await backend.request('POST', '/api/validate', { workflow: a.workflow, advanced: a.advanced === true, ...(a.workspace !== undefined ? { workspace: a.workspace } : {}) });
      return text(r.json, r.status !== 200);
    }
    case 'save_workflow': {
      const wf = a.workflow as Record<string, unknown> | undefined;
      if (!wf || typeof wf !== 'object') return text({ error: 'workflow is required' }, true);
      const r = await backend.request('PUT', `/api/workflows/${encodeURIComponent(str('id'))}`, wf);
      return text(r.status === 200 ? r.json : { saved: false, ...(r.json as object) }, r.status !== 200);
    }
    case 'run_workflow': {
      const body: Record<string, unknown> = {};
      for (const k of ['workflow_id', 'workflow', 'inputs', 'scenario', 'pass_on', 'mock_delay_ms', 'workspace', 'mock_writes']) if (a[k] !== undefined) body[k] = a[k];
      const r = await backend.request('POST', '/api/runs', body);
      return text(r.status === 202 ? { ...(r.json as object), status: 'running', next: 'poll get_run with this run_id' } : r.json, r.status !== 202);
    }
    case 'get_run': {
      const r = await backend.request('GET', `/api/runs/${encodeURIComponent(str('run_id'))}`);
      if (r.status !== 200) return text(r.json, true);
      const run = r.json as { meta: Record<string, unknown>; events?: RunEvent[]; workflow?: { nodes?: { id: string; type: string }[] } };
      const s = summarizeRun(run.events ?? []);
      const status = run.meta.status === 'running' ? 'running' : String(run.meta.status ?? s.status);
      const endIds = new Set((run.workflow?.nodes ?? []).filter((n) => n.type === 'end').map((n) => n.id));
      const ended = s.nodes.filter((n) => endIds.has(n.key as string) && n.status === 'success').map((n) => n.key);
      return text({
        run_id: run.meta.run_id,
        workflow: run.meta.workflow_id ?? run.meta.workflow_name,
        status,
        duration_ms: run.meta.duration_ms,
        runtime: run.meta.runtime,
        error: run.meta.error,
        ...(run.meta.workspace ? { workspace: run.meta.workspace } : {}),
        ended_at: ended,
        unhandled_failures: s.unhandled_failures,
        counts: s.nodes.reduce<Record<string, number>>((c, n) => ((c[n.status as string] = (c[n.status as string] ?? 0) + 1), c), {}),
        nodes: s.nodes,
      });
    }
    case 'cancel_run': {
      const r = await backend.request('POST', `/api/runs/${encodeURIComponent(str('run_id'))}/cancel`);
      return text(r.json, r.status !== 200);
    }
  }
  return text(`unknown tool "${name}"`, true);
}
