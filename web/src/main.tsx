import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { compileWorkflow, resolveNodePorts, type CompileResult, type Diagnostic, type ResolvedPorts } from '../../src/compiler.js';
import { boundaryAnnotations, isDrillable, setGraphAt } from '../../src/graph-path.js';
import { runWorkflow } from '../../src/engine.js';
import { isV1 } from '../../src/dsl.js';
import { demoRuntime } from '../../src/demo/scenario.js';
import type { RunEvent, Scope, WorkflowGraph, WorkflowNode } from '../../src/types.js';
import demoWorkflow from '../../workflows/fix-until-tests-pass.json';
import { loadBrowserRegistry } from './registry-browser.js';
import { createEditor, type EditorApi } from './editor.js';
import { PropertiesPanel } from './properties.js';
import { NodeRunPanel, RunHistory, RunSummary, Badge } from './monitor-panel.js';
import { applyEvent, emptyRun, iterationsOf, reduceEvents, resolveScope, scopeKeyOf, statusesFor, type RunView } from './monitor.js';
import { backend, type RunMeta } from './api.js';
import { DiagnosticsList, NodeLibrary, Tabs } from './panels.js';
import { norm, resolveView, toFile, type Crumb } from './view.js';

const STORAGE_KEY = 'agent-workflow-poc:workflow:v1';
const ADV_KEY = 'agent-workflow-poc:advanced';
const registry = loadBrowserRegistry();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const DEMO_INPUTS = { request: '修正 parser 空字串 bug 並讓測試通過', repository: 'github.com/acme/parser' };

/** 打包進前端的 workflows/*.json：瀏覽器模式（沒有 backend）也能開啟 / 執行 subflow */
const BUNDLED: Record<string, WorkflowGraph> = Object.fromEntries(
  Object.entries(import.meta.glob('../../workflows/*.json', { eager: true, import: 'default' }) as Record<string, WorkflowGraph>).map(([f, w]) => [f.split('/').pop()!.replace(/\.json$/, ''), w]),
);



