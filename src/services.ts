import type { WorkflowGraph } from './types.js';
import type { NodeRegistry } from './registry.js';

/**
 * 有副作用的節點透過注入的 services 存取外部世界（engine 本身不 import node:fs，瀏覽器也能跑）。
 * Node 端實作見 services-node.ts；瀏覽器 in-browser 模式只提供 fetch。
 */
export interface SandboxFs {
  /** 沙盒根目錄（顯示用） */
  root: string;
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string, mode: 'overwrite' | 'append'): Promise<{ path: string; bytes: number }>;
}

export interface RunServices {
  fetch?: typeof fetch;
  /** 允許的 host（空 = 不限制）。例如 ['localhost', 'api.github.com'] */
  httpAllowHosts?: string[];
  fs?: SandboxFs;
  /** subflow 節點載入其他 workflow */
  loadWorkflow?: (id: string) => Promise<WorkflowGraph>;
  /** subflow 在執行期編譯子 workflow 時使用 */
  registry?: NodeRegistry;
}
