import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { WorkspaceError, beginWorkspace, parseWorkspaceRoots, resolveWorkspace, writeWorkspaceFile } from '../src/workspace.js';
import { toolsFor } from '../src/workspace-policy.js';
import { compileWorkflow } from '../src/compiler.js';
import { runWorkflow } from '../src/engine.js';
import { MockAgentRuntime } from '../src/runtime/mock.js';
import type { AgentRunRequest } from '../src/runtime/types.js';
import { buildServer } from '../src/server/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { injectBackend } from '../src/mcp/backend.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registry, root, tmpWorkspace } from './helpers.js';
import { v1 } from './v1/v1helpers.js';

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkspaceError);
    return e as WorkspaceError;
  }
  throw new Error('expected WorkspaceError');
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

describe('WORKSPACE_ROOTS allowlist + resolveWorkspace', () => {
  const rootDir = tmpWorkspace('awf-root-');
  const outside = tmpWorkspace('awf-outside-');
  fs.mkdirSync(path.join(rootDir, 'repo/sub'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'file.txt'), 'x');
  fs.symlinkSync(outside, path.join(rootDir, 'escape'));
  fs.symlinkSync(path.join(rootDir, 'repo'), path.join(rootDir, 'alias'));
  fs.mkdirSync(rootDir + '-evil', { recursive: true });

  it('parses a path-delimited list with ~, resolves symlinks, skips missing dirs', () => {
    const home = tmpWorkspace('awf-home-');
    fs.mkdirSync(path.join(home, 'code'));
    const link = path.join(tmpWorkspace('awf-link-'), 'root-link');
    fs.symlinkSync(rootDir, link);
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(parseWorkspaceRoots(['~/code', link, '/definitely/not/here', ''].join(path.delimiter))).toEqual([path.join(home, 'code'), rootDir]);
      expect(resolveWorkspace('~/code', parseWorkspaceRoots('~'))).toBe(path.join(home, 'code'));
    } finally {
      process.env.HOME = saved;
    }
    expect(parseWorkspaceRoots('')).toEqual([]);
    expect(parseWorkspaceRoots(undefined)).toEqual([]);
  });

  it('rejects everything when WORKSPACE_ROOTS is unset, with a how-to fix', () => {
    const e = err(() => resolveWorkspace(path.join(rootDir, 'repo'), []));
    expect(e.message).toMatch(/WORKSPACE_ROOTS is not set/);
    expect(e.fix).toMatch(/WORKSPACE_ROOTS=/);
  });

  it('accepts dirs inside a root (returns the realpath, also via an in-root symlink)', () => {
    expect(resolveWorkspace(path.join(rootDir, 'repo'), [rootDir])).toBe(path.join(rootDir, 'repo'));
    expect(resolveWorkspace(rootDir, [rootDir])).toBe(rootDir);
    expect(resolveWorkspace(path.join(rootDir, 'alias/sub'), [rootDir])).toBe(path.join(rootDir, 'repo/sub'));
  });

  it('rejects traversal, sibling-prefix dirs, symlink escapes, files, missing and relative paths', () => {
    expect(err(() => resolveWorkspace(path.join(rootDir, 'repo/../..', path.basename(outside)), [rootDir])).message).toMatch(/outside WORKSPACE_ROOTS/);
    expect(err(() => resolveWorkspace(`${rootDir}/repo/../../${path.basename(rootDir)}-evil`, [rootDir])).message).toMatch(/outside WORKSPACE_ROOTS/);
    expect(err(() => resolveWorkspace(rootDir + '-evil', [rootDir])).message).toMatch(/outside WORKSPACE_ROOTS/);
    const sym = err(() => resolveWorkspace(path.join(rootDir, 'escape'), [rootDir]));
    expect(sym.message).toMatch(/resolves to/);
    expect(sym.fix).toContain(rootDir);
    expect(err(() => resolveWorkspace(path.join(rootDir, 'file.txt'), [rootDir])).message).toMatch(/not a directory/);
    expect(err(() => resolveWorkspace(path.join(rootDir, 'nope'), [rootDir])).message).toMatch(/does not exist/);
    expect(err(() => resolveWorkspace('repo', [rootDir])).message).toMatch(/absolute/);
    expect(err(() => resolveWorkspace(42, [rootDir])).message).toMatch(/non-empty path/);
    expect(err(() => resolveWorkspace(`${rootDir}/repo\0`, [rootDir])).message).toMatch(/non-empty path/);
  });

  it('writeWorkspaceFile (mock writes) cannot leave the workspace', async () => {
    const ws = path.join(rootDir, 'repo');
    await writeWorkspaceFile(ws, 'a/b.txt', 'hi');
    expect(fs.readFileSync(path.join(ws, 'a/b.txt'), 'utf8')).toBe('hi');
    await expect(writeWorkspaceFile(ws, '../../x.txt', 'no')).rejects.toThrow(/outside the workspace/);
    fs.symlinkSync(outside, path.join(ws, 'out'));
    await expect(writeWorkspaceFile(ws, 'out/x.txt', 'no')).rejects.toThrow(/symlinked dir/);
    expect(fs.existsSync(path.join(outside, 'x.txt'))).toBe(false);
  });
});