function App() {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<EditorApi | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowGraph>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return norm(saved ? JSON.parse(saved) : clone(demoWorkflow));
  });
  /** 進階功能開關（預設關）：舊格式 / advanced 節點 / 多層 drill-down / subflow 子圖 / resume / 瀏覽器內執行 */
  const [advanced, setAdvancedState] = useState(() => localStorage.getItem(ADV_KEY) === '1');
  const advRef = useRef(advanced);
  advRef.current = advanced;
  const wfRef = useRef(workflow);
  wfRef.current = workflow;
  // 畫布路徑（[] = 主流程）與每層選定的 iteration（null = 跟著最新一輪）
  const [path, setPath] = useState<Crumb[]>([]);
  const pathRef = useRef(path);
  const [picks, setPicks] = useState<(number | null)[]>([]);
  const picksRef = useRef(picks);
  picksRef.current = picks;
  /** 「開啟來源 workflow 編輯」前的 workflow，可以返回 */
  const [backStack, setBackStack] = useState<{ wf: WorkflowGraph; path: Crumb[] }[]>([]);
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
  const [savedWorkflows, setSavedWorkflows] = useState<{ id: string; name?: string }[]>(() => Object.entries(BUNDLED).map(([id, w]) => ({ id, name: w.name })));

  const log = (msg: string, level: 'info' | 'error' = 'info') => setLogs((l) => [...l.slice(-400), { msg, level }]);

  // ------------------------------------------------------------ graph helpers
  const viewOf = (wf = wfRef.current, p = pathRef.current) => resolveView(wf, p, registry);
  const viewGraph = (wf = wfRef.current, p = pathRef.current): WorkflowGraph => viewOf(wf, p)?.graph ?? { nodes: [], edges: [] };
  const readOnlyNow = () => !!viewOf()?.readOnly;

  /** 把目前畫面（主流程或任意深度的 body）的編輯寫回「同一份」workflow JSON 的對應巢狀位置 */
  function commit(): WorkflowGraph {
    if (!api.current) return wfRef.current;
    const v = viewOf();
    if (!v || v.readOnly) return wfRef.current; // subflow 畫面唯讀：不寫回
    const wf = setGraphAt(wfRef.current, v.inner, api.current.exportGraph());
    wfRef.current = wf;
    setWorkflow(wf);
    return wf;
  }

  // ------------------------------------------------------------ validation（即時）
  const validateTimer = useRef<ReturnType<typeof setTimeout>>();
  function validateNow(): CompileResult {
    const wf = commit();
    const r = compileWorkflow(wf, registry, { advanced: advRef.current });
    setDiag(r);
    const v = viewOf(wf);
    const counts: Record<string, number> = {};
    if (v && !v.readOnly) {
      // 錯誤的 node 欄位帶完整巢狀路徑（a.body/b.body/x）：本層節點直接算，更深層的算到本層的 composite 上
      const prefix = v.inner.map((id) => `${id}.body/`).join('');
      for (const e of r.errors) {
        if (!e.node?.startsWith(prefix)) continue;
        const rest = e.node.slice(prefix.length);
        const owner = rest.includes('/') ? rest.split('.body/')[0] : rest;
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
  /** 目前畫面對應的執行 scope（每層 iteration 已解析；null 的層跟著最新一輪） */
  const currentScope = (): Scope => resolveScope(runRef.current, pathRef.current.map((c) => c.id), picksRef.current);
  const paintScheduled = useRef(false);
  function paint() {
    if (paintScheduled.current) return;
    paintScheduled.current = true;
    requestAnimationFrame(() => {
      paintScheduled.current = false;
      api.current?.setStatuses(statusesFor(runRef.current, currentScope()));
      setTick((t) => t + 1);
    });
  }
  useEffect(paint, [path, picks]);

  async function show(p: Crumb[], pk: (number | null)[] = p.map(() => null), wf = wfRef.current) {
    if (!api.current) return;
    let v = resolveView(wf, p, registry);
    if (!v) {
      log(`找不到路徑 ${p.map((c) => c.id).join(' › ')}，回到主流程`, 'error');
      p = [];
      pk = [];
      v = resolveView(wf, [], registry)!;
    }
    pathRef.current = p;
    picksRef.current = pk;
    setPath(p);
    setPicks(pk);
    setSelected(null);
    const boundaries: Record<string, string> = {};
    for (const n of v.graph.nodes) {
      if (n.type === 'loop_in') boundaries[n.id] = '輸入邊界';
      if (n.type === 'loop_out') boundaries[n.id] = '輸出邊界';
      if (v.composite?.type === 'subflow' && !v.inner.length && n.type === 'start') boundaries[n.id] = '子流程輸入';
      if (v.composite?.type === 'subflow' && !v.inner.length && n.type === 'end') boundaries[n.id] = '子流程輸出';
    }
    const annotations = v.composite && v.outer ? boundaryAnnotations(v.outer, v.composite, v.graph) : undefined;
    await api.current.load(v.graph, { body: v.body, readOnly: v.readOnly, annotations, boundaries, v1: isV1(v.root) });
    validateNow();
    paint();
  }

  /** 取得 saved workflow：backend 的 /api/workflows/:id，沒有 backend 時用打包進前端的 workflows/*.json */
  async function loadWorkflowSource(id: string): Promise<WorkflowGraph | undefined> {
    if (backendInfoRef.current) {
      const r = await fetch(`/api/workflows/${encodeURIComponent(id)}`).catch(() => null);
      if (r?.ok) return norm(await r.json());
    }
    return BUNDLED[id] ? norm(clone(BUNDLED[id])) : undefined;
  }

  /** drill-in：雙擊 loop / foreach / subflow，或從屬性 / 監控面板進入（可指定 iteration） */
  async function drill(id: string, iteration: number | null = null) {
    const v = viewOf();
    const n = v?.graph.nodes.find((x) => x.id === id);
    if (!v || !n || !isDrillable(n)) return;
    if (!advRef.current && (n.type !== 'loop' || pathRef.current.length > 0))
      return log(`「${n.type}」子圖 / 多層 drill-down 是進階功能（工具列的「進階功能」開關）`, 'error');
    const wf = commit();
    const crumb: Crumb = { id, kind: n.type, label: n.label || n.id };
    if (n.type === 'subflow') {
      const wid = String(n.config?.workflow ?? '');
      const snap = runRef.current.subflows[`${scopeKeyOf(currentScope())}/${id}`];
      crumb.workflowId = wid;
      crumb.graph = snap?.workflow ?? (await loadWorkflowSource(wid));
      if (!crumb.graph) return log(`找不到子流程 workflow「${wid}」`, 'error');
      log(`⤵ 進入 subflow ${id} → ${wid}（${snap ? '本次 run 的快照' : '目前 workflows/ 的版本'}，唯讀）`);
    }
    await show([...pathRef.current, crumb], [...picksRef.current, iteration], wf);
  }
  async function navigate(depth: number) {
    const wf = commit();
    await show(pathRef.current.slice(0, depth), picksRef.current.slice(0, depth), wf);
  }
  /** subflow 畫面 →「開啟來源 workflow 編輯」：把來源 workflow 載入成主流程（可再返回） */
  async function openSource() {
    const v = viewOf();
    if (!v?.sourceId) return;
    const src = await loadWorkflowSource(v.sourceId);
    if (!src) return log(`找不到來源 workflow「${v.sourceId}」`, 'error');
    setBackStack((s) => [...s, { wf: wfRef.current, path: pathRef.current }]);
    resetRun();
    wfRef.current = { ...src, id: v.sourceId };
    setWorkflow(wfRef.current);
    await show([], [], wfRef.current);
    log(`✎ 開啟來源 workflow「${v.sourceId}」編輯（存回 workflows/ 會影響所有引用它的 workflow）`);
  }
  async function goBack() {
    const prev = backStack[backStack.length - 1];
    if (!prev) return;
    setBackStack((s) => s.slice(0, -1));
    resetRun();
    wfRef.current = prev.wf;
    setWorkflow(prev.wf);
    await show([], [], prev.wf);
  }
  async function saveToServer() {
    const wf = commit();
    const id = wf.id;
    if (!id) return log('這份 workflow 沒有 id，無法存回 workflows/', 'error');
    const r = await fetch(`/api/workflows/${encodeURIComponent(id)}${advRef.current ? '?advanced=1' : ''}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toFile(wf)) });
    const body = await r.json().catch(() => ({}));
    if (r.ok) log(`💾 已存回 workflows/${id}.json`);
    else log(`存回失敗（${r.status}）：${body.error ?? ''}${body.errors ? ' — ' + body.errors.map((e: Diagnostic) => e.message).join('；') : ''}`, 'error');
  }

  useEffect(() => {
    let disposed = false;
    void createEditor(container.current!, registry, {
      log,
      onSelect: (id) => setSelected(id),
      onChange: scheduleValidate,
      onOpen: (id) => void drillRef.current(id),
    }).then(async (e) => {
      if (disposed) return e.destroy();
      api.current = e;
      await show([]);
    });
    void backend.health().then((h) => {
      if (!h) return log('backend 未啟動 → 使用瀏覽器內執行（npm run server 可啟用 backend 執行 / SSE / 歷史紀錄）');
      setBackendInfo(h);
      backendInfoRef.current = h;
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
  const drillRef = useRef(drill);
  drillRef.current = drill;
  const backendInfoRef = useRef(backendInfo);

  // ------------------------------------------------------------ node edits
  async function updateNode(next: WorkflowNode) {
    await api.current?.updateNode(next);
    validateNow();
  }
  async function deleteNode(id: string) {
    const n = viewGraph().nodes.find((x) => x.id === id);
    if (!n || ['loop_in', 'loop_out'].includes(n.type) || readOnlyNow()) return;
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
    picksRef.current = pathRef.current.map(() => null);
    setPicks(picksRef.current);
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
    if (mode !== 'backend' && !advRef.current) {
      setRunning(false);
      return log('需要 backend（npm run server）才能執行；瀏覽器內執行是進階功能', 'error');
    }
    if (mode === 'backend') {
      try {
        const { run_id } = await backend.startRun({ workflow: toFile(wfRef.current), scenario, mock_delay_ms: 300, inputs: DEMO_INPUTS, advanced: advRef.current });
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
      // subflow 在瀏覽器模式：從 backend 或打包的 workflows/*.json 載入，用瀏覽器端 registry 編譯
      services: {
        fetch: window.fetch.bind(window),
        registry,
        loadWorkflow: async (id: string) => {
          const w = await loadWorkflowSource(id);
          if (!w) throw new Error(`workflow "${id}" not found`);
          return w;
        },
      },
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
        const w = norm(r.workflow);
        wfRef.current = w;
        setWorkflow(w);
        await show([], [], w);
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
      const { run_id } = await backend.resume(activeRun.run_id, { mock_delay_ms: 300, advanced: true });
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toFile(wf)));
    setJsonText(JSON.stringify(toFile(wf), null, 2));
    setBottomTab('json');
    log('💾 已存到 localStorage');
  }
  async function loadJson(text: string) {
    try {
      const wf = norm(JSON.parse(text));
      wfRef.current = wf;
      setWorkflow(wf);
      setBackStack([]);
      await show([], [], wf);
      log('📂 已載入 workflow JSON');
    } catch (e) {
      log(`JSON 解析失敗：${(e as Error).message}`, 'error');
    }
  }
  async function loadSaved(id: string) {
    const wf = await loadWorkflowSource(id);
    if (!wf) return log(`找不到 workflow「${id}」`, 'error');
    await loadJson(JSON.stringify({ ...wf, id }));
  }
  async function reset() {
    localStorage.removeItem(STORAGE_KEY);
    await loadJson(JSON.stringify(demoWorkflow));
    setJsonText('');
  }
  function download() {
    const wf = commit();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(toFile(wf), null, 2)], { type: 'application/json' }));
    a.download = 'workflow.json';
    a.click();
  }

  async function setAdvanced(on: boolean) {
    localStorage.setItem(ADV_KEY, on ? '1' : '0');
    advRef.current = on;
    setAdvancedState(on);
    if (!on && mode === 'browser' && backendInfo) setMode('backend');
    log(on ? '⚙ 進階功能已開啟：舊版 control-edge 格式、advanced 節點、多層 drill-down / subflow 子圖、resume、瀏覽器內執行' : '進階功能已關閉（DSL v1）');
    // 不在 v1 的深層路徑 → 回到主流程
    const p = !on && (pathRef.current.length > 1 || pathRef.current.some((c) => c.kind !== 'loop')) ? [] : pathRef.current;
    await show(p, picksRef.current.slice(0, p.length), commit());
  }

  // ------------------------------------------------------------ derived for panels
  const cur = resolveView(workflow, path, registry);
  const g = cur?.graph ?? { nodes: [], edges: [] };
  const readOnly = !!cur?.readOnly;
  const selNode = selected ? g.nodes.find((n) => n.id === selected) : undefined;
  const selDef = selNode ? registry.get(selNode.type) : undefined;
  let selPorts: ResolvedPorts | null = null;
  if (selNode && selDef) {
    try {
      selPorts = resolveNodePorts(selNode, selDef, registry, cur?.body, { v1: isV1(cur?.root) });
    } catch {
      selPorts = null;
    }
  }
  const prefix = (cur?.inner ?? []).map((id) => `${id}.body/`).join('');
  const selErrors: Diagnostic[] = selected && !readOnly ? (diag?.errors ?? []).filter((e) => e.node === prefix + selected || e.node?.startsWith(`${prefix}${selected}.body/`)) : [];
  const connected = new Set(g.edges.filter((e) => e.kind === 'data' && e.to.node === selected).map((e) => e.to.port));
  const library = useMemo(() => {
    const groups: Record<string, string[]> = {};
    const order = ['Flow', 'Logic', 'Data', 'Utility', 'IO', 'Agent Nodes'];
    for (const d of registry.list({ advanced })) {
      if (['loop_in', 'loop_out'].includes(d.name) || /(^|\/)test\//.test(d.source ?? '')) continue; // 只排除 test/ 目錄下的測試用節點（不能用 includes('test')：會把 testing_agent 也濾掉）
      (groups[d.category ?? (d.kind === 'agent' ? 'Agent Nodes' : 'Other')] ??= []).push(d.name);
    }
    return Object.entries(groups).sort(([a], [b]) => (order.indexOf(a) + 99) % 99 - ((order.indexOf(b) + 99) % 99));
  }, [advanced]);
  const v1View = isV1(cur?.root);
  // v1：loop 的 carry / on_body_failure 是進階選項，屬性面板不顯示
  const selDefView = selDef && v1View && !advanced && selDef.name === 'loop' && selDef.config_schema
    ? { ...selDef, config_schema: { ...selDef.config_schema, properties: Object.fromEntries(Object.entries((selDef.config_schema.properties ?? {}) as Record<string, unknown>).filter(([k]) => !['carry', 'on_body_failure'].includes(k))) } }
    : selDef;
  const btn = { padding: '5px 9px', cursor: 'pointer' } as const;
  const run_ = runRef.current;
  const scope = resolveScope(run_, path.map((c) => c.id), picks);

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
      <style>{`@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(59,130,246,.6) } 50% { box-shadow: 0 0 0 10px rgba(59,130,246,0) } } button { font-size: 12px }`}</style>
      {/* ---------------- toolbar ---------------- */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #ddd', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12 }}>
        <b style={{ marginRight: 8, fontSize: 14 }}>Agent Workflow Editor</b>
        <span style={{ borderLeft: '1px solid #ddd', height: 22 }} />
        {advanced ? (
          <select data-testid="run-mode" value={mode} onChange={(e) => setMode(e.target.value as 'backend' | 'browser')} style={btn}>
            <option value="backend" disabled={!backendInfo}>Backend 執行{backendInfo ? `（${backendInfo.runtime.mode}）` : '（未連線）'}</option>
            <option value="browser">瀏覽器內執行（mock）</option>
          </select>
        ) : (
          <span data-testid="run-mode" style={{ color: backendInfo ? '#334155' : '#b91c1c' }}>{backendInfo ? `Backend（${backendInfo.runtime.mode}）` : 'backend 未連線（npm run server）'}</span>
        )}
        <select value={scenario} onChange={(e) => setScenario(e.target.value as 'pass' | 'fail')} style={btn} title="demo mock agents 的情境">
          <option value="pass">情境：第 3 輪測試通過</option>
          <option value="fail">情境：測試永遠失敗</option>
        </select>
        <button data-testid="run" style={{ ...btn, background: '#2563eb', color: '#fff', border: 0, borderRadius: 4 }} disabled={running} onClick={() => void run()}>▶ 執行</button>
        {running && mode === 'backend' && <button style={btn} onClick={() => void cancel()}>■ 停止</button>}
        <span style={{ borderLeft: '1px solid #ddd', height: 22 }} />
        <button style={btn} onClick={() => void api.current?.layout()}>自動排版</button>
        <button style={btn} onClick={save}>存檔</button>
        {backendInfo && workflow.id && <button style={btn} data-testid="save-server" onClick={() => void saveToServer()} title="PUT /api/workflows/:id（有驗證錯誤會被拒絕）">存回 workflows/{workflow.id}.json</button>}
        <button style={btn} onClick={download}>下載 JSON</button>
        {savedWorkflows.length > 0 && (
          <select value="" style={btn} onChange={(e) => e.target.value && void loadSaved(e.target.value)}>
            <option value="">開啟 workflows/…</option>
            {savedWorkflows.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
          </select>
        )}
        <button style={btn} onClick={() => void reset()}>重設 demo</button>
        <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} title="舊版 control-edge 格式、advanced 節點（join / foreach / subflow …）、多層 drill-down、resume、瀏覽器內執行">
          <input data-testid="advanced-toggle" type="checkbox" checked={advanced} onChange={(e) => void setAdvanced(e.target.checked)} /> 進階功能
        </label>
        <span style={{ color: '#64748b' }} data-testid="dsl-version">{v1View ? 'DSL v1' : '舊格式（control edges）'}</span>
        <span style={{ color: diag?.ok ? '#15803d' : '#b91c1c' }} data-testid="validation-status">
          {diag ? (diag.ok ? `✓ 驗證通過（${diag.warnings.length} warnings）` : `✗ ${diag.errors.length} 個錯誤`) : ''}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr 400px', minHeight: 0 }}>
        {/* ---------------- left: library / history ---------------- */}
        <div style={{ borderRight: '1px solid #ddd', display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
          <Tabs tabs={[['library', '節點庫'], ['history', '執行紀錄']]} value={leftTab} onChange={(t) => { setLeftTab(t); if (t === 'history') void refreshRuns(); }} />
          <div style={{ overflow: 'auto', minHeight: 0 }}>
            {leftTab === 'library' ? (
              <NodeLibrary groups={library} registry={registry} onAdd={(name) => void addNode(name)} />
            ) : (
              <RunHistory runs={runs} backend={!!backendInfo} activeId={activeRun?.run_id} onOpen={(id) => void openRun(id)} onRefresh={() => void refreshRuns()} />
            )}
          </div>
        </div>

        {/* ---------------- center: canvas + bottom ---------------- */}
        <div style={{ display: 'grid', gridTemplateRows: '1fr 170px', minHeight: 0, minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
            {/* ---------------- breadcrumb（drill-down 導覽） ---------------- */}
            <div data-testid="breadcrumb" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, padding: '5px 10px', borderBottom: '1px solid #e2e8f0', background: '#fff', fontSize: 13 }}>
              {backStack.length > 0 && <button data-testid="go-back" style={btn} onClick={() => void goBack()}>← 返回 {backStack[backStack.length - 1].wf.name ?? backStack[backStack.length - 1].wf.id ?? '上一個 workflow'}</button>}
              <span data-crumb={0} onClick={() => path.length && void navigate(0)} style={{ cursor: path.length ? 'pointer' : 'default', fontWeight: path.length ? 400 : 700, color: path.length ? '#2563eb' : '#0f172a' }}>
                主流程{workflow.id ? `（${workflow.id}）` : ''}
              </span>
              {path.map((c, i) => {
                const last = i === path.length - 1;
                const its = c.kind === 'subflow' ? [] : iterationsOf(run_, scope.slice(0, i), c.id);
                return (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: '#94a3b8' }}>›</span>
                    <span data-crumb={i + 1} onClick={() => !last && void navigate(i + 1)}
                      style={{ cursor: last ? 'default' : 'pointer', fontWeight: last ? 700 : 400, color: last ? '#0f172a' : '#2563eb' }}>
                      {c.id}
                      <span style={{ color: '#64748b', fontWeight: 400 }}>（{c.kind === 'subflow' ? `subflow → ${c.workflowId}` : c.kind}）</span>
                    </span>
                    {its.length > 0 && (
                      <select data-crumb-iteration={i + 1} value={picks[i] ?? ''} style={{ fontSize: 12 }}
                        onChange={(e) => setPicks((p) => { const n = [...p]; n[i] = e.target.value === '' ? null : Number(e.target.value); picksRef.current = n; return n; })}>
                        <option value="">最新（#{its[its.length - 1]}）</option>
                        {its.map((it) => <option key={it} value={it}>#{it}</option>)}
                      </select>
                    )}
                  </span>
                );
              })}
              <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 12 }}>{advanced ? '雙擊 loop / foreach / subflow 節點進入子圖' : '雙擊 loop 節點編輯它的 body'}</span>
            </div>
            <div style={{ position: 'relative', minHeight: 0 }}>
              <div ref={container} data-testid="canvas" style={{ position: 'absolute', inset: 0, background: readOnly ? '#f5f3ff' : '#f8fafc', overflow: 'hidden' }} />
              {cur?.composite && (
                <div data-testid="scope-banner" style={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 5, pointerEvents: 'none', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ pointerEvents: 'auto', background: 'rgba(255,255,255,.95)', border: `1px solid ${readOnly ? '#a78bfa' : '#cbd5e1'}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, maxWidth: 640 }}>
                    {readOnly ? (
                      <>
                        <b>🔒 唯讀：sub-workflow「{cur.sourceId}」</b>
                        <div style={{ color: '#475569' }}>這份 workflow 可能被其他 workflow 引用，這裡不能直接改。{scope.length && run_.subflows[`${scopeKeyOf(scope.slice(0, path.findIndex((c) => c.kind === 'subflow')))}/${path.find((c) => c.kind === 'subflow')!.id}`] ? '顯示的是本次 run 的快照與執行資料。' : ''}</div>
                        <button data-testid="open-source" style={{ marginTop: 4 }} onClick={() => void openSource()}>✎ 開啟來源 workflow 編輯</button>
                      </>
                    ) : (
                      <>
                        <b>{cur.composite.id} 的 body（{cur.composite.type}）</b>
                        {cur.composite.type === 'loop' && (
                          <span style={{ color: '#475569' }}>
                            {' '}· 最多 {String(cur.composite.config?.max_iterations ?? '?')} 輪
                            {(cur.composite.config?.until as { port?: string } | undefined)?.port ? ` · until ${(cur.composite.config!.until as { port: string }).port}` : ''}
                            {((cur.composite.config?.carry as { from: string; to: string }[] | undefined) ?? []).map((c) => ` · carry ${c.from} → ${c.to}`).join('')}
                          </span>
                        )}
                        <div style={{ color: '#475569' }}>紫色虛線框 = 邊界節點；port 後面的「← / →」是外層對應。可直接新增節點、連線、改屬性，存檔寫回同一份 JSON 的巢狀位置。</div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div style={{ borderTop: '1px solid #ddd', display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
            <Tabs tabs={[['diag', `Diagnostics${diag ? `（${diag.errors.length}/${diag.warnings.length}）` : ''}`], ['log', 'Log'], ['json', 'Workflow JSON']]} value={bottomTab} onChange={(t) => { setBottomTab(t); if (t === 'json') setJsonText(JSON.stringify(toFile(commit()), null, 2)); }} />
            <div style={{ overflow: 'auto', fontSize: 12, padding: bottomTab === 'json' ? 0 : 8, minHeight: 0 }}>
              {bottomTab === 'diag' && <DiagnosticsList diag={diag} onSelect={(id) => api.current?.select(id)} />}
              {bottomTab === 'log' && logs.map((l, i) => <div key={i} style={{ fontFamily: 'ui-monospace, monospace', color: l.level === 'error' ? '#b91c1c' : '#111', whiteSpace: 'pre-wrap' }}>{l.msg}</div>)}
              {bottomTab === 'json' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', height: '100%' }}>
                  <textarea data-testid="workflow-json" value={jsonText} onChange={(e) => setJsonText(e.target.value)} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, border: 0, padding: 8, resize: 'none' }} />
                  <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <button onClick={() => setJsonText(JSON.stringify(toFile(commit()), null, 2))}>重新整理</button>
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
                {advanced && mode === 'backend' && !running && ['failed', 'cancelled', 'interrupted'].includes(activeRun.status) && (
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
                    {[...run_.records.values()].filter((r) => r.scopeKey === scopeKeyOf(scope)).map((r) => (
                      <div key={r.key} style={{ display: 'flex', gap: 6, margin: '3px 0', cursor: 'pointer' }} onClick={() => api.current?.select(r.node_id)}>
                        <Badge status={r.status} /> <span>{r.node_id}</span> <span style={{ color: '#94a3b8' }}>{r.duration_ms !== undefined ? `${r.duration_ms} ms` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {selNode && selDef && rightTab === 'props' && (
              <>
                {readOnly && <div style={{ padding: '8px 12px', fontSize: 12, background: '#f5f3ff', color: '#5b21b6' }}>🔒 sub-workflow 唯讀：屬性僅供檢視</div>}
                <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                  <PropertiesPanel key={`${path.map((c) => c.id).join('/')}/${selNode.id}`} v1={v1View} node={selNode} def={selDefView!} registry={registry} ports={selPorts} errors={selErrors} connectedInputs={connected}
                    onChange={(n) => void updateNode(n)} onDelete={() => void deleteNode(selNode.id)}
                    onOpenBody={isDrillable(selNode) ? () => void drill(selNode.id) : undefined} />
                </fieldset>
                {readOnly && isDrillable(selNode) && <div style={{ padding: '0 12px 12px' }}><button onClick={() => void drill(selNode.id)}>進入子圖</button></div>}
              </>
            )}
            {selNode && rightTab === 'run' && (
              <NodeRunPanel run={run_} scope={scope} nodeId={selNode.id} def={selDef}
                onIteration={(i) => setPicks((p) => { const n = [...p]; n[path.length - 1] = i; picksRef.current = n; return n; })}
                onOpenIteration={isDrillable(selNode) ? (i) => void drill(selNode.id, i) : undefined} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
