import type { NodeDefinition } from './types.js';

/**
 * Workspace 權限（registry 層級，workflow 實例不能覆寫）：
 * - none：不給 workingDirectory，拿掉所有檔案 / Bash 工具
 * - read：只留唯讀工具（Read、Grep、Glob、LS…），拿掉 Edit / Write / Bash / NotebookEdit
 * - write：allowed_tools 照 registry 定義
 * 瀏覽器也能 import（不碰 node 模組）。
 */
export type WorkspacePermission = 'none' | 'read' | 'write';
export const WORKSPACE_PERMISSIONS: WorkspacePermission[] = ['none', 'read', 'write'];

/** 會寫檔或執行指令的工具（read 權限拿掉） */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'KillBash'];
/** 會碰檔案系統的工具（none 權限全部拿掉） */
export const FILE_TOOLS = [...WRITE_TOOLS, 'Read', 'Grep', 'Glob', 'LS', 'NotebookRead'];

const RANK: Record<WorkspacePermission, number> = { none: 0, read: 1, write: 2 };

export const permissionOf = (def: Pick<NodeDefinition, 'kind' | 'workspace'>): WorkspacePermission => (def.kind === 'agent' ? (def.workspace ?? 'none') : 'none');

export const maxPermission = (a: WorkspacePermission, b: WorkspacePermission): WorkspacePermission => (RANK[a] >= RANK[b] ? a : b);

/** 依權限過濾 allowed_tools；回傳實際可用的工具與被拿掉的工具 */
export function toolsFor(permission: WorkspacePermission, tools: string[] = []): { allowed: string[]; removed: string[] } {
  const strip = permission === 'write' ? [] : permission === 'read' ? WRITE_TOOLS : FILE_TOOLS;
  return { allowed: tools.filter((t) => !strip.includes(t)), removed: tools.filter((t) => strip.includes(t)) };
}

/** 一次 run 的 workspace 紀錄（RunMeta.workspace；UI / MCP get_run 顯示） */
export interface WorkspaceReport {
  path: string;
  /** workflow 中最高的權限需求 */
  required?: WorkspacePermission;
  git?: { branch: string | null; head: string | null; head_after?: string | null };
  /** 開始後被改動的檔案（相對於 workspace） */
  changed_files?: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; insertions?: number; deletions?: number }[];
  diff_stat?: { files: number; insertions: number; deletions: number };
  /** 非 git 目錄：快照是否因檔案數上限被截斷 */
  truncated?: boolean;
  error?: string;
}