describe('node-level workspace permission', () => {
  it('maps none / read / write to tools', () => {
    const all = ['Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write', 'Bash', 'NotebookEdit', 'WebSearch'];
    expect(toolsFor('none', all).allowed).toEqual(['WebSearch']);
    expect(toolsFor('read', all)).toEqual({ allowed: ['Read', 'Glob', 'Grep', 'LS', 'WebSearch'], removed: ['Edit', 'MultiEdit', 'Write', 'Bash', 'NotebookEdit'] });
    expect(toolsFor('write', all)).toEqual({ allowed: all, removed: [] });
  });

  it('agent YAMLs: planning/report/risk_review = read, coding/testing = write; invalid values are rejected', () => {
    const reg = registry();
    expect(Object.fromEntries(['planning_agent', 'report_agent', 'risk_review_agent', 'coding_agent', 'testing_agent', 'producer'].map((n) => [n, reg.get(n)!.workspace ?? 'none']))).toEqual({
      planning_agent: 'read', report_agent: 'read', risk_review_agent: 'read', coding_agent: 'write', testing_agent: 'write', producer: 'none',
    });
    expect(() => reg.register({ name: 'bad', runtime: 'mock', workspace: 'admin' })).toThrow(/workspace must be none \| read \| write/);
  });

  const wf = v1(
    [
      { id: 'planner', type: 'planning_agent', inputs: { request: 'x', repository: 'y' } },
      { id: 'coder', type: 'coding_agent' },
      { id: 'p', type: 'producer' },
    ],
    ['planner.tasks -> coder.tasks'],
  );

  it('compiler: workspace is policy-locked; WORKSPACE_REQUIRED when the run has none; requirement reported', () => {
    const locked = compileWorkflow(v1([{ id: 'planner', type: 'planning_agent', inputs: { request: 'x', repository: 'y' }, config: { workspace: 'write' } }], []), registry());
    expect(locked.errors.map((e) => e.code)).toContain('POLICY_OVERRIDE');
    const ok = compileWorkflow(wf, registry());
    expect(ok.errors).toEqual([]);
    expect(ok.workspace_required).toBe('write');
    expect(ok.workspace_nodes).toEqual([{ node: 'planner', access: 'read' }, { node: 'coder', access: 'write' }]);
    const missing = compileWorkflow(wf, registry(), { workspace: false });
    expect(missing.errors).toEqual([expect.objectContaining({ code: 'WORKSPACE_REQUIRED', fix: expect.stringContaining('WORKSPACE_ROOTS') })]);
    expect(compileWorkflow(v1([{ id: 'p', type: 'producer' }], []), registry(), { workspace: false }).ok).toBe(true);
    // loop body 裡的 agent 也算（demo workflow）
    const demo = JSON.parse(fs.readFileSync(path.join(root, 'workflows/fix-until-tests-pass.json'), 'utf8'));
    const d = compileWorkflow(demo, registry());
    expect(d.workspace_required).toBe('write');
    expect(d.workspace_nodes.map((x) => x.node)).toEqual(expect.arrayContaining(['planner', 'fix_loop.body/coder', 'fix_loop.body/tester']));
  });

  it('engine: workingDirectory only for read/write agents, tools filtered, no process.cwd() fallback', async () => {
    const seen: Record<string, AgentRunRequest> = {};
    const rt = new MockAgentRuntime({
      planning_agent: (req) => ((seen.planner = req), { plan: 'p', tasks: [{ id: 'T', title: 't', files: [] }], acceptance_criteria: [] }),
      coding_agent: (req) => ((seen.coder = req), { files_modified: [], summary: 's' }),
      producer: (req) => ((seen.p = req), { text: 't', count: 1, tags: [] }),
    });
    const ws = tmpWorkspace();
    const c = compileWorkflow(wf, registry(), { workspace: true });
    const res = await runWorkflow(c.graph!, {}, { runtime: rt, workspace: ws, runId: 'r' });
    expect(res.status).toBe('success');
    expect(seen.planner).toMatchObject({ workingDirectory: ws, workspaceAccess: 'read', allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: [] });
    expect(seen.coder).toMatchObject({ workingDirectory: ws, workspaceAccess: 'write', allowedTools: ['Read', 'Edit', 'Write', 'Bash'] });
    expect(seen.p.workingDirectory).toBeUndefined();
    expect(seen.p.workspaceAccess).toBe('none');
    expect(res.records.find((r) => r.node_id === 'coder')?.workspace_access).toBe('write');

    // registry 給 read 但 allowed_tools 帶了 Bash → 執行時被拿掉
    const reg = registry();
    reg.register({ name: 'sneaky_reader', runtime: 'mock', workspace: 'read', allowed_tools: ['Read', 'Bash', 'Edit'], outputs: { ok: { type: 'boolean' } } });
    reg.register({ name: 'no_ws', runtime: 'mock', allowed_tools: ['Read', 'Write', 'WebSearch'], outputs: { ok: { type: 'boolean' } } });
    const got: Record<string, AgentRunRequest> = {};
    const rt2 = new MockAgentRuntime({ sneaky_reader: (r) => ((got.s = r), { ok: true }), no_ws: (r) => ((got.n = r), { ok: true }) });
    await runWorkflow(compileWorkflow(v1([{ id: 's', type: 'sneaky_reader' }, { id: 'n', type: 'no_ws' }], []), reg).graph!, {}, { runtime: rt2, workspace: ws });
    expect(got.s).toMatchObject({ allowedTools: ['Read'], disallowedTools: ['Bash', 'Edit'] });
    expect(got.n).toMatchObject({ workingDirectory: undefined, allowedTools: ['WebSearch'], disallowedTools: ['Read', 'Write'] });
  });

  it('engine: read/write agents fail with a clear error when the run has no workspace', async () => {
    const rt = new MockAgentRuntime();
    const res = await runWorkflow(compileWorkflow(wf, registry()).graph!, {}, { runtime: rt, runId: 'r' });
    expect(res.status).toBe('failed');
    const planner = res.records.find((r) => r.node_id === 'planner')!;
    expect(planner.status).toBe('failed');
    expect(planner.error).toMatch(/needs read access to a workspace but this run has none/);
    expect(res.records.find((r) => r.node_id === 'p')?.status).toBe('success');
  });
});

