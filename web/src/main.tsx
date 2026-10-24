import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { compileWorkflow, resolveNodePorts, type BodyPorts, type CompileResult, type Diagnostic, type ResolvedPorts } from '../../src/compiler.js';
import { runWorkflow } from '../../src/engine.js';
import { demoRuntime } from '../../src/demo/scenario.js';
import type { RunEvent, WorkflowGraph, WorkflowNode } from '../../src/types.js';
import demoWorkflow from '../../workflows/fix-until-tests-pass.json';
import { loadBrowserRegistry } from './registry-browser.js';
import { createEditor, type EditorApi } from './editor.js';
import { PropertiesPanel } from './properties.js';
import { NodeRunPanel, RunHistory, RunSummary, Badge } from './monitor-panel.js';
import { applyEvent, emptyRun, reduceEvents, statusesFor, type RunView } from './monitor.js';
import { backend, type RunMeta } from './api.js';

const STORAGE_KEY = 'agent-workflow-poc:workflow';
const registry = loadBrowserRegistry();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const COMPOSITES = ['loop', 'foreach'];
const DEMO_INPUTS = { request: '修正 parser 空字串 bug 並讓測試通過', repository: 'github.com/acme/parser' };

type Tab<T extends string> = [T, string];
function Tabs<T extends string>(props: { tabs: Tab<T>[]; value: T; onChange: (t: T) => void }) {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', background: '#f8fafc' }}>
      {props.tabs.map(([k, label]) => (
        <button key={k} data-tab={k} onClick={() => props.onChange(k)}
          style={{ flex: 1, padding: '8px 6px', border: 0, borderBottom: props.value === k ? '3px solid #2563eb' : '3px solid transparent', background: 'transparent', fontWeight: props.value === k ? 700 : 400, cursor: 'pointer' }}>
          {label}
        </button>
      ))}
    </div>
  );
}

