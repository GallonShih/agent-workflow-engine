import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer } from '../../src/server/app.js';
import { createMcpServer, summarizeRun, TOOLS } from '../../src/mcp/server.js';
import { httpBackend, injectBackend } from '../../src/mcp/backend.js';
import { brokenWorkflow, fixedWorkflow } from '../../scripts/mcp-demo.js';
import { root, WS } from '../helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-unit-'));
const wfDir = path.join(tmp, 'workflows');
fs.cpSync(path.join(root, 'workflows'), wfDir, { recursive: true });
const app = buildServer({ root, workflowsDir: wfDir, runsDir: path.join(tmp, 'runs'), mockDelayMs: 0, workspaceRoots: [WS] });
const client = new Client({ name: 'test', version: '1' });

async function call(name: string, args: Record<string, unknown> = {}, c = client) {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  let json: any;
  try {
    json = JSON.parse(r.content[0].text);
  } catch {
    json = r.content[0].text;
  }
  return { json, isError: !!r.isError };
}

async function waitRun(runId: string, c = client) {
  for (let i = 0; i < 200; i++) {
    const r = (await call('get_run', { run_id: runId }, c)).json;
    if (r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('run did not finish');
}

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(injectBackend(app)).connect(a);
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('MCP server tools', () => {
  it('exposes 9 tools, each with a description and an object input schema; server instructions explain the DSL', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_node_types', 'get_node_type', 'list_workflows', 'get_workflow', 'validate_workflow', 'save_workflow', 'run_workflow', 'get_run', 'cancel_run']);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(TOOLS.find((t) => t.name === 'validate_workflow')!.inputSchema.required).toEqual(['workflow']);
    expect(client.getInstructions()).toContain('"fromNode.outputPort -> toNode.inputPort"');
  });

  it('list_node_types: v1 nodes only by default; get_node_type gives ports, config schema and an example; agent prompts are not leaked', async () => {
    const names = (await call('list_node_types')).json.node_types.map((t: { name: string }) => t.name);
    expect(names).toContain('loop');
    expect(names).toContain('coding_agent');
    expect(names).not.toContain('join');
    expect(names).not.toContain('loop_in');
    expect((await call('list_node_types', { advanced: true })).json.node_types.map((t: { name: string }) => t.name)).toContain('join');
    const cond = (await call('get_node_type', { name: 'condition' })).json;
    expect(cond.example.edges).toContain('gate.true -> report.headline');
    const agent = (await call('get_node_type', { name: 'coding_agent' })).json;
    expect(agent.inputs.tasks).toBeTruthy();
    expect(agent.system_prompt).toBeUndefined();
    expect(agent.permissions_locked).toContain('cannot be overridden');
    const unknown = await call('get_node_type', { name: 'codng_agent' });
    expect(unknown.isError).toBe(true);
  });

  it('validate_workflow returns errors with fixes; save_workflow rejects invalid documents and writes nothing', async () => {
    const bad = (await call('validate_workflow', { workflow: brokenWorkflow() })).json;
    expect(bad.ok).toBe(false);
    for (const e of bad.errors) expect(e.fix).toBeTruthy();
    expect(JSON.stringify(bad.errors)).toContain('planner.tasks -> fix_loop.tasks');
    const rej = await call('save_workflow', { id: 'broken', workflow: brokenWorkflow() });
    expect(rej.isError).toBe(true);
    expect(rej.json.saved).toBe(false);
    expect(fs.existsSync(path.join(wfDir, 'broken.json'))).toBe(false);
    expect((await call('save_workflow', { id: '../evil', workflow: fixedWorkflow() })).isError).toBe(true);
  });

  it('save → list → get → run → get_run summary', async () => {
    expect((await call('save_workflow', { id: 'demo2', workflow: fixedWorkflow() })).json.ok).toBe(true);
    expect((await call('list_workflows')).json.map((w: { id: string }) => w.id)).toContain('demo2');
    const got = (await call('get_workflow', { id: 'demo2' })).json;
    expect(got.version).toBe(1);
    expect(got.edges).toContain('planner.tasks -> fix_loop.tasks');
    const started = (await call('run_workflow', { workflow_id: 'demo2', inputs: { request: 'x', repository: 'y' }, pass_on: 1, mock_delay_ms: 0, workspace: WS })).json;
    expect(started.run_id).toMatch(/^run_/);
    const run = await waitRun(started.run_id);
    expect(run.status).toBe('success');
    expect(run.ended_at).toEqual(['end_ok']);
    const byKey = Object.fromEntries(run.nodes.map((n: { key: string }) => [n.key, n]));
    expect(byKey['fix_loop#0/coder'].attempts).toBe(2); // flaky mock coder retried
    expect(byKey['fix_loop#1/tester'].outputs.passed).toBe(true);
    expect(byKey.end_fail.status).toBe('skipped');
    expect((await call('get_run', { run_id: 'run_nope' })).isError).toBe(true);
  });

  it('run_workflow with an inline invalid workflow fails with errors; scenario fail ends on end_fail', async () => {
    const bad = await call('run_workflow', { workflow: brokenWorkflow() });
    expect(bad.isError).toBe(true);
    expect(bad.json.errors.length).toBeGreaterThan(0);
    const started = (await call('run_workflow', { workflow: fixedWorkflow(), scenario: 'fail', mock_delay_ms: 0, workspace: WS })).json;
    const run = await waitRun(started.run_id);
    expect(run.status).toBe('failed');
    expect(run.ended_at).toEqual(['end_fail']);
  });

  it('cancel_run stops a running run', async () => {
    const started = (await call('run_workflow', { workflow_id: 'fix-until-tests-pass', mock_delay_ms: 200, workspace: WS })).json;
    const c = await call('cancel_run', { run_id: started.run_id });
    expect(c.json.ok).toBe(true);
    const run = await waitRun(started.run_id);
    expect(run.status).toBe('cancelled');
    expect((await call('cancel_run', { run_id: started.run_id })).isError).toBe(true);
  });

  it('summarizeRun works on a partial event stream (running run)', () => {
    const s = summarizeRun([
      { seq: 1, ts: 0, run_id: 'r', type: 'node_started', node_id: 'a', key: 'r/root/a' },
      { seq: 2, ts: 0, run_id: 'r', type: 'node_succeeded', node_id: 'b', key: 'r/root/b', data: { outputs: { x: 1 }, duration_ms: 3, attempts: 1 } },
    ]);
    expect(s.status).toBe('running');
    expect(s.nodes).toEqual([
      { key: 'a', node: 'a', status: 'running' },
      { key: 'b', node: 'b', status: 'success', duration_ms: 3, attempts: 1, outputs: { x: 1 } },
    ]);
  });
});

describe('MCP over Streamable HTTP (POST /mcp) and the HTTP backend proxy', () => {
  let base = '';
  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  it('a Streamable HTTP client can list tools and validate', async () => {
    const c = new Client({ name: 'http-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    expect((await c.listTools()).tools).toHaveLength(9);
    expect((await call('validate_workflow', { workflow: fixedWorkflow() }, c)).json.ok).toBe(true);
    await c.close();
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('httpBackend (WORKFLOW_BACKEND_URL mode) talks to a running backend', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'proxy', version: '1' });
    await createMcpServer(httpBackend(base + '/')).connect(a);
    await c.connect(b);
    const started = (await call('run_workflow', { workflow_id: 'fix-until-tests-pass', mock_delay_ms: 0, workspace: WS }, c)).json;
    expect((await waitRun(started.run_id, c)).status).toBe('success');
    await c.close();
  });
});
