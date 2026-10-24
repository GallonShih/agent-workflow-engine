/**
 * MCP 端到端示範：用官方 SDK client 透過 stdio 連到 MCP server，模擬一個 agent 的完整流程：
 *   列節點 → 寫一份有錯的 workflow → validate 拿到錯誤 + 修正建議 → 修好 → save → run（mock agents）→ 輪詢 get_run 到 success
 *
 *   npm run mcp:demo                 # 印出逐步紀錄（workflow 存到暫存資料夾，不動 workflows/）
 * test/mcp/e2e.test.ts 也是跑這個流程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(import.meta.dirname, '..');

type Log = (step: string, detail?: unknown) => void;

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = r.content[0]?.text ?? '';
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { json: json as Record<string, any>, isError: !!r.isError };
}

const loopNode = (bodyEdges: string[]) => ({
  id: 'fix_loop',
  type: 'loop',
  config: { max_iterations: 3, until: { port: 'passed', op: 'eq', value: true } },
  ports: {
    inputs: {
      tasks: { type: 'array', items: { $type: 'Task' } },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
      feedback: { schema: { type: 'array', items: { type: 'string' } }, required: false, default: [] },
    },
    outputs: { passed: { type: 'boolean' }, feedback: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } },
  },
  body: {
    nodes: [{ id: 'loop_in', type: 'loop_in' }, { id: 'coder', type: 'coding_agent' }, { id: 'tester', type: 'testing_agent' }, { id: 'loop_out', type: 'loop_out' }],
    edges: bodyEdges,
  },
});
const BODY = ['loop_in.tasks -> coder.tasks', 'loop_in.feedback -> coder.feedback', 'loop_in.acceptance_criteria -> tester.acceptance_criteria', 'coder.files_modified -> tester.files_modified', 'coder.summary -> loop_out.summary', 'tester.passed -> loop_out.passed', 'tester.failures -> loop_out.feedback'];

/** 第一版：故意寫錯（覆寫 model、用舊式 control port、型別接錯、end 沒接、條件 op 打錯） */
export function brokenWorkflow() {
  return {
    version: 1,
    name: 'MCP demo: fix until tests pass',
    nodes: [
      { id: 'start', type: 'start', ports: { outputs: { request: { type: 'string' }, repository: { type: 'string' } } } },
      { id: 'planner', type: 'planning_agent', config: { model: 'claude-opus-4' } },
      loopNode(BODY),
      { id: 'gate', type: 'condition', config: { rule: { op: 'equals', value: true } } },
      { id: 'end_ok', type: 'end', config: { status: 'success' }, ports: { inputs: { summary: { type: 'string' } } } },
      { id: 'end_fail', type: 'end', config: { status: 'failed' }, ports: { inputs: { reason: {} } } },
    ],
    edges: [
      'start.request -> planner.request',
      'start.repository -> planner.repository',
      'planner.success -> fix_loop.execute',
      'start.request -> fix_loop.tasks',
      'planner.acceptance_criteria -> fix_loop.acceptance_criteria',
      'fix_loop.passed -> gate.value',
      'fix_loop.summary -> gate.data',
      'gate.true -> end_ok.summary',
    ],
  };
}

/** 依照 validate_workflow 的 fix 建議修好的版本 */
export function fixedWorkflow() {
  const wf = brokenWorkflow();
  wf.nodes[1] = { id: 'planner', type: 'planning_agent' } as never;
  wf.nodes[3] = { id: 'gate', type: 'condition', config: { rule: { op: 'eq', value: true } } } as never;
  wf.edges = wf.edges.filter((e) => !e.startsWith('planner.success') && e !== 'start.request -> fix_loop.tasks');
  wf.edges.push('planner.tasks -> fix_loop.tasks', 'gate.false -> end_fail.reason');
  return wf;
}

/** workspace：agent 節點操作的目錄（必須在 MCP server 的 WORKSPACE_ROOTS 內） */
export async function mcpE2E(client: Client, log: Log, workspace: string) {
  const tools = await client.listTools();
  log('tools/list', tools.tools.map((t) => t.name));

  const types = await call(client, 'list_node_types');
  log('list_node_types', types.json.node_types.map((t: { name: string }) => t.name));
  const loopDef = await call(client, 'get_node_type', { name: 'loop' });
  log('get_node_type loop', { config_keys: Object.keys(loopDef.json.config_schema?.properties ?? {}), note: loopDef.json.dynamic_ports_note });

  const bad = await call(client, 'validate_workflow', { workflow: brokenWorkflow() });
  log('validate_workflow (broken)', { ok: bad.json.ok, errors: bad.json.errors.map((e: { code: string; message: string; fix?: string }) => ({ code: e.code, message: e.message, fix: e.fix })) });

  const rejected = await call(client, 'save_workflow', { id: 'mcp-demo', workflow: brokenWorkflow() });
  log('save_workflow (broken) → rejected', { isError: rejected.isError, saved: rejected.json.saved, errors: rejected.json.errors?.length });

  const good = await call(client, 'validate_workflow', { workflow: fixedWorkflow() });
  log('validate_workflow (fixed)', { ok: good.json.ok, errors: good.json.errors.length, warnings: good.json.warnings.length });

  const saved = await call(client, 'save_workflow', { id: 'mcp-demo', workflow: fixedWorkflow() });
  log('save_workflow (fixed)', saved.json);

  const listed = await call(client, 'list_workflows');
  log('list_workflows', listed.json.map((w: { id: string; version: number }) => `${w.id} (v${w.version})`));

  const runArgs = { workflow_id: 'mcp-demo', inputs: { request: '修正 parser 空字串 bug', repository: 'github.com/acme/parser' }, scenario: 'pass', pass_on: 1, mock_delay_ms: 5 };
  const noWs = await call(client, 'run_workflow', runArgs);
  log('run_workflow (no workspace) → rejected', { isError: noWs.isError, errors: noWs.json.errors?.map((e: { code: string; fix?: string }) => ({ code: e.code, fix: e.fix })) });
  const started = await call(client, 'run_workflow', { ...runArgs, workspace, mock_writes: true });
  log('run_workflow', started.json);

  let run: Record<string, any> = {};
  let polls = 0;
  for (; polls < 200; polls++) {
    run = (await call(client, 'get_run', { run_id: started.json.run_id })).json;
    if (run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  log(`get_run (after ${polls + 1} polls)`, { status: run.status, ended_at: run.ended_at, counts: run.counts, nodes: run.nodes.map((n: { key: string; status: string; attempts?: number }) => `${n.key}: ${n.status}${n.attempts && n.attempts > 1 ? ` (${n.attempts} attempts)` : ''}`) });
  log('get_run workspace', run.workspace);
  return { tools, bad: bad.json, good: good.json, saved, rejected, run, started: started.json, noWs };
}

export function stdioTransport(env: Record<string, string>) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'src/mcp/stdio.ts')],
    cwd: root,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-demo-'));
  const wfDir = path.join(tmp, 'workflows');
  fs.cpSync(path.join(root, 'workflows'), wfDir, { recursive: true });
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace);
  const client = new Client({ name: 'mcp-demo', version: '1.0.0' });
  await client.connect(stdioTransport({ WORKFLOW_DIR: wfDir, WORKFLOW_RUNS_DIR: path.join(tmp, 'runs'), MOCK_DELAY_MS: '5', WORKSPACE_ROOTS: tmp }));
  await mcpE2E(client, (step, detail) => console.log(`\n### ${step}\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`), workspace);
  await client.close();
}
