import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileWorkflow } from './adv.js';
import { runWorkflow } from './adv.js';
import { MockAgentRuntime } from '../../src/runtime/mock.js';
import { createSandboxFs, createWorkflowLoader } from '../../src/services-node.js';
import type { RunServices } from '../../src/services.js';
import type { WorkflowGraph, WorkflowNode } from '../../src/types.js';
import { ctl, data, n, registry, wf } from '../helpers.js';

const reg = registry();

// stub HTTP server 在 127.0.0.1：預設允許私有位址；SSRF 測試另外傳 services
async function exec(w: WorkflowGraph, inputs: Record<string, unknown> = {}, services: RunServices = { httpAllowPrivate: true }, runtime = new MockAgentRuntime()) {
  const c = compileWorkflow(w, reg);
  expect(c.errors).toEqual([]);
  const res = await runWorkflow(c.graph!, inputs, { runtime, runId: 'r', services });
  const rec = (key: string) => res.records.find((r) => r.key === `r/${key}`)!;
  return { res, rec, end: (id = 'end') => rec(`root/${id}`)?.outputs };
}

const start = (outputs: Record<string, unknown>): WorkflowNode => n('start', 'start', { ports: { outputs: outputs as never } });
const end = (inputs: Record<string, unknown>, status = 'success'): WorkflowNode => n('end', 'end', { ports: { inputs: inputs as never }, config: { status } });
const errorsOf = (w: WorkflowGraph) => compileWorkflow(w, reg).errors.map((e) => `${e.code}: ${e.message}`);

describe('config_schema validation (registry → Ajv)', () => {
  it('rejects unknown keys, bad enums and out-of-range numbers', () => {
    const errs = errorsOf(
      wf(
        [
          n('a', 'delay', { config: { ms: -1 } }),
          n('b', 'merge', { config: { inputs: 2, mode: 'zip' } }),
          n('c', 'http_request', { config: { method: 'GET', surprise: true } }),
        ],
        [],
      ),
    );
    expect(errs.some((e) => e.startsWith('INVALID_CONFIG: delay "a"'))).toBe(true);
    expect(errs.some((e) => e.includes('merge "b"') && e.includes('allowed values'))).toBe(true);
    expect(errs.some((e) => e.includes('http_request "c"') && e.includes('additional'))).toBe(true);
  });

  it('agent nodes: only instance_overridable fields (max_turns / timeout / retry) may be set per node', () => {
    expect(reg.get('coding_agent')!.instance_overridable).toEqual(['max_turns', 'timeout_seconds', 'retry']);
    expect(errorsOf(wf([n('c', 'coding_agent', { config: { max_turns: 5, retry: { max_attempts: 2, backoff_ms: 0 } } })], []))).not.toContainEqual(expect.stringContaining('INVALID_CONFIG'));
    const errs = errorsOf(wf([n('c', 'coding_agent', { config: { model: 'x', max_turns: 0 } })], []));
    expect(errs.some((e) => e.startsWith('POLICY_OVERRIDE'))).toBe(true);
    expect(errs.some((e) => e.startsWith('INVALID_CONFIG') && e.includes('max_turns'))).toBe(true);
  });

  it('JSONata syntax errors and switch case name clashes are caught at compile time', () => {
    expect(errorsOf(wf([n('t', 'transform', { config: { expression: 'items[' } })], [])).some((e) => e.includes('JSONata syntax error'))).toBe(true);
    const errs = errorsOf(wf([n('s', 'switch', { config: { cases: [{ name: 'a', rule: { op: 'truthy' } }, { name: 'a', rule: { op: 'falsy' } }] } })], []));
    expect(errs.some((e) => e.includes('duplicate case names'))).toBe(true);
  });

  it('output_overrides: an instance may narrow an any-typed output, but not add other ports', () => {
    const base = (ports?: unknown) =>
      wf(
        [start({ obj: { type: 'object' } }), n('t', 'transform', { config: { expression: 'name' }, ...(ports ? { ports: ports as never } : {}) }), n('x', 'needs_text')],
        [ctl('start.success', 't'), data('start.obj', 't.input'), ctl('t.success', 'x'), data('t.result', 'x.text')],
      );
    expect(errorsOf(base()).some((e) => e.startsWith('TYPE_MISMATCH'))).toBe(true);
    expect(errorsOf(base({ outputs: { result: { type: 'string' } } }))).toEqual([]);
    expect(errorsOf(base({ outputs: { extra: { type: 'string' } } })).some((e) => e.startsWith('DYNAMIC_PORTS_NOT_ALLOWED'))).toBe(true);
  });
});