describe('workspace monitoring (snapshot → changed files + diff stat)', () => {
  it('non-git dir: added / modified / deleted via mtime + hash, with limits', async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'keep.txt'), 'same\n');
    fs.writeFileSync(path.join(ws, 'edit.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(ws, 'gone.txt'), '1\n2\n3\n');
    fs.mkdirSync(path.join(ws, 'node_modules/x'), { recursive: true });
    const s = await beginWorkspace(ws, 'write');
    expect(s.report).toEqual({ path: ws, required: 'write' });
    fs.writeFileSync(path.join(ws, 'edit.txt'), 'a\nc\n');
    fs.rmSync(path.join(ws, 'gone.txt'));
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src/new.ts'), 'x\ny\n');
    fs.writeFileSync(path.join(ws, 'node_modules/x/ignored.js'), '1');
    const r = await s.finish();
    expect(r.git).toBeUndefined();
    expect(r.changed_files).toEqual([
      { path: 'edit.txt', status: 'modified' },
      { path: 'gone.txt', status: 'deleted', insertions: 0, deletions: 3 },
      { path: 'src/new.ts', status: 'added', insertions: 2, deletions: 0 },
    ]);
    expect(r.diff_stat).toEqual({ files: 3, insertions: 2, deletions: 3 });

    const big = tmpWorkspace();
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(big, `f${i}`), String(i));
    const t = await beginWorkspace(big, undefined, { maxFiles: 5, maxChanged: 2 });
    expect(t.report.truncated).toBe(true);
    for (let i = 10; i < 14; i++) fs.writeFileSync(path.join(big, `g${i}`), String(i));
    const tr = await t.finish();
    expect(tr.truncated).toBe(true);
    expect(tr.changed_files!.length).toBeLessThanOrEqual(2);
    expect(tr.changed_files!.every((c) => c.status !== 'deleted')).toBe(true);
  });

  it('git repo: branch + HEAD at start; only files changed during the run (pre-existing dirt ignored), incl. commits made during the run', async () => {
    const ws = tmpWorkspace();
    git(ws, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(ws, 'c.txt'), 'c\n');
    fs.writeFileSync(path.join(ws, '.gitignore'), 'build/\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    const head = git(ws, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(ws, 'b.txt'), 'b dirty before run\n'); // 開始前就 dirty，run 沒動 → 不列
    fs.writeFileSync(path.join(ws, 'pre.txt'), 'untracked before\n');
    const s = await beginWorkspace(ws, 'write');
    expect(s.report.git).toEqual({ branch: 'main', head });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'one\nTWO\nthree\n');
    fs.rmSync(path.join(ws, 'c.txt'));
    fs.writeFileSync(path.join(ws, 'new.txt'), 'n1\nn2\n');
    fs.mkdirSync(path.join(ws, 'build'));
    fs.writeFileSync(path.join(ws, 'build/out.js'), 'ignored');
    fs.writeFileSync(path.join(ws, 'd.txt'), 'committed during run\n');
    git(ws, 'add', 'd.txt');
    git(ws, 'commit', '-q', '-m', 'agent commit');
    const r = await s.finish();
    expect(r.error).toBeUndefined();
    expect(r.git!.head_after).not.toBe(head);
    expect(r.changed_files).toEqual([
      { path: 'a.txt', status: 'modified', insertions: 2, deletions: 1 },
      { path: 'c.txt', status: 'deleted', insertions: 0, deletions: 1 },
      { path: 'd.txt', status: 'added', insertions: 1, deletions: 0 },
      { path: 'new.txt', status: 'added', insertions: 2, deletions: 0 },
    ]);
    expect(r.diff_stat).toEqual({ files: 4, insertions: 5, deletions: 2 });
  });

  it('git: workspace may be a subdirectory (paths relative to it); repo without commits works', async () => {
    const ws = tmpWorkspace();
    git(ws, 'init', '-q', '-b', 'dev');
    fs.mkdirSync(path.join(ws, 'pkg'));
    const s = await beginWorkspace(path.join(ws, 'pkg'));
    expect(s.report.git).toEqual({ branch: 'dev', head: null });
    fs.writeFileSync(path.join(ws, 'pkg/x.ts'), 'x\n');
    fs.writeFileSync(path.join(ws, 'outside-pkg.txt'), 'y\n');
    const r = await s.finish();
    expect(r.changed_files).toEqual([{ path: 'x.ts', status: 'added', insertions: 1, deletions: 0 }]);
  });
});

