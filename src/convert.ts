import type { Edge, LoopConfig, WorkflowGraph, WorkflowNode } from './types.js';
import type { NodeRegistry } from './registry.js';
import { serializeV1, isV1 } from './dsl.js';

/**
 * 舊版 hybrid（data + control edges）→ Workflow DSL v1（只有資料連線）。
 *
 * 規則：
 * 1. data edge 原樣保留。
 * 2. control edge 若目標本來就（直接或間接）讀取來源的資料 → 多餘，刪掉（順序已由資料相依保證）。
 * 3. condition 的 true / false control edge → 改成資料連線：
 *    - 目標有 dynamic 輸入（end / template / loop / subflow）→ 新增輸入 `<cond>_<true|false>` 接 condition 的輸出；
 *    - 目標的某個輸入來自只給它用的 template → 在那個 template 上加輸入（gate 往上游移）；
 *    - 否則複製一個 condition `<cond>_<target>`：value 接原本的條件來源、data 接目標的第一個輸入，結果接回目標。
 * 4. join 拆掉：目標改成直接依賴 join 的每個來源（v1 節點本來就等所有輸入）。policy any 無法表達 → 註記。
 * 5. failure control edge 刪掉（v1 沒有 failure 分支：失敗讓 run 失敗、下游略過）；只靠 failure 觸發的 end 節點一併刪除。
 * 6. loop config.carry {from, to}（from ≠ to）→ 新增同名 loop 輸出 `to`，body 內把 from 的來源也接到 loop_out.to；
 *    on_body_failure: fail 刪掉（預設行為）。
 * 7. edges 輸出成字串 "a.port -> b.port"，加上 "version": 1。
 */
export interface ConvertResult {
  workflow: Record<string, unknown>;
  notes: string[];
}

export function convertToV1(wf: WorkflowGraph, registry: NodeRegistry): ConvertResult {
  if (isV1(wf)) return { workflow: serializeV1(wf), notes: ['already v1'] };
  const notes: string[] = [];
  const graph = convertGraph(structuredClone(wf), registry, notes, '');
  return { workflow: serializeV1({ ...graph, version: 1 }), notes };
}

const ref = (node: string, port: string) => ({ node, port });
const dataEdge = (fn: string, fp: string, tn: string, tp: string): Edge => ({ kind: 'data', from: ref(fn, fp), to: ref(tn, tp) });