describe('logic nodes', () => {
  it('Switch fires the first matching case, else default; dynamic control outputs come from config.cases', async () => {
    const mk = (v: number) =>
      exec(
        wf(
          [
            start({ v: { type: 'number' } }),
            n('sw', 'switch', { config: { cases: [{ name: 'small', rule: { op: 'lt', value: 10 } }, { name: 'big', rule: { op: 'gte', value: 100 } }] } }),
            n('a', 'log', { config: { label: 'small' } }),
            n('b', 'log', { config: { label: 'big' } }),
            n('c', 'log', { config: { label: 'mid' } }),
          ],
          [ctl('start.success', 'sw'), data('start.v', 'sw.value'), ctl('sw.small', 'a'), ctl('sw.big', 'b'), ctl('sw.default', 'c'), data('sw.value', 'a.message'), data('sw.value', 'b.message'), data('sw.value', 'c.message')],
        ),
        { v },
      );
    const r1 = await mk(3);
    expect([r1.rec('root/a').status, r1.rec('root/b').status, r1.rec('root/c').status]).toEqual(['success', 'skipped', 'skipped']);
    expect(r1.rec('root/sw').outputs).toEqual({ value: 3, matched: ['small'] });
    const r2 = await mk(50);
    expect(r2.rec('root/c').status).toBe('success');
    expect(r2.res.events.some((e) => e.type === 'log' && e.data?.message === 'mid: 50')).toBe(true);
  });

  it('Condition + Merge(first) converges two branches into one value', async () => {
    const run = (v: number) =>
      exec(
        wf(
          [
            start({ v: { type: 'number' } }),
            n('gate', 'condition', { config: { rule: { op: 'gt', value: 0 } } }),
            n('pos', 'transform', { config: { expression: '"positive " & $string($input)' }, ports: { outputs: { result: { type: 'string' } } } }),
            n('neg', 'transform', { config: { expression: '"non-positive " & $string($input)' }, ports: { outputs: { result: { type: 'string' } } } }),
            n('m', 'merge', { config: { inputs: 2, mode: 'first' }, ports: { outputs: { merged: { type: 'string' } } } }),
            n('j', 'join', { config: { policy: 'any' } }),
            end({ text: { type: 'string' } }),
          ],
          [
            ctl('start.success', 'gate'), data('start.v', 'gate.value'),
            ctl('gate.true', 'pos'), ctl('gate.false', 'neg'), data('start.v', 'pos.input'), data('start.v', 'neg.input'),
            data('pos.result', 'm.in_1'), data('neg.result', 'm.in_2'),
            ctl('pos.success', 'j.in'), ctl('neg.success', 'j.in'), ctl('j.success', 'end'), data('m.merged', 'end.text'),
          ],
        ),
        { v },
      );
    expect((await run(5)).end()).toMatchObject({ text: 'positive 5' });
    expect((await run(-1)).end()).toMatchObject({ text: 'non-positive -1' });
  });

  it('Merge(array/object) with config.inputs = 3 exposes in_1..in_3', async () => {
    const c = compileWorkflow(wf([n('m', 'merge', { config: { inputs: 3, mode: 'object' } })], []), reg);
    expect(Object.keys(c.graph!.nodes.get('m')!.inputs)).toEqual(['in_1', 'in_2', 'in_3']);
    const { end: out } = await exec(
      wf(
        [start({ a: { type: 'string' }, b: { type: 'integer' } }), n('m', 'merge', { config: { inputs: 3, mode: 'object' }, ports: { outputs: { merged: { type: 'object' } } } }), end({ o: { type: 'object' } })],
        [ctl('start.success', 'end'), data('start.a', 'm.in_1'), data('start.b', 'm.in_3'), data('m.merged', 'end.o')],
      ),
      { a: 'x', b: 2 },
    );
    expect(out()).toMatchObject({ o: { in_1: 'x', in_3: 2 } });
  });

  it('Join with config.inputs expands control inputs to in_1..in_N (policy all)', async () => {
    const c = compileWorkflow(wf([n('j', 'join', { config: { inputs: 3 } })], []), reg);
    expect(c.graph!.nodes.get('j')!.controlInputs).toEqual(['in_1', 'in_2', 'in_3']);
    const { rec } = await exec(
      wf(
        [start({}), n('a', 'delay', { config: { ms: 5 } }), n('b', 'delay', { config: { ms: 1 } }), n('j', 'join', { config: { inputs: 2 } }), end({})],
        [ctl('start.success', 'a'), ctl('start.success', 'b'), ctl('a.success', 'j.in_1'), ctl('b.success', 'j.in_2'), ctl('j.success', 'end')],
      ),
    );
    expect(rec('root/j').status).toBe('success');
    expect(rec('root/end').status).toBe('success');
  });

  it('Transform (JSONata) maps / filters data without eval; runtime errors fail the node', async () => {
    const { rec } = await exec(
      wf(
        [start({ order: { type: 'object' } }), n('t', 'transform', { config: { expression: '{"names": items[price > 10].name, "total": $sum(items.price)}' } })],
        [ctl('start.success', 't'), data('start.order', 't.input')],
      ),
      { order: { items: [{ name: 'a', price: 5 }, { name: 'b', price: 20 }, { name: 'c', price: 30 }] } },
    );
    expect(rec('root/t').outputs).toEqual({ result: { names: ['b', 'c'], total: 55 } });
    const bad = await exec(wf([start({ x: { type: 'object' } }), n('t', 'transform', { config: { expression: '$number("abc") + $error("boom")' } })], [ctl('start.success', 't'), data('start.x', 't.input')]), { x: {} });
    expect(bad.rec('root/t').status).toBe('failed');
    expect(bad.res.status).toBe('failed');
  });

  it('Filter keeps / rejects array items by rule.path', async () => {
    const { rec } = await exec(
      wf([start({ xs: { type: 'array' } }), n('f', 'filter', { config: { rule: { op: 'gte', value: 2, path: 'n' } } })], [ctl('start.success', 'f'), data('start.xs', 'f.items')]),
      { xs: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    );
    expect(rec('root/f').outputs).toEqual({ items: [{ n: 2 }, { n: 3 }], rejected: [{ n: 1 }], count: 2 });
  });

  it('Foreach runs the body once per item in its own iteration scope and collects loop_out values', async () => {
    const rt = new MockAgentRuntime({ needs_text: ({ inputs, iteration }) => ({ echo: `${inputs.text}#${iteration}` }) });
    const body = wf(
      [n('in', 'loop_in'), n('agent', 'needs_text'), n('out', 'loop_out')],
      [ctl('in.success', 'agent'), data('in.item', 'agent.text'), ctl('agent.success', 'out'), data('agent.echo', 'out.echo'), data('in.index', 'out.idx')],
    );
    const { rec, end: out } = await exec(
      wf(
        [
          start({ words: { type: 'array', items: { type: 'string' } } }),
          n('each', 'foreach', { ports: { inputs: { items: { type: 'array', items: { type: 'string' } } }, outputs: { echo: { type: 'string' }, idx: { type: 'integer' } } }, body }),
          end({ echoes: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' } }),
        ],
        [ctl('start.success', 'each'), data('start.words', 'each.items'), ctl('each.success', 'end'), data('each.echo', 'end.echoes'), data('each.count', 'end.count')],
      ),
      { words: ['a', 'b', 'c'] },
      {},
      rt,
    );
    expect(out()).toMatchObject({ echoes: ['a#0', 'b#1', 'c#2'], count: 3 });
    expect(rec('each#1/agent').inputs).toEqual({ text: 'b' });
  });

  it('Set (constants) + Template are pure data nodes', async () => {
    const { end: out } = await exec(
      wf(
        [
          start({}),
          n('k', 'set', { ports: { outputs: { who: { type: 'string' }, n: { type: 'integer' } } }, config: { values: { who: 'Apple', n: 3 } } }),
          n('tpl', 'template', { ports: { inputs: { who: { type: 'string' }, n: { type: 'integer' } } }, config: { template: 'hi {{inputs.who}} x{{inputs.n}}' } }),
          end({ text: { type: 'string' } }),
        ],
        [ctl('start.success', 'end'), data('k.who', 'tpl.who'), data('k.n', 'tpl.n'), data('tpl.text', 'end.text')],
      ),
    );
    expect(out()).toMatchObject({ text: 'hi Apple x3' });
    expect(errorsOf(wf([n('k', 'set', { ports: { outputs: { n: { type: 'integer' } } }, config: { values: { n: 'x' } } })], [])).some((e) => e.includes('values.n'))).toBe(true);
  });

  it('Delay waits; Log emits a log event', async () => {
    const t0 = Date.now();
    const { res } = await exec(
      wf([start({ m: { type: 'string' } }), n('d', 'delay', { config: { ms: 40 } }), n('l', 'log', { config: { level: 'warn' } })], [ctl('start.success', 'd'), ctl('d.success', 'l'), data('start.m', 'd.value'), data('d.value', 'l.message')]),
      { m: 'hello' },
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(res.events.find((e) => e.type === 'log')).toMatchObject({ node_id: 'l', data: { level: 'warn', message: 'hello' } });
  });
});

describe('utility nodes', () => {
  let server: http.Server;
  let base = '';
  const seen: { method?: string; url?: string; body: string; ct?: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, ct: req.headers['content-type'] });
        if (req.url?.startsWith('/json')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: 1, q: req.url }));
        if (req.url === '/echo') return res.writeHead(201, { 'content-type': 'application/json' }).end(body);
        if (req.url === '/slow') return void setTimeout(() => res.end('late'), 500);
        if (req.url === '/text') return res.writeHead(200, { 'content-type': 'text/plain' }).end('```json\n{"a": [1,2]}\n```');
        res.writeHead(404).end('nope');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const httpWf = (cfg: Record<string, unknown>, extraNodes: WorkflowNode[] = [], extraEdges: ReturnType<typeof data>[] = []) =>
    wf([start({ body: { type: 'object' } }), n('h', 'http_request', { config: cfg }), ...extraNodes], [ctl('start.success', 'h'), ...extraEdges]);

  it('HTTP Request: GET with query, parses JSON (local stub server, no internet)', async () => {
    const { rec } = await exec(httpWf({ url: `${base}/json` }), { body: {} });
    expect(rec('root/h').outputs).toMatchObject({ status: 200, ok: true, body: { ok: 1, q: '/json' } });
  });

  it('HTTP Request: POST JSON body sets content-type', async () => {
    const { rec } = await exec(httpWf({ url: `${base}/echo`, method: 'POST' }, [], [data('start.body', 'h.body')]), { body: { x: 1 } });
    expect(rec('root/h').outputs).toMatchObject({ status: 201, body: { x: 1 } });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', ct: 'application/json' });
  });

  it('HTTP Request: timeout, non-2xx failure (→ failure port) and host allowlist', async () => {
    const slow = await exec(httpWf({ url: `${base}/slow`, timeout_ms: 100 }), { body: {} });
    expect(slow.rec('root/h')).toMatchObject({ status: 'failed' });
    expect(slow.rec('root/h').error).toContain('timeout after 100ms');

    const notFound = await exec(httpWf({ url: `${base}/missing` }, [n('fb', 'log', { config: { label: 'fallback' } })], [ctl('h.failure', 'fb'), data('h.status', 'fb.message')]), { body: {} });
    expect(notFound.rec('root/h').error).toContain('HTTP 404');
    expect(notFound.rec('root/h').outputs).toMatchObject({ status: 404, ok: false });
    expect(notFound.rec('root/fb')).toMatchObject({ status: 'success' });
    expect(notFound.res.status).toBe('success');

    const soft = await exec(httpWf({ url: `${base}/missing`, fail_on_http_error: false }), { body: {} });
    expect(soft.rec('root/h')).toMatchObject({ status: 'success', outputs: { status: 404, ok: false } });

    const blocked = await exec(httpWf({ url: `${base}/json` }), { body: {} }, { httpAllowHosts: ['api.example.com'] });
    expect(blocked.rec('root/h').error).toContain('host not in allowlist');
    expect(errorsOf(httpWf({ url: 'file:///etc/passwd' }))).toEqual([]); // protocol is checked at run time:
    expect((await exec(httpWf({ url: 'file:///etc/passwd' }), { body: {} })).rec('root/h').error).toContain('protocol not allowed');
  });

  it('JSON Parser extracts a fenced code block; Schema Validator routes valid / invalid', async () => {
    const schema = { type: 'object', properties: { a: { type: 'array', items: { type: 'integer' } } }, required: ['a'] };
    const mk = (s: unknown) =>
      wf(
        [
          n('h', 'http_request', { config: { url: `${base}/text` } }),
          n('p', 'json_parse', { config: {} }),
          n('v', 'schema_validate', { config: { schema: s } }),
          n('ok', 'log', { config: { label: 'ok' } }),
          n('bad', 'log', { config: { label: 'bad' } }),
        ],
        [ctl('h.success', 'p'), data('h.body', 'p.text'), ctl('p.success', 'v'), data('p.value', 'v.value'), ctl('v.valid', 'ok'), ctl('v.invalid', 'bad'), data('v.value', 'ok.message'), data('v.errors', 'bad.message')],
      );
    // h.body is any → json_parse.text is string: narrow with output_overrides
    const fixBody = (w: WorkflowGraph) => ((w.nodes[0].ports = { outputs: { body: { type: 'string' } } } as never), w);
    const good = await exec(fixBody(mk(schema)));
    expect(good.rec('root/p').outputs).toEqual({ value: { a: [1, 2] } });
    expect(good.rec('root/ok').status).toBe('success');
    expect(good.rec('root/bad').status).toBe('skipped');
    const bad = await exec(fixBody(mk({ ...schema, properties: { a: { type: 'array', items: { type: 'string' } } } })));
    expect(bad.rec('root/bad').status).toBe('success');
    expect(bad.rec('root/v').outputs).toMatchObject({ is_valid: false });
  });

  it('File read / write stay inside the sandbox', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sandbox-'));
    const sandbox = createSandboxFs(path.join(dir, 'ws'));
    const { rec } = await exec(
      wf(
        [start({ obj: { type: 'object' } }), n('w', 'file_write', { config: { path: 'out/result.json', format: 'json' } }), n('r', 'file_read', { config: { path: 'out/result.json', format: 'json' } })],
        [ctl('start.success', 'w'), data('start.obj', 'w.content'), ctl('w.success', 'r')],
      ),
      { obj: { hello: 'world' } },
      { fs: sandbox },
    );
    expect(rec('root/w').outputs).toMatchObject({ path: 'out/result.json' });
    expect(rec('root/r').outputs).toMatchObject({ content: { hello: 'world' } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ws/out/result.json'), 'utf8'))).toEqual({ hello: 'world' });

    await expect(sandbox.readFile('../secret')).rejects.toThrow(/escapes sandbox/);
    await expect(sandbox.readFile('/etc/passwd')).rejects.toThrow(/absolute paths/);
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
    fs.symlinkSync(dir, path.join(dir, 'ws/link'));
    await expect(sandbox.readFile('link/secret.txt')).rejects.toThrow(/symlink/);
    const noFs = await exec(wf([start({}), n('r', 'file_read', { config: { path: 'a.txt' } })], [ctl('start.success', 'r')]));
    expect(noFs.rec('root/r').error).toContain('sandboxed workspace');
  });

  it('Sub-workflow runs a saved workflow in its own scope and returns its end inputs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sub-'));
    fs.writeFileSync(
      path.join(dir, 'greet.json'),
      JSON.stringify(
        wf(
          [start({ name: { type: 'string' } }), n('tpl', 'template', { ports: { inputs: { name: { type: 'string' } } }, config: { template: 'Hello {{inputs.name}}' } }), end({ text: { type: 'string' } })],
          [ctl('start.success', 'end'), data('start.name', 'tpl.name'), data('tpl.text', 'end.text')],
        ),
      ),
    );
    fs.writeFileSync(path.join(dir, 'fails.json'), JSON.stringify(wf([start({}), end({}, 'failed')], [ctl('start.success', 'end')])));
    const services = { loadWorkflow: createWorkflowLoader(dir), registry: reg };
    const outer = (id: string) =>
      wf(
        [start({ who: { type: 'string' } }), n('sub', 'subflow', { config: { workflow: id }, ports: { inputs: { name: { type: 'string' } }, outputs: { text: { type: 'string' } } } }), n('fb', 'log', {})],
        [ctl('start.success', 'sub'), data('start.who', 'sub.name'), ctl('sub.failure', 'fb'), data('start.who', 'fb.message')],
      );
    const ok = await exec(outer('greet'), { who: 'Apple' }, services);
    expect(ok.rec('root/sub').outputs).toEqual({ text: 'Hello Apple' });
    expect(ok.rec('sub#0/tpl').status).toBe('success');
    const failed = await exec(outer('fails'), { who: 'x' }, services);
    expect(failed.rec('root/sub').status).toBe('failed');
    expect(failed.rec('root/fb').status).toBe('success');
  });
});
