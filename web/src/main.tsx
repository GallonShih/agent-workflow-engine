import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { compileWorkflow, resolveNodePorts, type Diagnostic } from '../../src/compiler.js';
import { runWorkflow } from '../../src/engine.js';
import { demoRuntime } from '../../src/demo/scenario.js';
import type { NodeStatus, RunEvent, WorkflowGraph } from '../../src/types.js';
import demoWorkflow from '../../workflows/fix-until-tests-pass.json';
import { loadBrowserRegistry } from './registry-browser.js';
import { createEditor, type EditorApi } from './editor.js';

const STORAGE_KEY = 'agent-workflow-poc:workflow';
const registry = loadBrowserRegistry();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function App() {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<EditorApi | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowGraph>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : clone(demoWorkflow as WorkflowGraph);
  });
  const wfRef = useRef(workflow);
  wfRef.current = workflow;
  const [view, setView] = useState(''); // '' = 外層 DAG；否則 = loop node id（顯示其 body）
  const viewRef = useRef(view);
  const [diag, setDiag] = useState<{ errors: Diagnostic[]; warnings: Diagnostic[] } | null>(null);
  const [logs, setLogs] = useState<{ msg: string; level: string }[]>([]);
  const [json, setJson] = useState('');
  const [running, setRunning] = useState(false);
  const statuses = useRef<Record<string, Record<string, NodeStatus>>>({});

  const log = (msg: string, level: 'info' | 'error' = 'info') => setLogs((l) => [...l.slice(-300), { msg, level }]);
  const loops = useMemo(() => workflow.nodes.filter((n) => n.type === 'loop'), [workflow]);

  /** 把目前畫面（外層或某個 loop body）的編輯寫回完整 workflow */
  function commit(): WorkflowGraph {
    if (!api.current) return wfRef.current;
    const g = api.current.exportGraph();
    const v = viewRef.current;
    const wf = clone(wfRef.current);
    if (!v) {
      wf.nodes = g.nodes.map((n) => ({ ...n, body: wf.nodes.find((o) => o.id === n.id)?.body ?? n.body }));
      wf.edges = g.edges;
    } else {
      const loop = wf.nodes.find((n) => n.id === v);
      if (loop) loop.body = g;
    }
    wfRef.current = wf;
    setWorkflow(wf);
    return wf;
  }

  async function show(v: string, wf = wfRef.current) {
    if (!api.current) return;
    viewRef.current = v;
    setView(v);
    if (!v) await api.current.load(wf);
    else {
      const loop = wf.nodes.find((n) => n.id === v)!;
      const ports = resolveNodePorts(loop, registry.get('loop')!, registry);
      const outputs = Object.fromEntries(Object.entries(ports.outputs).filter(([k]) => k !== 'iterations'));
      await api.current.load(loop.body ?? { nodes: [], edges: [] }, { inputs: ports.inputs, outputs });
    }
    api.current.setStatuses(statuses.current[v] ?? {});
  }

  useEffect(() => {
    let disposed = false;
    void createEditor(container.current!, registry, log).then(async (e) => {
      if (disposed) return e.destroy();
      api.current = e;
      await show('');
    });
    return () => {
      disposed = true;
      api.current?.destroy();
    };
  }, []);

  function validate() {
    const wf = commit();
    const r = compileWorkflow(wf, registry);
    setDiag({ errors: r.errors, warnings: r.warnings });
    log(r.ok ? `✅ 驗證通過（${r.warnings.length} warnings）` : `❌ ${r.errors.length} 個錯誤`, r.ok ? 'info' : 'error');
    return r;
  }

  async function run(scenario: 'pass' | 'fail') {
    const r = validate();
    if (!r.ok || !r.graph) return;
    setRunning(true);
    statuses.current = {};
    api.current?.setStatuses({});
    const onEvent = (e: RunEvent) => {
      const map: Partial<Record<RunEvent['type'], NodeStatus>> = {
        node_started: 'running', node_succeeded: 'success', node_failed: 'failed', node_skipped: 'skipped',
      };
      const st = map[e.type];
      if (st && e.node_id) {
        const v = e.scope?.[0]?.loop ?? '';
        (statuses.current[v] ??= {})[e.node_id] = st;
        if (v === viewRef.current) api.current?.setStatuses(statuses.current[v]);
      }
      if (e.type !== 'agent_event') log(`${e.key ?? e.run_id}  ${e.type}${e.data ? ' ' + JSON.stringify(e.data).slice(0, 140) : ''}`);
    };
    const result = await runWorkflow(
      r.graph,
      { request: '修正 parser 空字串 bug 並讓測試通過', repository: 'github.com/acme/parser' },
      { runtime: demoRuntime({ passOnIteration: scenario === 'pass' ? 2 : null, flakyCoder: true, delayMs: 250 }), onEvent },
    );
    log(`🏁 run ${result.run_id} → ${result.status.toUpperCase()}`, result.status === 'success' ? 'info' : 'error');
    setRunning(false);
  }

  function save() {
    const wf = commit();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wf));
    setJson(JSON.stringify(wf, null, 2));
    log('💾 已存到 localStorage，JSON 顯示在右下');
  }
  async function load() {
    try {
      const wf = JSON.parse(json) as WorkflowGraph;
      wfRef.current = wf;
      setWorkflow(wf);
      await show('', wf);
      log('📂 已從 JSON 載入');
    } catch (e) {
      log(`JSON 解析失敗：${(e as Error).message}`, 'error');
    }
  }
  async function reset() {
    localStorage.removeItem(STORAGE_KEY);
    const wf = clone(demoWorkflow as WorkflowGraph);
    wfRef.current = wf;
    setWorkflow(wf);
    await show('', wf);
  }
  function download() {
    const wf = commit();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' }));
    a.download = 'workflow.json';
    a.click();
  }

  const palette = registry.list().filter((d) => !['loop_in', 'loop_out', 'start'].includes(d.name));
  const btn = { padding: '6px 10px', marginRight: 6, cursor: 'pointer' } as const;

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
      <div style={{ padding: 8, borderBottom: '1px solid #ddd', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        <b style={{ marginRight: 12 }}>Agent Workflow PoC · Rete editor</b>
        <select value={view} onChange={(e) => { commit(); void show(e.target.value); }} style={btn}>
          <option value="">外層 DAG</option>
          {loops.map((l) => <option key={l.id} value={l.id}>{l.id} body（loop）</option>)}
        </select>
        <select value="" onChange={(e) => e.target.value && void api.current?.addNode(e.target.value)} style={btn}>
          <option value="">＋ 從 Node Registry 新增…</option>
          {palette.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <button style={btn} onClick={validate}>驗證</button>
        <button style={btn} disabled={running} onClick={() => void run('pass')}>▶ Mock run（第 3 輪通過）</button>
        <button style={btn} disabled={running} onClick={() => void run('fail')}>▶ Mock run（永遠失敗）</button>
        <button style={btn} onClick={() => void api.current?.layout()}>自動排版</button>
        <button style={btn} onClick={save}>存檔</button>
        <button style={btn} onClick={() => void load()}>從 JSON 載入</button>
        <button style={btn} onClick={download}>下載 JSON</button>
        <button style={btn} onClick={() => void reset()}>重設 demo</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', minHeight: 0 }}>
        <div ref={container} style={{ position: 'relative', background: '#f8fafc', minHeight: 0 }} />
        <div style={{ borderLeft: '1px solid #ddd', display: 'grid', gridTemplateRows: 'auto 1fr 200px', minHeight: 0, fontSize: 12 }}>
          <div style={{ padding: 8, maxHeight: 220, overflow: 'auto' }}>
            <b>Diagnostics</b>
            {!diag && <div style={{ color: '#666' }}>按「驗證」執行 compiler（與後端同一份 compileWorkflow）</div>}
            {diag?.errors.map((d, i) => <div key={i} style={{ color: '#b91c1c' }}>[{d.code}] {d.message}</div>)}
            {diag?.warnings.map((d, i) => <div key={i} style={{ color: '#92400e' }}>[{d.code}] {d.message}</div>)}
            {diag && !diag.errors.length && <div style={{ color: '#15803d' }}>沒有錯誤</div>}
          </div>
          <div style={{ padding: 8, overflow: 'auto', fontFamily: 'ui-monospace, monospace', borderTop: '1px solid #eee' }}>
            <b>Log / Monitor</b>
            {logs.map((l, i) => <div key={i} style={{ color: l.level === 'error' ? '#b91c1c' : '#111', whiteSpace: 'pre-wrap' }}>{l.msg}</div>)}
          </div>
          <textarea value={json} onChange={(e) => setJson(e.target.value)} placeholder="存檔後 workflow JSON 會出現在這裡；也可以貼上 JSON 後按「從 JSON 載入」"
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, border: 0, borderTop: '1px solid #ddd', padding: 8 }} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
