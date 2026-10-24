import type { Edge, PortRef, WorkflowGraph, WorkflowNode } from './types.js';

/**
 * Workflow DSL v1（精簡版）的檔案格式 ↔ 內部格式。
 *
 * v1 檔案：
 *   { "version": 1, "nodes": [...], "edges": ["start.request -> planner.request", ...] }
 * - 只有「資料連線」：一條連線 = 某節點的輸出 port → 另一節點的輸入 port。
 * - 不寫 kind、沒有 control edge；執行順序由資料相依推導。
 * - edge 也可以寫成 {"from": "a.port", "to": "b.port"} 或 {"from": {node, port}, "to": {node, port}}。
 * - loop 的 body 用同樣格式（nodes + edges）。
 *
 * 內部一律正規化成 {kind:'data', from:{node,port}, to:{node,port}}，compiler / engine / UI 共用同一種 Edge 型別。
 */

export type V1EdgeInput = string | { from: string | PortRef; to: string | PortRef; kind?: string };

export interface EdgeParseError {
  index: number;
  path: string;
  message: string;
  fix: string;
  raw: unknown;
}

const REF = /^\s*([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)\s*$/;

function parseRef(r: unknown): PortRef | null {
  if (typeof r === 'string') {
    const m = r.match(REF);
    return m ? { node: m[1], port: m[2] } : null;
  }
  if (r && typeof r === 'object' && typeof (r as PortRef).node === 'string' && typeof (r as PortRef).port === 'string') return { node: (r as PortRef).node, port: (r as PortRef).port };
  return null;
}

export function parseEdge(raw: unknown): Edge | string {
  if (typeof raw === 'string') {
    const parts = raw.split(/\s*->\s*/);
    if (parts.length !== 2) return `edge "${raw}" must look like "fromNode.outputPort -> toNode.inputPort"`;
    const from = parseRef(parts[0]);
    const to = parseRef(parts[1]);
    if (!from || !to) return `edge "${raw}": both sides must be "nodeId.portName"`;
    return { kind: 'data', from, to };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { from?: unknown; to?: unknown; kind?: unknown };
    if (o.kind === 'control') return 'control edges do not exist in v1 — execution order comes from data connections (remove the edge, or connect a data output instead)';
    if (o.kind !== undefined && o.kind !== 'data') return `edge kind "${String(o.kind)}" is invalid (v1 edges are data connections; omit "kind")`;
    const from = parseRef(o.from);
    const to = parseRef(o.to);
    if (!from || !to) return `edge ${JSON.stringify(raw)}: "from" and "to" must be "nodeId.portName"`;
    return { kind: 'data', from, to };
  }
  return `edge ${JSON.stringify(raw)} must be a string "a.out -> b.in"`;
}

export function isV1(wf: unknown): boolean {
  return !!wf && typeof wf === 'object' && (wf as { version?: unknown }).version === 1;
}

/** v1 檔案 → 內部 WorkflowGraph（遞迴處理 loop body）；格式錯誤的 edge 回報在 errors，不會丟例外 */
export function normalizeWorkflow(raw: unknown): { graph: WorkflowGraph; errors: EdgeParseError[] } {
  const errors: EdgeParseError[] = [];
  const v1 = isV1(raw);
  const walk = (g: unknown, path: string): WorkflowGraph => {
    const w = (g ?? {}) as WorkflowGraph & { edges?: unknown };
    if (!Array.isArray(w.nodes) || !Array.isArray(w.edges)) return w as WorkflowGraph;
    const edges: Edge[] = [];
    if (v1) {
      (w.edges as unknown[]).forEach((e, index) => {
        const r = parseEdge(e);
        if (typeof r === 'string') errors.push({ index, path, message: r, fix: 'Write edges as "fromNode.outputPort -> toNode.inputPort", e.g. "start.request -> planner.request".', raw: e });
        else edges.push(r);
      });
    } else edges.push(...(w.edges as Edge[]));
    const nodes = w.nodes.map((n: WorkflowNode) => (n && n.body ? { ...n, body: walk(n.body, `${path}${n.id}.body/`) } : n));
    return { ...w, nodes, edges };
  };
  const graph = walk(raw, '');
  if (v1) graph.version = 1;
  return { graph, errors };
}

export const edgeToString = (e: Edge) => `${e.from.node}.${e.from.port} -> ${e.to.node}.${e.to.port}`;

/** 內部 v1 WorkflowGraph → 精簡檔案格式（edges 寫成字串）；用於存檔 */
export function serializeV1(wf: WorkflowGraph): Record<string, unknown> {
  const walk = (g: WorkflowGraph): Record<string, unknown> => ({
    ...g,
    nodes: g.nodes.map((n) => (n.body ? { ...n, body: walk(n.body) } : n)),
    edges: g.edges.map((e) => (e.kind === 'control' ? e : edgeToString(e))),
  });
  const { version: _v, ...rest } = walk(wf) as Record<string, unknown> & { version?: number };
  return { version: 1, ...rest };
}
