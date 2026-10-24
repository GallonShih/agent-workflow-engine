import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunServices, SandboxFs } from './services.js';
import type { NodeRegistry } from './registry.js';
import type { WorkflowGraph } from './types.js';

/** 檔案節點的沙盒：只允許 root 底下的相對路徑；拒絕絕對路徑、..、以及經由 symlink 逃出 root */
export function createSandboxFs(root: string): SandboxFs {
  const base = path.resolve(root);
  async function resolveSafe(rel: string): Promise<string> {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('path is empty');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error(`absolute paths are not allowed: ${rel}`);
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`path escapes sandbox: ${rel}`);
    await fs.mkdir(base, { recursive: true });
    const realBase = await fs.realpath(base);
    // 檢查最近一個已存在的祖先（或檔案本身）的真實路徑仍在沙盒內
    let probe = target;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error(`path escapes sandbox via symlink: ${rel}`);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        // realpath 失敗但 lstat 成功 = 懸空 symlink（寫入會跟著它跑到沙盒外）
        if (await fs.lstat(probe).then(() => true, () => false)) throw new Error(`path escapes sandbox via dangling symlink: ${rel}`);
        probe = path.dirname(probe);
      }
    }
    return target;
  }
  return {
    root: base,
    async readFile(rel) {
      return fs.readFile(await resolveSafe(rel), 'utf8');
    },
    async writeFile(rel, content, mode) {
      const p = await resolveSafe(rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      if (mode === 'append') await fs.appendFile(p, content, 'utf8');
      else await fs.writeFile(p, content, 'utf8');
      return { path: path.relative(base, p), bytes: Buffer.byteLength(content) };
    },
  };
}

export function createWorkflowLoader(dir: string) {
  return async (id: string): Promise<WorkflowGraph> => {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`invalid workflow id: ${id}`);
    return JSON.parse(await fs.readFile(path.join(dir, `${id.replace(/\.json$/, '')}.json`), 'utf8'));
  };
}

export function nodeServices(opts: { root: string; registry: NodeRegistry; workspaceDir?: string; httpAllowHosts?: string[]; httpAllowPrivate?: boolean }): RunServices {
  const allow = opts.httpAllowHosts ?? (process.env.HTTP_ALLOW_HOSTS ? process.env.HTTP_ALLOW_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    fetch: globalThis.fetch,
    httpAllowHosts: allow,
    httpAllowPrivate: opts.httpAllowPrivate ?? process.env.HTTP_ALLOW_PRIVATE === '1',
    resolveHost: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
    fs: createSandboxFs(opts.workspaceDir ?? path.join(opts.root, '.workspace')),
    loadWorkflow: createWorkflowLoader(path.join(opts.root, 'workflows')),
    registry: opts.registry,
  };
}
