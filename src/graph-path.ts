import { resolveNodePorts, type BodyPorts } from './compiler.js';
import type { NodeRegistry } from './registry.js';
import type { WorkflowGraph, WorkflowNode } from './types.js';

/**
 * 巢狀 body 的路徑工具（純函式，前後端 / 測試共用）。
 * path = 由外到內的 composite（loop / foreach）node id，例如 ['review_rounds', 'fix_loop']；[] = 主流程。
 * 整份 workflow 仍是「單一 JSON」：body 直接存在 composite 節點的 `body` 欄位裡。
 */
export const COMPOSITE_TYPES = ['loop', 'foreach'];

export function compositeAt(wf: WorkflowGraph, path: string[]): WorkflowNode | undefined {
  let g: WorkflowGraph | undefined = wf;
  let node: WorkflowNode | undefined;
  for (const id of path) {
    node = g?.nodes.find((n) => n.id === id);
    if (!node || !COMPOSITE_TYPES.includes(node.type) || !node.body) return undefined;
    g = node.body;
  }
  return node;
}

export function getGraphAt(wf: WorkflowGraph, path: string[]): WorkflowGraph | undefined {
  if (!path.length) return wf;
  return compositeAt(wf, path)?.body;
}

/**
 * 把 path 位置的圖換成 g，回傳新的 workflow（不改動輸入）。
 * g 裡 composite 節點若沒帶 body（或帶的是載入時的舊 body），以目前 workflow 中同 id 節點的 body 為準 —
 * 這樣在外層存檔不會蓋掉剛在內層編輯過的 body。新拖進來的 composite（舊圖沒有）保留自己的預設 body。
 */
export function setGraphAt(wf: WorkflowGraph, path: string[], g: WorkflowGraph): WorkflowGraph {
  const old = getGraphAt(wf, path);
  if (!old) throw new Error(`path not found: ${path.join(' › ') || '(root)'}`);
  const merged: WorkflowGraph = {
    ...g,
    nodes: g.nodes.map((n) => {
      const prev = old.nodes.find((o) => o.id === n.id && o.type === n.type);
      return prev?.body ? { ...n, body: prev.body } : n;
    }),
  };
  if (!path.length) return { ...wf, ...merged };
  const [head, ...rest] = path;
  return {
    ...wf,
    nodes: wf.nodes.map((n) => (n.id === head ? { ...n, body: rest.length ? setGraphAt(n.body!, rest, merged) : merged } : n)),
  };
}

/** path 所在 body 的 loop_in / loop_out ports（來自 composite 節點自己的 dynamic ports） */
export function bodyPortsAt(wf: WorkflowGraph, path: string[], registry: NodeRegistry): BodyPorts | undefined {
  const c = compositeAt(wf, path);
  if (!c) return undefined;
  const def = registry.get(c.type);
  if (!def) return undefined;
  try {
    return resolveNodePorts(c, def, registry).body;
  } catch {
    return undefined;
  }
}

/** 某個 node id 在 path 內是否為可以 drill-in 的節點 */
export function isDrillable(n: WorkflowNode): boolean {
  return (COMPOSITE_TYPES.includes(n.type) && !!n.body) || n.type === 'subflow';
}

/**
 * 邊界節點的 port 註解：讓使用者在 body 裡看得出「外面哪個 port 接到這裡」。
 *  - loop/foreach：loop_in 的每個 output ← 外層連到 composite 該 input 的來源 / carry / iteration / item；
 *                  loop_out 的每個 input → composite 的同名 output（以及 carry 到哪個輸入）
 *  - subflow：子流程 start 的 outputs ← 外層連到 subflow 節點的來源；end 的 inputs → subflow 節點的 outputs
 * 回傳 { [nodeId]: { 'd:port': '說明' } }
 */
export function boundaryAnnotations(outer: WorkflowGraph, composite: WorkflowNode, inner: WorkflowGraph): Record<string, Record<string, string>> {
  const srcOf = (port: string) => {
    const e = outer.edges.find((x) => x.kind === 'data' && x.to.node === composite.id && x.to.port === port);
    if (e) return `${e.from.node}.${e.from.port}`;
    if (composite.inputs && port in composite.inputs) return `常數 ${JSON.stringify(composite.inputs[port])}`;
    return undefined;
  };
  const consumers = (port: string) =>
    outer.edges.filter((x) => x.kind === 'data' && x.from.node === composite.id && x.from.port === port).map((x) => `${x.to.node}.${x.to.port}`);
  const out: Record<string, Record<string, string>> = {};
  if (composite.type === 'subflow') {
    for (const n of inner.nodes) {
      if (n.type === 'start') out[n.id] = Object.fromEntries(Object.keys(n.ports?.outputs ?? {}).map((p) => [`d:${p}`, `← ${srcOf(p) ?? `${composite.id}.${p}（未接）`}`]));
      if (n.type === 'end')
        out[n.id] = Object.fromEntries(Object.keys(n.ports?.inputs ?? {}).map((p) => [`d:${p}`, `→ ${composite.id}.${p}${consumers(p).length ? ' → ' + consumers(p).join(', ') : ''}`]));
    }
    return out;
  }
  const carry = ((composite.config?.carry as { from: string; to: string }[] | undefined) ?? []);
  const inPorts = Object.keys(composite.ports?.inputs ?? {});
  const outPorts = Object.keys(composite.ports?.outputs ?? {});
  const loopIn: Record<string, string> = {};
  for (const p of inPorts) {
    const parts = [srcOf(p) ? `← ${srcOf(p)}` : `← ${composite.id}.${p}（未接）`];
    const c = carry.find((x) => x.to === p);
    if (c) parts.push(`第 2 輪起 ← carry(loop_out.${c.from})`);
    loopIn[`d:${p}`] = parts.join('；');
  }
  if (composite.type === 'loop') loopIn['d:iteration'] = '← 目前輪次（0-based）';
  if (composite.type === 'foreach') {
    loopIn['d:item'] = `← ${srcOf('items') ?? 'items'}[index]`;
    loopIn['d:index'] = '← 目前元素索引';
    delete loopIn['d:items'];
  }
  const loopOut: Record<string, string> = {};
  for (const p of outPorts) {
    const parts = [`→ ${composite.id}.${p}${consumers(p).length ? ' → ' + consumers(p).join(', ') : ''}`];
    const c = carry.find((x) => x.from === p);
    if (c) parts.push(`carry → 下一輪 ${c.to}`);
    loopOut[`d:${p}`] = parts.join('；');
  }
  for (const n of inner.nodes) {
    if (n.type === 'loop_in') out[n.id] = loopIn;
    if (n.type === 'loop_out') out[n.id] = loopOut;
  }
  return out;
}
