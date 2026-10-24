import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { WorkspacePermission, WorkspaceReport } from './workspace-policy.js';

/**
 * Per-run workspace（node 專用；engine 只拿到已驗證的路徑）：
 * - WORKSPACE_ROOTS 白名單（path.delimiter 分隔、支援 ~、realpath 解析 symlink）
 * - resolveWorkspace：存在、是目錄、在某個 root 底下；否則丟 WorkspaceError（含修正提示）
 * - beginWorkspace：run 開始時快照（git：branch / HEAD / 已有的變更；非 git：mtime + hash），結束時算出變更清單與 diff stat
 */
export class WorkspaceError extends Error {
  constructor(message: string, public fix: string) {
    super(message);
  }
}

export const ROOTS_FIX =
  `Set WORKSPACE_ROOTS to the directories agents may work in, separated by "${path.delimiter}" (supports ~), e.g. WORKSPACE_ROOTS=~/code${path.delimiter}/srv/repos — then restart the server / MCP process.`;

const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p);

/** 解析 WORKSPACE_ROOTS；不存在的 root 會被略過（realpath 失敗） */
export function parseWorkspaceRoots(value: string | undefined = process.env.WORKSPACE_ROOTS): string[] {
  if (!value?.trim()) return [];
  const out: string[] = [];
  for (const raw of value.split(path.delimiter).map((s) => s.trim()).filter(Boolean)) {
    try {
      const real = fs.realpathSync(path.resolve(expandHome(raw)));
      if (fs.statSync(real).isDirectory() && !out.includes(real)) out.push(real);
    } catch {
      /* 不存在的 root 略過 */
    }
  }
  return out;
}

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** 驗證 workspace 並回傳 realpath；任何問題都丟 WorkspaceError */
export function resolveWorkspace(input: unknown, roots: string[]): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new WorkspaceError('workspace must be a non-empty path string', 'Pass an absolute directory path, e.g. "workspace": "/home/me/code/my-repo".');
  if (!roots.length) throw new WorkspaceError('workspaces are disabled: WORKSPACE_ROOTS is not set (or none of its directories exist)', ROOTS_FIX);
  const expanded = expandHome(input.trim());
  if (!path.isAbsolute(expanded)) throw new WorkspaceError(`workspace must be an absolute path (got "${input}")`, 'Use an absolute path (or ~/...), e.g. "/home/me/code/my-repo".');
  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    throw new WorkspaceError(`workspace "${input}" does not exist`, 'Create the directory first, or check the path for typos.');
  }
  if (!fs.statSync(real).isDirectory()) throw new WorkspaceError(`workspace "${input}" is not a directory`, 'Point workspace at the repository / project directory, not a file.');
  if (!roots.some((r) => inside(real, r)))
    throw new WorkspaceError(
      `workspace "${input}"${real !== path.resolve(expanded) ? ` (resolves to "${real}")` : ''} is outside WORKSPACE_ROOTS (${roots.join(path.delimiter)})`,
      `Use a directory inside one of: ${roots.join(', ')} — or add its parent to WORKSPACE_ROOTS and restart.`,
    );
  return real;
}

// ------------------------------------------------------------------ snapshot / diff

export interface SnapshotLimits {
  /** 非 git 目錄最多掃幾個檔案 */
  maxFiles?: number;
  /** 超過這個大小的檔案只比 size + mtime，不算 hash */
  maxHashBytes?: number;
  /** changed_files 最多列幾筆 */
  maxChanged?: number;
}
const DEFAULTS: Required<SnapshotLimits> = { maxFiles: 5000, maxHashBytes: 1 << 20, maxChanged: 500 };
const SKIP_DIRS = new Set(['.git', 'node_modules', '.runs']);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 跑 git：關掉 fsmonitor / hooks / 外部 diff / textconv，避免 workspace 的 .git/config 觸發任意指令 */
function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { timeout: 15_000, maxBuffer: 32 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}
const zsplit = (s: string) => s.split('\0').filter(Boolean);