function convertGraph(g: WorkflowGraph, registry: NodeRegistry, notes: string[], prefix: string): WorkflowGraph {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  let data = g.edges.filter((e) => e.kind === 'data');
  let control = g.edges.filter((e) => e.kind === 'control');
  const hadControlIn = new Set(control.map((e) => e.to.node));
  const note = (m: string) => notes.push(prefix + m);

  // bodies first
  for (const n of g.nodes) if (n.body) n.body = convertGraph(n.body, registry, notes, `${prefix}${n.id}.body/`);

  // ---- 4. join ----
  for (;;) {
    const j = [...nodes.values()].find((n) => n.type === 'join');
    if (!j) break;
    if (((j.config?.policy as string) ?? 'all') === 'any') note(`join "${j.id}" (policy any) cannot be expressed in v1; its targets now wait for ALL of its inputs`);
    const ins = control.filter((e) => e.to.node === j.id);
    const outs = control.filter((e) => e.from.node === j.id);
    control = control.filter((e) => e.to.node !== j.id && e.from.node !== j.id);
    for (const o of outs) for (const i of ins) control.push({ kind: 'control', from: i.from, to: o.to });
    nodes.delete(j.id);
    note(`removed join "${j.id}" (v1 nodes wait for all connected inputs)`);
  }

  const dependsOn = (target: string, source: string): boolean => {
    const seen = new Set<string>();
    const stack = [target];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of data) if (e.to.node === cur && !seen.has(e.from.node)) {
        if (e.from.node === source) return true;
        seen.add(e.from.node);
        stack.push(e.from.node);
      }
    }
    return false;
  };
  const DYNAMIC_IN = ['end', 'template', 'loop', 'subflow'];
  const addInput = (n: WorkflowNode, name: string) => {
    n.ports = { ...(n.ports ?? {}), inputs: { ...(n.ports?.inputs ?? {}), [name]: { schema: {}, required: false } } };
  };

  const gate = (target: WorkflowNode, cond: WorkflowNode, branch: string) => {
    const port = `${cond.id}_${branch}`;
    if (DYNAMIC_IN.includes(target.type)) {
      addInput(target, port);
      data.push(dataEdge(cond.id, branch, target.id, port));
      return;
    }
    // 目標的輸入來自只給它用的 template → 在 template 上加 gate
    for (const e of data.filter((x) => x.to.node === target.id)) {
      const src = nodes.get(e.from.node);
      if (src?.type === 'template' && data.filter((x) => x.from.node === src.id).every((x) => x.to.node === target.id)) {
        addInput(src, port);
        data.push(dataEdge(cond.id, branch, src.id, port));
        return;
      }
    }
    const first = data.find((x) => x.to.node === target.id);
    if (!first) {
      note(`cannot gate "${target.id}" on ${cond.id}.${branch}: it has no data inputs (it will run regardless)`);
      return;
    }
    const cloneId = `${cond.id}_${target.id}`;
    const clone: WorkflowNode = { id: cloneId, type: 'condition', label: `${cond.label ?? cond.id} → ${target.label ?? target.id}`, config: structuredClone(cond.config), inputs: cond.inputs ? structuredClone(cond.inputs) : undefined };
    if (cond.ui) clone.ui = { x: cond.ui.x + 40, y: cond.ui.y + 120 };
    nodes.set(cloneId, clone);
    for (const v of data.filter((x) => x.to.node === cond.id && x.to.port === 'value')) data.push(dataEdge(v.from.node, v.from.port, cloneId, 'value'));
    data = data.filter((x) => x !== first);
    data.push(dataEdge(first.from.node, first.from.port, cloneId, 'data'), dataEdge(cloneId, branch, target.id, first.to.port));
    note(`"${target.id}" is gated by ${cond.id}.${branch} through a copy of the condition ("${cloneId}") that forwards ${first.from.node}.${first.from.port}`);
  };

  // ---- 3/5/2. control edges ----
  for (const e of control) {
    const src = nodes.get(e.from.node);
    const dst = nodes.get(e.to.node);
    if (!src || !dst) continue;
    if (e.from.port === 'failure') {
      note(`dropped failure edge ${e.from.node} → ${e.to.node} (v1: a failed node fails the run; downstream nodes are skipped)`);
      continue;
    }
    if (src.type === 'condition' && (e.from.port === 'true' || e.from.port === 'false')) {
      if (!data.some((x) => x.from.node === src.id && x.to.node === dst.id)) gate(dst, src, e.from.port);
      continue;
    }
    if (dependsOn(dst.id, src.id)) continue;
    if (e.from.port === 'done' || e.from.port === 'exhausted') {
      note(`dropped ${e.from.node}.${e.from.port} → ${e.to.node}: route on the loop's "done" output with a condition instead`);
      continue;
    }
    if (DYNAMIC_IN.includes(dst.type) && dst.type !== 'loop') {
      const out = firstOutput(src, registry);
      if (out) {
        const port = `after_${src.id}`;
        addInput(dst, port);
        data.push(dataEdge(src.id, out, dst.id, port));
        continue;
      }
    }
    note(`dropped ordering-only edge ${e.from.node}.${e.from.port} → ${e.to.node} (no data dependency; they may now run in parallel)`);
  }

  // ---- 5. nodes only reachable through failure edges ----
  for (const n of [...nodes.values()]) {
    if (!hadControlIn.has(n.id) || data.some((x) => x.to.node === n.id)) continue;
    if (n.type === 'end') {
      nodes.delete(n.id);
      data = data.filter((x) => x.from.node !== n.id && x.to.node !== n.id);
      note(`removed end node "${n.id}" (only reached through failure edges; in v1 a failure already fails the run)`);
    } else note(`node "${n.id}" has no incoming data connection and will run as soon as the workflow starts`);
  }

  // ---- 6. loop carry → same-name convention ----
  for (const n of nodes.values()) {
    if (n.type !== 'loop') continue;
    const cfg = (n.config ?? {}) as unknown as LoopConfig & Record<string, unknown>;
    if (cfg.on_body_failure === 'fail') delete cfg.on_body_failure;
    else if (cfg.on_body_failure) note(`loop "${n.id}": on_body_failure "${cfg.on_body_failure}" kept (advanced option)`);
    for (const c of cfg.carry ?? []) {
      if (c.from === c.to) continue;
      const outs = (n.ports?.outputs ?? {}) as Record<string, Record<string, unknown>>;
      if (outs[c.to]) {
        note(`loop "${n.id}": cannot convert carry ${c.from} → ${c.to} (output "${c.to}" already exists)`);
        continue;
      }
      n.ports = { ...(n.ports ?? {}), outputs: { ...outs, [c.to]: structuredClone(outs[c.from]) } };
      const body = n.body!;
      const loopOut = body.nodes.find((b) => b.type === 'loop_out');
      for (const be of body.edges.filter((x) => x.to.node === loopOut?.id && x.to.port === c.from)) body.edges.push(dataEdge(be.from.node, be.from.port, be.to.node, c.to));
      note(`loop "${n.id}": carry ${c.from} → ${c.to} became a loop output "${c.to}" (v1 feeds same-name outputs into the next iteration)`);
    }
    delete cfg.carry;
    n.config = cfg;
  }

  // 分支全部改成複製的 condition 後，原本的 condition 已沒有任何下游 → 刪掉（連同它的輸入）
  for (const n of [...nodes.values()]) {
    if (n.type === 'condition' && !data.some((e) => e.from.node === n.id)) {
      nodes.delete(n.id);
      data = data.filter((e) => e.to.node !== n.id);
      note(`removed condition "${n.id}" (all its branches were rewired)`);
    }
  }

  return { ...g, nodes: [...nodes.values()], edges: data };
}

function firstOutput(n: WorkflowNode, registry: NodeRegistry): string | undefined {
  const def = registry.get(n.type);
  const dyn = Object.keys((n.ports?.outputs ?? {}) as object);
  if (['start', 'loop_in', 'set', 'subflow', 'loop'].includes(n.type) && dyn.length) return dyn[0];
  return def ? Object.keys(def.outputs)[0] : undefined;
}