describe('workspace over REST + MCP', () => {
  const rootDir = tmpWorkspace('awf-srv-root-');
  const outside = tmpWorkspace('awf-srv-out-');
  const repo = path.join(rootDir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'feature/x');
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const app = buildServer({ root, runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ws-runs-')), mockDelayMs: 0, workspaceRoots: [rootDir] });
  const noRoots = buildServer({ root, runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ws-runs-')), mockDelayMs: 0, workspaceRoots: [] });
  const post = (a: typeof app, url: string, payload: unknown) => a.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
  const waitDone = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = (await app.inject(`/api/runs/${id}`)).json();
      if (r.meta.status !== 'running') return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('timeout');
  };

  it('400 with a fix for bad workspaces; 422 WORKSPACE_REQUIRED without one', async () => {
    const out = await post(app, '/api/runs', { workflow_id: 'fix-until-tests-pass', workspace: outside });
    expect(out.statusCode).toBe(400);
    expect(out.json()).toMatchObject({ error: expect.stringContaining('outside WORKSPACE_ROOTS'), fix: expect.stringContaining(rootDir) });
    expect((await post(app, '/api/runs', { workflow_id: 'fix-until-tests-pass', workspace: `${repo}/../../${path.basename(outside)}` })).statusCode).toBe(400);
    expect((await post(app, '/api/runs', { workflow_id: 'fix-until-tests-pass', workspace: 7 })).statusCode).toBe(400);
    const unset = await post(noRoots, '/api/runs', { workflow_id: 'fix-until-tests-pass', workspace: repo });
    expect(unset.statusCode).toBe(400);
    expect(unset.json().error).toMatch(/WORKSPACE_ROOTS is not set/);
    const missing = await post(app, '/api/runs', { workflow_id: 'fix-until-tests-pass' });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors[0].code).toBe('WORKSPACE_REQUIRED');
    const v = (await post(app, '/api/validate', { workflow: JSON.parse(fs.readFileSync(path.join(root, 'workflows/fix-until-tests-pass.json'), 'utf8')) })).json();
    expect(v).toMatchObject({ ok: true, workspace_required: 'write' });
    expect((await post(app, '/api/validate', { workflow: { version: 1, nodes: [], edges: [] }, workspace: outside })).statusCode).toBe(400);
    expect((await app.inject('/api/health')).json().workspace_roots).toEqual([rootDir]);
  });

  it('run record: workspace path, git branch/HEAD, changed files from the mock coding agent', async () => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const start = await post(app, '/api/runs', { workflow_id: 'fix-until-tests-pass', workspace: repo, mock_writes: true, pass_on: 1, mock_delay_ms: 0 });
    expect(start.statusCode).toBe(202);
    const r = await waitDone(start.json().run_id);
    expect(r.meta.status).toBe('success');
    expect(r.meta.workspace).toMatchObject({ path: repo, required: 'write', git: { branch: 'feature/x', head, head_after: head } });
    expect(r.meta.workspace.changed_files).toEqual([
      { path: 'agent-workflow-demo/CHANGELOG.md', status: 'added', insertions: 2, deletions: 0 },
      { path: 'agent-workflow-demo/iteration-0.md', status: 'added', insertions: 3, deletions: 0 },
      { path: 'agent-workflow-demo/iteration-1.md', status: 'added', insertions: 3, deletions: 0 },
    ]);
    expect(r.meta.workspace.diff_stat).toEqual({ files: 3, insertions: 8, deletions: 0 });
    // 執行紀錄列表也有
    expect((await app.inject('/api/runs')).json().find((m: { run_id: string }) => m.run_id === r.meta.run_id).workspace.diff_stat.files).toBe(3);
    // 沒開 mock_writes：mock 不寫檔 → 沒有變更
    const quiet = await waitDone((await post(app, '/api/runs', { workflow_id: 'fix-until-tests-pass', workspace: repo, pass_on: 0, mock_delay_ms: 0 })).json().run_id);
    expect(quiet.meta.workspace.changed_files).toEqual([]);
  });

  it('MCP run_workflow: outside root → tool error with fix; get_run shows workspace', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(injectBackend(app)).connect(a);
    const c = new Client({ name: 'ws', version: '1' });
    await c.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { json: JSON.parse(r.content[0].text), isError: !!r.isError };
    };
    const bad = await call('run_workflow', { workflow_id: 'fix-until-tests-pass', workspace: outside });
    expect(bad.isError).toBe(true);
    expect(bad.json.fix).toContain(rootDir);
    const ok = await call('run_workflow', { workflow_id: 'fix-until-tests-pass', workspace: repo, mock_delay_ms: 0, pass_on: 0 });
    await waitDone(ok.json.run_id);
    const run = (await call('get_run', { run_id: ok.json.run_id })).json;
    expect(run.workspace).toMatchObject({ path: repo, git: { branch: 'feature/x' }, changed_files: [], diff_stat: { files: 0 } });
    const tools = (await c.listTools()).tools;
    const rw = tools.find((t) => t.name === 'run_workflow')!;
    expect(Object.keys((rw.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(['workspace', 'mock_writes']));
    expect(rw.description).toMatch(/WORKSPACE_ROOTS/);
    await c.close();
  });
});