function App() {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<EditorApi | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowGraph>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : clone(demoWorkflow as WorkflowGraph);
  });
  const wfRef = useRef(workflow);
  wfRef.current = workflow;
  const [view, setView] = useState(''); // '' = 外層 DAG；否則 = composite node id（顯示其 body）
  const viewRef = useRef(view);
  const [viewIteration, setViewIteration] = useState<number | null>(null); // null = 最新一輪
  const [selected, setSelected] = useState<string | null>(null);
  const [diag, setDiag] = useState<CompileResult | null>(null);
  const [logs, setLogs] = useState<{ msg: string; level: string }[]>([]);
  const [leftTab, setLeftTab] = useState<'library' | 'history'>('library');
  const [rightTab, setRightTab] = useState<'props' | 'run'>('props');
  const [bottomTab, setBottomTab] = useState<'diag' | 'log' | 'json'>('diag');
  const [jsonText, setJsonText] = useState('');
  // ---- run state
  const runRef = useRef<RunView>(emptyRun());
  const eventsRef = useRef<RunEvent[]>([]);
  const [, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<'backend' | 'browser'>('browser');
  const [backendInfo, setBackendInfo] = useState<{ runtime: { mode: string; reason: string } } | null>(null);
  const [scenario, setScenario] = useState<'pass' | 'fail'>('pass');
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [activeRun, setActiveRun] = useState<RunMeta | null>(null);
  const [replay, setReplay] = useState<{ pos: number; total: number } | null>(null);
  const stopStream = useRef<(() => void) | null>(null);
  const [savedWorkflows, setSavedWorkflows] = useState<{ id: string; name?: string }[]>([]);

  const log = (msg: string, level: 'info' | 'error' = 'info') => setLogs((l) => [...l.slice(-400), { msg, level }]);
  const composites = useMemo(() => workflow.nodes.filter((n) => COMPOSITES.includes(n.type)), [workflow]);

  // ------------------------------------------------------------ graph helpers
  const viewGraph = (wf = wfRef.current, v = viewRef.current): WorkflowGraph => (v ? wf.nodes.find((n) => n.id === v)?.body ?? { nodes: [], edges: [] } : wf);
  const bodyPortsFor = (v: string, wf = wfRef.current): BodyPorts | undefined => {
    if (!v) return undefined;
    const c = wf.nodes.find((n) => n.id === v);
    if (!c) return undefined;
    try {
      return resolveNodePorts(c, registry.get(c.type)!, registry).body;
    } catch {
      return undefined;
    }
  };

  /** 把目前畫面（外層或某 composite body）的編輯寫回完整 workflow */
  function commit(): WorkflowGraph {
    if (!api.current) return wfRef.current;
    const g = api.current.exportGraph();
    const v = viewRef.current;
    const wf = clone(wfRef.current);
    if (!v) {
      wf.nodes = g.nodes.map((n) => ({ ...n, body: wf.nodes.find((o) => o.id === n.id)?.body ?? n.body }));
      wf.edges = g.edges;
    } else {
      const c = wf.nodes.find((n) => n.id === v);
      if (c) c.body = g;
    }
    wfRef.current = wf;
    setWorkflow(wf);
    return wf;
  }

  // ------------------------------------------------------------ validation（即時）
  const validateTimer = useRef<ReturnType<typeof setTimeout>>();
  function validateNow(): CompileResult {
    const wf = commit();
    const r = compileWorkflow(wf, registry);
    setDiag(r);
    const v = viewRef.current;
    const prefix = v ? `${v}.body/` : '';
    const counts: Record<string, number> = {};
    for (const e of r.errors) {
      if (!e.node) continue;
      if (e.node.startsWith(prefix) && !e.node.slice(prefix.length).includes('/')) counts[e.node.slice(prefix.length)] = (counts[e.node.slice(prefix.length)] ?? 0) + 1;
      else if (!v && e.node.includes('.body/')) {
        const owner = e.node.split('.body/')[0];
        counts[owner] = (counts[owner] ?? 0) + 1;
      }
    }
    api.current?.setErrors(counts);
    return r;
  }
  const scheduleValidate = () => {
    clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(validateNow, 150);
  };

  // ------------------------------------------------------------ view / status
  const latestIteration = (v: string) => {
    const its = runRef.current.iterations[v] ?? [];
    return its.length ? Math.max(...its) : 0;
  };
  const effIteration = (v = viewRef.current) => (v ? (viewIteration ?? latestIteration(v)) : null);
  const effIterRef = useRef<number | null>(null);
  effIterRef.current = view ? (viewIteration ?? latestIteration(view)) : null;
  const paintScheduled = useRef(false);
  function paint() {
    if (paintScheduled.current) return;
    paintScheduled.current = true;
    requestAnimationFrame(() => {
      paintScheduled.current = false;
      const v = viewRef.current;
      api.current?.setStatuses(statusesFor(runRef.current, v, v ? (effIterRef.current ?? latestIteration(v)) : null));
      setTick((t) => t + 1);
    });
  }
  useEffect(paint, [view, viewIteration]);

  async function show(v: string, wf = wfRef.current) {
    if (!api.current) return;
    viewRef.current = v;
    setView(v);
    setSelected(null);
    await api.current.load(viewGraph(wf, v), bodyPortsFor(v, wf));
    validateNow();
    paint();
  }

  useEffect(() => {
    let disposed = false;
    void createEditor(container.current!, registry, {
      log,
      onSelect: (id) => setSelected(id),
      onChange: scheduleValidate,
    }).then(async (e) => {
      if (disposed) return e.destroy();
      api.current = e;
      await show('');
    });
    void backend.health().then((h) => {
      if (!h) return log('backend 未啟動 → 使用瀏覽器內執行（npm run server 可啟用 backend 執行 / SSE / 歷史紀錄）');
      setBackendInfo(h);
      setMode('backend');
      log(`已連上 backend（runtime: ${h.runtime.mode} — ${h.runtime.reason}）`);
      void refreshRuns();
      void fetch('/api/workflows').then((r) => r.json()).then(setSavedWorkflows);
    });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && selectedRef.current) void deleteNode(selectedRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      api.current?.destroy();
    };
  }, []);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // ------------------------------------------------------------ node edits
  async function updateNode(next: WorkflowNode) {
    await api.current?.updateNode(next);
    validateNow();
  }
  async function deleteNode(id: string) {
    const n = viewGraph().nodes.find((x) => x.id === id);
    if (!n || ['loop_in', 'loop_out'].includes(n.type)) return;
    await api.current?.removeNode(id);
    log(`刪除節點 ${id}`);
    validateNow();
  }
  async function addNode(type: string) {
    const wf = await api.current?.addNode(type);
    if (wf) {
      validateNow();
      setRightTab('props');
    }
  }

  // ------------------------------------------------------------ runs
  function resetRun() {
    stopStream.current?.();
    stopStream.current = null;
    runRef.current = emptyRun();
    eventsRef.current = [];
    setReplay(null);
    setViewIteration(null);
    paint();
  }
  const onRunEvent = (e: RunEvent) => {
    eventsRef.current.push(e);
    applyEvent(runRef.current, e);
    if (e.type === 'run_completed' && !e.data?.closed) log(`🏁 run ${e.run_id} → ${String(e.data?.status).toUpperCase()}`, e.data?.status === 'success' ? 'info' : 'error');
    else if (e.type === 'node_failed') log(`${e.key ?? e.node_id} ✗ ${e.data?.error}`, 'error');
    else if (e.type === 'log') log(`${e.key} [${e.data?.level}] ${e.data?.message}`);
    paint();
  };

  async function run() {
    const r = validateNow();
    if (!r.ok || !r.graph) {
      setBottomTab('diag');
      return log(`❌ 有 ${r.errors.length} 個驗證錯誤，無法執行`, 'error');
    }
    resetRun();
    setRunning(true);
    setRightTab('run');
    if (mode === 'backend') {
      try {
        const { run_id } = await backend.startRun({ workflow: wfRef.current, scenario, mock_delay_ms: 300, inputs: DEMO_INPUTS });
        log(`▶ backend run ${run_id}（SSE 串流中）`);
        attachStream(run_id);
      } catch (e) {
        setRunning(false);
        log(`backend 執行失敗：${(e as Error).message}`, 'error');
      }
      return;
    }
    log('▶ 瀏覽器內執行（mock agents）');
    const result = await runWorkflow(r.graph, DEMO_INPUTS, {
      runtime: demoRuntime({ passOnIteration: scenario === 'pass' ? 2 : null, flakyCoder: true, delayMs: 250 }),
      onEvent: onRunEvent,
      services: { fetch: window.fetch.bind(window) },
    });
    setActiveRun({ run_id: result.run_id, workflow_name: wfRef.current.name ?? '', status: result.status, started_at: Date.now(), source: 'browser', runtime: 'mock' });
    setRunning(false);
  }

  function attachStream(id: string) {
    setActiveRun({ run_id: id, workflow_name: wfRef.current.name ?? '', status: 'running', started_at: Date.now(), source: 'server', runtime: backendInfo?.runtime.mode ?? 'mock' });
    setRunning(true);
    stopStream.current = backend.stream(id, onRunEvent, () => {
      setRunning(false);
      void refreshRuns();
      void backend.getRun(id).then((r) => setActiveRun(r.meta)).catch(() => undefined);
    });
  }

  async function refreshRuns() {
    try {
      setRuns(await backend.listRuns());
    } catch (e) {
      log(`讀取執行紀錄失敗：${(e as Error).message}`, 'error');
    }
  }

  async function openRun(id: string) {
    try {
      const r = await backend.getRun(id);
      resetRun();
      if (r.workflow) {
        wfRef.current = r.workflow;
        setWorkflow(r.workflow);
        await show('', r.workflow);
      }
      setActiveRun(r.meta);
      setRightTab('run');
      if (r.meta.status === 'running') return attachStream(id);
      eventsRef.current = r.events;
      runRef.current = reduceEvents(r.events);
      setReplay({ pos: r.events.length, total: r.events.length });
      log(`📜 開啟 ${id}（${r.events.length} events${r.workflow ? '' : '，沒有存 workflow → 只顯示紀錄'}）`);
      paint();
    } catch (e) {
      log(`開啟 run 失敗：${(e as Error).message}`, 'error');
    }
  }

  function seek(pos: number) {
    runRef.current = reduceEvents(eventsRef.current.slice(0, pos));
    setReplay((r) => (r ? { ...r, pos } : r));
    paint();
  }
  const playTimer = useRef<ReturnType<typeof setInterval>>();
  function play() {
    clearInterval(playTimer.current);
    let pos = 0;
    seek(0);
    playTimer.current = setInterval(() => {
      pos += 1;
      seek(pos);
      if (pos >= eventsRef.current.length) clearInterval(playTimer.current);
    }, 60);
  }

  async function resume() {
    if (!activeRun) return;
    try {
      const { run_id } = await backend.resume(activeRun.run_id, { mock_delay_ms: 300 });
      log(`↻ resume ${activeRun.run_id} → 新 run ${run_id}（沿用已成功的 agent 節點）`);
      resetRun();
      setRightTab('run');
      attachStream(run_id);
    } catch (e) {
      log(`resume 失敗：${(e as Error).message}`, 'error');
    }
  }
  async function cancel() {
    if (activeRun && mode === 'backend') await backend.cancel(activeRun.run_id).catch((e) => log(String(e), 'error'));
  }

  // ------------------------------------------------------------ files
  function save() {
    const wf = commit();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wf));
    setJsonText(JSON.stringify(wf, null, 2));
    setBottomTab('json');
    log('💾 已存到 localStorage');
  }
  async function loadJson(text: string) {
    try {
      const wf = JSON.parse(text) as WorkflowGraph;
      wfRef.current = wf;
      setWorkflow(wf);
      await show('', wf);
      log('📂 已載入 workflow JSON');
    } catch (e) {
      log(`JSON 解析失敗：${(e as Error).message}`, 'error');
    }
  }
  async function loadSaved(id: string) {
    const wf = await fetch(`/api/workflows/${id}`).then((r) => r.json());
    await loadJson(JSON.stringify(wf));
  }
  async function reset() {
    localStorage.removeItem(STORAGE_KEY);
    await loadJson(JSON.stringify(demoWorkflow));
  }
  function download() {
    const wf = commit();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' }));
    a.download = 'workflow.json';
    a.click();
  }

  // ------------------------------------------------------------ derived for panels
  const g = viewGraph(workflow, view);
  const selNode = selected ? g.nodes.find((n) => n.id === selected) : undefined;
  const selDef = selNode ? registry.get(selNode.type) : undefined;
  let selPorts: ResolvedPorts | null = null;
  if (selNode && selDef) {
    try {
      selPorts = resolveNodePorts(selNode, selDef, registry, bodyPortsFor(view, workflow));
    } catch {
      selPorts = null;
    }
  }
  const prefix = view ? `${view}.body/` : '';
  const selErrors: Diagnostic[] = selected ? (diag?.errors ?? []).filter((e) => e.node === prefix + selected || (!view && e.node?.startsWith(`${selected}.body/`))) : [];
  const connected = new Set(g.edges.filter((e) => e.kind === 'data' && e.to.node === selected).map((e) => e.to.port));
  const library = useMemo(() => {
    const groups: Record<string, string[]> = {};
    const order = ['Flow', 'Logic', 'Data', 'Utility', 'IO', 'Agent Nodes'];
    for (const d of registry.list()) {
      if (['loop_in', 'loop_out'].includes(d.name) || d.source?.includes('test')) continue;
      (groups[d.category ?? (d.kind === 'agent' ? 'Agent Nodes' : 'Other')] ??= []).push(d.name);
    }
    return Object.entries(groups).sort(([a], [b]) => (order.indexOf(a) + 99) % 99 - ((order.indexOf(b) + 99) % 99));
  }, []);
  const btn = { padding: '5px 9px', cursor: 'pointer' } as const;
  const run_ = runRef.current;
  const iterList = view ? (run_.iterations[view] ?? []) : [];

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
      <style>{`@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(59,130,246,.6) } 50% { box-shadow: 0 0 0 10px rgba(59,130,246,0) } } button { font-size: 12px }`}</style>
      {/* ---------------- toolbar ---------------- */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #ddd', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12 }}>
        <b style={{ marginRight: 8, fontSize: 14 }}>Agent Workflow Editor</b>
        <select data-testid="view-select" value={view} onChange={(e) => { commit(); void show(e.target.value); }} style={btn}>
          <option value="">外層 DAG</option>
          {composites.map((l) => <option key={l.id} value={l.id}>{l.id} body（{l.type}）</option>)}
        </select>
        {view && iterList.length > 0 && (
          <select data-testid="view-iteration" style={btn} value={viewIteration ?? ''} onChange={(e) => setViewIteration(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">最新一輪（#{latestIteration(view)}）</option>
            {iterList.map((i) => <option key={i} value={i}>iteration #{i}</option>)}
          </select>
        )}
        <span style={{ borderLeft: '1px solid #ddd', height: 22 }} />
        <select data-testid="run-mode" value={mode} onChange={(e) => setMode(e.target.value as 'backend' | 'browser')} style={btn}>
          <option value="backend" disabled={!backendInfo}>Backend 執行{backendInfo ? `（${backendInfo.runtime.mode}）` : '（未連線）'}</option>
          <option value="browser">瀏覽器內執行（mock）</option>
        </select>
        <select value={scenario} onChange={(e) => setScenario(e.target.value as 'pass' | 'fail')} style={btn} title="demo mock agents 的情境">
          <option value="pass">情境：第 3 輪測試通過</option>
          <option value="fail">情境：測試永遠失敗</option>
        </select>
        <button data-testid="run" style={{ ...btn, background: '#2563eb', color: '#fff', border: 0, borderRadius: 4 }} disabled={running} onClick={() => void run()}>▶ 執行</button>
        {running && mode === 'backend' && <button style={btn} onClick={() => void cancel()}>■ 停止</button>}
        <span style={{ borderLeft: '1px solid #ddd', height: 22 }} />
        <button style={btn} onClick={() => void api.current?.layout()}>自動排版</button>
        <button style={btn} onClick={save}>存檔</button>
        <button style={btn} onClick={download}>下載 JSON</button>
        {savedWorkflows.length > 0 && (
          <select value="" style={btn} onChange={(e) => e.target.value && void loadSaved(e.target.value)}>
            <option value="">開啟 workflows/…</option>
            {savedWorkflows.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
          </select>
        )}
        <button style={btn} onClick={() => void reset()}>重設 demo</button>
        <span style={{ marginLeft: 'auto', color: diag?.ok ? '#15803d' : '#b91c1c' }} data-testid="validation-status">
          {diag ? (diag.ok ? `✓ 驗證通過（${diag.warnings.length} warnings）` : `✗ ${diag.errors.length} 個錯誤`) : ''}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr 400px', minHeight: 0 }}>
        {/* ---------------- left: library / history ---------------- */}
        <div style={{ borderRight: '1px solid #ddd', display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
          <Tabs tabs={[['library', '節點庫'], ['history', '執行紀錄']]} value={leftTab} onChange={(t) => { setLeftTab(t); if (t === 'history') void refreshRuns(); }} />
          <div style={{ overflow: 'auto', minHeight: 0 }}>
            {leftTab === 'library' ? (
              <div style={{ padding: 8, fontSize: 12 }} data-testid="node-library">
                {library.map(([cat, names]) => (
                  <div key={cat} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, color: '#475569', margin: '4px 0' }}>{cat}</div>
                    {names.map((name) => (
                      <div key={name} data-library-item={name} title={registry.get(name)?.description} onClick={() => void addNode(name)}
                        style={{ padding: '4px 8px', margin: '2px 0', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', background: '#fff' }}>
                        {name}
                      </div>
                    ))}
                  </div>
                ))}
                <div style={{ color: '#94a3b8' }}>點一下加入目前畫面</div>
              </div>
            ) : (
              <RunHistory runs={runs} backend={!!backendInfo} activeId={activeRun?.run_id} onOpen={(id) => void openRun(id)} onRefresh={() => void refreshRuns()} />
            )}
          </div>
        </div>

        {/* ---------------- center: canvas + bottom ---------------- */}
        <div style={{ display: 'grid', gridTemplateRows: '1fr 170px', minHeight: 0, minWidth: 0 }}>
          <div ref={container} data-testid="canvas" style={{ position: 'relative', background: '#f8fafc', minHeight: 0, overflow: 'hidden' }} />
          <div style={{ borderTop: '1px solid #ddd', display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
            <Tabs tabs={[['diag', `Diagnostics${diag ? `（${diag.errors.length}/${diag.warnings.length}）` : ''}`], ['log', 'Log'], ['json', 'Workflow JSON']]} value={bottomTab} onChange={(t) => { setBottomTab(t); if (t === 'json') setJsonText(JSON.stringify(commit(), null, 2)); }} />
            <div style={{ overflow: 'auto', fontSize: 12, padding: bottomTab === 'json' ? 0 : 8, minHeight: 0 }}>
              {bottomTab === 'diag' && (
                <div data-testid="diagnostics">
                  {diag?.errors.map((d, i) => <div key={i} style={{ color: '#b91c1c', cursor: d.node ? 'pointer' : undefined }} onClick={() => d.node && api.current?.select(d.node.split('/').pop()!)}>[{d.code}] {d.message}</div>)}
                  {diag?.warnings.map((d, i) => <div key={i} style={{ color: '#92400e' }}>[{d.code}] {d.message}</div>)}
                  {diag && !diag.errors.length && <div style={{ color: '#15803d' }}>沒有錯誤（每次修改都會用同一份 compileWorkflow 重新驗證）</div>}
                </div>
              )}
              {bottomTab === 'log' && logs.map((l, i) => <div key={i} style={{ fontFamily: 'ui-monospace, monospace', color: l.level === 'error' ? '#b91c1c' : '#111', whiteSpace: 'pre-wrap' }}>{l.msg}</div>)}
              {bottomTab === 'json' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', height: '100%' }}>
                  <textarea data-testid="workflow-json" value={jsonText} onChange={(e) => setJsonText(e.target.value)} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, border: 0, padding: 8, resize: 'none' }} />
                  <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <button onClick={() => setJsonText(JSON.stringify(commit(), null, 2))}>重新整理</button>
                    <button onClick={() => void loadJson(jsonText)}>套用 JSON</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---------------- right: properties / run ---------------- */}
        <div style={{ borderLeft: '1px solid #ddd', display: 'grid', gridTemplateRows: 'auto auto 1fr', minHeight: 0 }}>
          <Tabs tabs={[['props', '屬性'], ['run', '執行監控']]} value={rightTab} onChange={setRightTab} />
          <div>
            {rightTab === 'run' && <RunSummary run={run_} metaStatus={activeRun?.run_id === run_.run_id ? activeRun?.status : undefined} />}
            {rightTab === 'run' && activeRun && (
              <div style={{ padding: '0 12px 8px', fontSize: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {replay && (
                  <>
                    <span>Replay</span>
                    <input data-testid="replay-slider" type="range" min={0} max={replay.total} value={replay.pos} onChange={(e) => seek(Number(e.target.value))} style={{ flex: 1 }} />
                    <span>{replay.pos}/{replay.total}</span>
                    <button onClick={play}>▶ 重播</button>
                  </>
                )}
                {mode === 'backend' && !running && ['failed', 'cancelled', 'interrupted'].includes(activeRun.status) && (
                  <button data-testid="resume" onClick={() => void resume()}>↻ Resume（沿用成功的 agent 節點）</button>
                )}
                {activeRun.resumed_from && <span>resume 自 <code>{activeRun.resumed_from}</code></span>}
                {activeRun.status !== run_.status && activeRun.status !== 'running' && <Badge status={activeRun.status} />}
              </div>
            )}
          </div>
          <div style={{ overflow: 'auto', minHeight: 0 }}>
            {!selNode && (
              <div style={{ padding: 12, color: '#64748b', fontSize: 12 }}>
                點選畫布上的節點以編輯屬性或查看執行結果。
                {rightTab === 'run' && run_.status !== 'idle' && (
                  <div style={{ marginTop: 8 }}>
                    {[...run_.records.values()].filter((r) => r.scopeKey === (view ? `${view}#${effIteration()}` : 'root')).map((r) => (
                      <div key={r.key} style={{ display: 'flex', gap: 6, margin: '3px 0', cursor: 'pointer' }} onClick={() => api.current?.select(r.node_id)}>
                        <Badge status={r.status} /> <span>{r.node_id}</span> <span style={{ color: '#94a3b8' }}>{r.duration_ms !== undefined ? `${r.duration_ms} ms` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {selNode && selDef && rightTab === 'props' && (
              <PropertiesPanel key={`${view}/${selNode.id}`} node={selNode} def={selDef} registry={registry} ports={selPorts} errors={selErrors} connectedInputs={connected}
                onChange={(n) => void updateNode(n)} onDelete={() => void deleteNode(selNode.id)}
                onOpenBody={!view && COMPOSITES.includes(selNode.type) ? () => { commit(); void show(selNode.id); } : undefined} />
            )}
            {selNode && rightTab === 'run' && (
              <NodeRunPanel run={run_} view={view} nodeId={selNode.id} def={selDef} iteration={effIteration()}
                onIteration={(i) => setViewIteration(i)}
                onOpenIteration={!view && COMPOSITES.includes(selNode.type) ? (i) => { commit(); void show(selNode.id).then(() => setViewIteration(i)); } : undefined} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
