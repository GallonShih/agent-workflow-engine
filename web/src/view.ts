import { bodyPortsAt, getGraphAt } from '../../src/graph-path.js';
import { isV1, normalizeWorkflow, serializeV1 } from '../../src/dsl.js';
import type { NodeRegistry } from '../../src/registry.js';
import type { WorkflowGraph, WorkflowNode } from '../../src/types.js';

/** 檔案格式（v1 edges 是字串）→ 編輯器內部格式（edge 物件）；舊格式原樣 */
export const norm = (wf: unknown): WorkflowGraph => normalizeWorkflow(wf).graph;
/** 內部格式 → 存檔格式（v1 寫回精簡字串 edges） */
export const toFile = (wf: WorkflowGraph) => (isV1(wf) ? serializeV1(wf) : wf);

/** 畫布路徑的一層：loop / foreach 的 body，或 subflow 引用的 workflow（唯讀） */
export interface Crumb {
  id: string;
  kind: string;
  label: string;
  workflowId?: string;
  /** subflow：drill-in 當下用的子流程結構（run 的快照，或從 workflows/ 載入） */
  graph?: WorkflowGraph;
}

/** 依路徑解析目前畫面：要畫的圖、可編輯的 root 與 body 路徑、外層與 composite（算邊界註解用） */
export function resolveView(wf: WorkflowGraph, path: Crumb[], registry: NodeRegistry) {
  let root = wf;
  let inner: string[] = [];
  let readOnly = false;
  let sourceId: string | undefined;
  let outer: WorkflowGraph | undefined;
  let composite: WorkflowNode | undefined;
  for (const c of path) {
    const g = getGraphAt(root, inner);
    const n = g?.nodes.find((x) => x.id === c.id);
    if (!g || !n || !c) return null;
    outer = g;
    composite = n;
    if (n.type === 'subflow') {
      if (!c.graph) return null;
      root = c.graph;
      inner = [];
      readOnly = true;
      sourceId = c.workflowId;
    } else inner = [...inner, n.id];
  }
  const graph = getGraphAt(root, inner);
  if (!graph) return null;
  return { graph, root, inner, readOnly, sourceId, outer, composite, body: inner.length ? bodyPortsAt(root, inner, registry) : undefined };
}
