import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertUrlAllowed, isPrivateAddress } from '../src/net-policy.js';
import { builtins } from '../src/nodes/builtins.js';
import type { RunServices } from '../src/services.js';
import { createSandboxFs } from '../src/services-node.js';
import { compileWorkflow } from '../src/compiler.js';
import { convertToV1 } from '../src/convert.js';
import { buildServer } from '../src/server/app.js';
import { registry, root } from './helpers.js';

/** 直接呼叫 http_request 節點（不經 compile），回傳 outputs 或 error message */
async function httpNode(url: string, services: RunServices) {
  try {
    const r = await builtins.http_request.execute!({ cn: {} as never, cfg: { url }, inputs: {}, services, signal: new AbortController().signal, log: () => {} });
    return { outputs: r.outputs };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

describe('SSRF: http_request private-address policy', () => {
  it('classifies private / loopback / link-local / mapped addresses', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '[::1]', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '224.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '1.1.1.1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('blocks localhost, private literals and their alternate spellings when no allowlist is set', async () => {
    for (const u of ['http://localhost/', 'http://api.localhost/', 'http://127.0.0.1:8080/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/'])
      await expect(assertUrlAllowed(new URL(u), {}), u).rejects.toThrow(/private\/loopback/);
    await expect(assertUrlAllowed(new URL('http://93.184.216.34/'), {})).resolves.toBeUndefined();
    await expect(assertUrlAllowed(new URL('file:///etc/passwd'), {})).rejects.toThrow(/protocol not allowed/);
  });

  it('checks DNS results (resolveHost), and honours allowlist / httpAllowPrivate', async () => {
    const resolveHost = async (h: string) => (h === 'evil.test' ? ['10.1.2.3'] : ['93.184.216.34']);
    await expect(assertUrlAllowed(new URL('http://evil.test/'), { resolveHost })).rejects.toThrow(/evil\.test → 10\.1\.2\.3/);
    await expect(assertUrlAllowed(new URL('http://good.test/'), { resolveHost })).resolves.toBeUndefined();
    await expect(assertUrlAllowed(new URL('http://localhost:3001/'), { httpAllowHosts: ['localhost'] })).resolves.toBeUndefined();
    await expect(assertUrlAllowed(new URL('http://127.0.0.1/'), { httpAllowHosts: ['localhost'] })).rejects.toThrow(/not in allowlist/);
    await expect(assertUrlAllowed(new URL('http://127.0.0.1/'), { httpAllowPrivate: true })).resolves.toBeUndefined();
  });

  it('re-checks every redirect hop (302 → cloud metadata is blocked, nothing fetched there)', async () => {
    const calls: string[] = [];
    const fetch = (async (u: URL) => {
      calls.push(String(u));
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }) as unknown as typeof globalThis.fetch;
    const r = await httpNode('http://93.184.216.34/start', { fetch });
    expect(r.error).toMatch(/private\/loopback address blocked: 169\.254\.169\.254/);
    expect(calls).toEqual(['http://93.184.216.34/start']);
  });

  describe('against a real local server', () => {
    let server: http.Server;
    let base: string;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/redir') return res.writeHead(302, { location: '/ok' }).end();
        if (req.url === '/away') return res.writeHead(302, { location: 'http://example.invalid/' }).end();
        if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('default policy refuses the local server; allowlist permits it and follows same-host redirects', async () => {
      expect((await httpNode(`${base}/ok`, {})).error).toMatch(/private\/loopback/);
      const ok = await httpNode(`${base}/redir`, { httpAllowHosts: ['127.0.0.1'] });
      expect(ok.outputs).toMatchObject({ status: 200, body: { ok: true } });
      expect((await httpNode(`${base}/away`, { httpAllowHosts: ['127.0.0.1'] })).error).toMatch(/not in allowlist: example\.invalid/);
      expect((await httpNode(`${base}/loop`, { httpAllowHosts: ['127.0.0.1'] })).error).toMatch(/too many redirects/);
    });
  });
});

describe('file sandbox', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-outside-'));
  const sb = createSandboxFs(path.join(dir, 'root'));
  beforeAll(async () => {
    await sb.writeFile('ok.txt', 'hi', 'overwrite');
    fs.symlinkSync(outside, path.join(dir, 'root', 'link-dir'));
    fs.symlinkSync(path.join(outside, 'not-yet.txt'), path.join(dir, 'root', 'dangling'));
    fs.mkdirSync(path.join(dir, 'root-sibling'));
  });

  it('reads/writes inside, rejects .., absolute, sibling-prefix, symlinked dirs and dangling symlinks', async () => {
    expect(await sb.readFile('ok.txt')).toBe('hi');
    expect(await sb.writeFile('sub/a.txt', 'x', 'overwrite')).toEqual({ path: path.join('sub', 'a.txt'), bytes: 1 });
    await expect(sb.readFile('../root-sibling/x')).rejects.toThrow(/escapes sandbox/);
    await expect(sb.writeFile('sub/../../x', 'x', 'overwrite')).rejects.toThrow(/escapes sandbox/);
    await expect(sb.readFile('/etc/passwd')).rejects.toThrow(/absolute/);
    await expect(sb.writeFile('link-dir/pwn.txt', 'x', 'overwrite')).rejects.toThrow(/symlink/);
    await expect(sb.writeFile('dangling', 'x', 'overwrite')).rejects.toThrow(/dangling symlink/);
    expect(fs.existsSync(path.join(outside, 'not-yet.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'pwn.txt'))).toBe(false);
  });
});

describe('untrusted workflow JSON never crashes the compiler / converter', () => {
  const reg = registry();
  const malformed: unknown[] = [
    { version: 1, nodes: [null], edges: [] },
    { version: 1, nodes: [{ id: 'a', type: 'start', config: 'str' }], edges: [] },
    { version: 1, nodes: [{ id: 'l', type: 'loop', config: { max_iterations: 2, until: 5, carry: 'x' } }], edges: [] },
    { version: 1, nodes: [{ id: 'l', type: 'loop', config: { max_iterations: 2, until: { port: ['x'] } } }], edges: [] },
    { nodes: [{ id: 'a', type: 'start' }], edges: [null, {}, { from: 'a' }] },
    { nodes: [{ id: 7, type: {} }], edges: [] },
  ];
  it('returns diagnostics instead of throwing', () => {
    for (const w of malformed) {
      for (const advanced of [false, true]) {
        const r = compileWorkflow(w, reg, { advanced });
        expect(r.ok, JSON.stringify(w)).toBe(false);
        expect(r.errors.length).toBeGreaterThan(0);
      }
    }
  });
  it('converter rejects malformed legacy files with a readable error', () => {
    expect(() => convertToV1({ nodes: [null], edges: [{}] } as never, reg)).toThrow(/cannot convert a malformed workflow[\s\S]*INVALID_NODE/);
  });
});

describe('backend input validation and static files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-sec-'));
  const wfDir = path.join(tmp, 'workflows');
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(wfDir);
  fs.mkdirSync(dist);
  fs.mkdirSync(path.join(tmp, 'dist-secret'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>index</html>');
  fs.writeFileSync(path.join(tmp, 'dist-secret', 'key.txt'), 'SECRET');
  fs.writeFileSync(path.join(wfDir, 'good.json'), JSON.stringify({ version: 1, name: 'good', nodes: [], edges: [] }));
  fs.writeFileSync(path.join(wfDir, 'broken.json'), '{ not json');
  const app = buildServer({ root, workflowsDir: wfDir, runsDir: path.join(tmp, 'runs'), staticDir: dist, mockDelayMs: 0 });
  afterAll(() => app.close());

  it('static handler does not serve sibling folders sharing the prefix, and tolerates bad escapes', async () => {
    const r = await app.inject('/../dist-secret/key.txt');
    expect(r.body).not.toContain('SECRET');
    for (const u of ['/..%2fdist-secret/key.txt', '/%2E%2E%2Fdist-secret%2Fkey.txt']) {
      const enc = await app.inject(u);
      expect(enc.body, u).not.toContain('SECRET');
      expect(enc.body, u).toContain('index');
    }
    expect((await app.inject('/%E0%A4%A')).statusCode).toBe(400);
  });

  it('rejects foreign Host headers (DNS rebinding) on API and MCP', async () => {
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example:3001' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'evil.example' }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:3001' } })).statusCode).toBe(200);
  });

  it('validates ids and body shapes; a broken workflow file does not break the list', async () => {
    const list = (await app.inject('/api/workflows')).json();
    expect(list.map((w: { id: string }) => w.id)).toEqual(['good']);
    expect((await app.inject('/api/workflows/broken')).statusCode).toBe(404);
    expect((await app.inject('/api/workflows/..%2Fgood')).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/workflows/a.b', payload: { version: 1, nodes: [], edges: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/workflows/ok', payload: [1] })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/validate', payload: { workflow: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow_id: 'good', inputs: [1, 2] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow: { version: 1, nodes: [null], edges: [] } } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/runs/..%2Fx/cancel' })).statusCode).toBe(400);
  });
});