interface FileSig {
  size: number;
  mtime: number;
  hash?: string;
  lines?: number;
}
function sig(file: string, maxHash: number): FileSig | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return st.isSymbolicLink() ? { size: 0, mtime: st.mtimeMs, hash: 'link:' + fs.readlinkSync(file) } : undefined;
    const s: FileSig = { size: st.size, mtime: st.mtimeMs };
    if (st.size <= maxHash) {
      const buf = fs.readFileSync(file);
      s.hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (!buf.subarray(0, 8000).includes(0)) s.lines = buf.length ? buf.toString('utf8').split('\n').length - (buf[buf.length - 1] === 10 ? 1 : 0) : 0;
    }
    return s;
  } catch {
    return undefined;
  }
}
const same = (a?: FileSig, b?: FileSig) => !!a && !!b && (a.hash !== undefined && b.hash !== undefined ? a.hash === b.hash : a.size === b.size && a.mtime === b.mtime);

function walk(root: string, limits: Required<SnapshotLimits>) {
  const files = new Map<string, FileSig>();
  let truncated = false;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(r);
        continue;
      }
      if (files.size >= limits.maxFiles) {
        truncated = true;
        break;
      }
      const s = sig(path.join(root, r), limits.maxHashBytes);
      if (s) files.set(r, s);
    }
    if (truncated) break;
  }
  return { files, truncated };
}

type Changed = NonNullable<WorkspaceReport['changed_files']>[number];

function summarize(report: WorkspaceReport, changed: Changed[], limits: Required<SnapshotLimits>) {
  changed.sort((a, b) => a.path.localeCompare(b.path));
  report.diff_stat = {
    files: changed.length,
    insertions: changed.reduce((n, c) => n + (c.insertions ?? 0), 0),
    deletions: changed.reduce((n, c) => n + (c.deletions ?? 0), 0),
  };
  if (changed.length > limits.maxChanged) report.truncated = true;
  report.changed_files = changed.slice(0, limits.maxChanged);
  return report;
}

/**
 * run 開始前呼叫：回傳開始時的 report（path + git branch / HEAD）與 finish()，
 * finish() 在 run 結束後算出「這次 run 期間」變更的檔案。
 */
export async function beginWorkspace(dir: string, required?: WorkspacePermission, opts: SnapshotLimits = {}): Promise<{ report: WorkspaceReport; finish: () => Promise<WorkspaceReport> }> {
  const limits = { ...DEFAULTS, ...opts };
  const base: WorkspaceReport = { path: dir, ...(required ? { required } : {}) };

  // ---- git
  let isGit = false;
  try {
    isGit = (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    isGit = false;
  }
  if (isGit) {
    try {
      const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null;
      const branch = (await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
      const dirtyNow = async (ref: string) => {
        const tracked = zsplit(await git(dir, ['diff', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-z', ref, '--', '.']));
        const untracked = zsplit(await git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']));
        return { tracked, untracked };
      };
      const startRef = head ?? EMPTY_TREE;
      const before = await dirtyNow(startRef);
      const startSigs = new Map<string, FileSig | undefined>();
      for (const p of [...before.tracked, ...before.untracked]) startSigs.set(p, sig(path.join(dir, p), limits.maxHashBytes));
      const report: WorkspaceReport = { ...base, git: { branch, head } };
      return {
        report: structuredClone(report),
        finish: async () => {
          const out: WorkspaceReport = structuredClone(report);
          try {
            out.git!.head_after = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null;
            const status = new Map<string, string>();
            for (const [st, p] of pairs(zsplit(await git(dir, ['diff', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-status', '-z', startRef, '--', '.'])))) status.set(p, st);
            const numstat = new Map<string, [number, number]>();
            for (const line of zsplit(await git(dir, ['diff', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv', '--numstat', '-z', startRef, '--', '.']))) {
              const [a, d, ...rest] = line.split('\t');
              numstat.set(rest.join('\t'), [Number(a) || 0, Number(d) || 0]);
            }
            const untracked = zsplit(await git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']));
            const changed: Changed[] = [];
            const seen = new Set<string>();
            const push = (p: string, st: Changed['status'], ins?: number, del?: number) => {
              if (seen.has(p)) return;
              seen.add(p);
              // 開始時就已經是 dirty、而且內容沒變 → 不是這次 run 改的
              if (startSigs.has(p)) {
                const now = sig(path.join(dir, p), limits.maxHashBytes);
                const was = startSigs.get(p);
                if ((!now && !was) || same(now, was)) return;
              }
              changed.push({ path: p, status: st, ...(ins !== undefined ? { insertions: ins, deletions: del ?? 0 } : {}) });
            };
            for (const [p, st] of status) push(p, st.startsWith('A') ? 'added' : st.startsWith('D') ? 'deleted' : 'modified', numstat.get(p)?.[0], numstat.get(p)?.[1]);
            for (const p of untracked) {
              const s = sig(path.join(dir, p), limits.maxHashBytes);
              push(p, startSigs.has(p) ? 'modified' : 'added', s?.lines, s?.lines === undefined ? undefined : 0);
            }
            // 開始時 dirty、run 期間被還原成 HEAD 的檔案
            for (const p of startSigs.keys()) if (!seen.has(p)) push(p, fs.existsSync(path.join(dir, p)) ? 'modified' : 'deleted');
            return summarize(out, changed, limits);
          } catch (e) {
            out.error = `git diff failed: ${(e as Error).message.split('\n')[0]}`;
            return out;
          }
        },
      };
    } catch (e) {
      base.error = `git snapshot failed (${(e as Error).message.split('\n')[0]}); fell back to file snapshot`;
    }
  }

  // ---- 非 git：mtime / hash 快照
  const start = walk(dir, limits);
  const report: WorkspaceReport = { ...base, ...(start.truncated ? { truncated: true } : {}) };
  return {
    report: structuredClone(report),
    finish: async () => {
      const end = walk(dir, limits);
      const out: WorkspaceReport = structuredClone(report);
      const changed: Changed[] = [];
      for (const [p, s] of end.files) {
        const was = start.files.get(p);
        if (!was) changed.push({ path: p, status: 'added', ...(s.lines !== undefined ? { insertions: s.lines, deletions: 0 } : {}) });
        else if (!same(s, was)) changed.push({ path: p, status: 'modified' });
      }
      // 截斷時沒掃到的檔案不能當成 deleted
      if (!start.truncated && !end.truncated)
        for (const [p, was] of start.files) if (!end.files.has(p)) changed.push({ path: p, status: 'deleted', ...(was.lines !== undefined ? { insertions: 0, deletions: was.lines } : {}) });
      if (end.truncated) out.truncated = true;
      return summarize(out, changed, limits);
    },
  };
}

function* pairs(list: string[]): Generator<[string, string]> {
  for (let i = 0; i + 1 < list.length; i += 2) yield [list[i], list[i + 1]];
}

/**
 * mock coding agent 的寫檔（demo / 測試用）：路徑必須留在 workspace 內（含 symlink 解析後）。
 */
export async function writeWorkspaceFile(workspace: string, relPath: string, content: string, mode: 'write' | 'append' = 'write'): Promise<void> {
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, relPath);
  if (!inside(target, root) || target === root) throw new Error(`refusing to write outside the workspace: ${relPath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const parent = fs.realpathSync(path.dirname(target));
  if (!inside(parent, root)) throw new Error(`refusing to write outside the workspace (symlinked dir): ${relPath}`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${relPath}`);
  if (mode === 'append') fs.appendFileSync(target, content);
  else fs.writeFileSync(target, content);
}
