import { createRoot } from 'react-dom/client';
import { css, StyleSheetManager } from 'styled-components';
import { ClassicPreset, NodeEditor, type GetSchemes } from 'rete';
import { AreaExtensions, AreaPlugin } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { Presets, ReactPlugin, type ReactArea2D } from 'rete-react-plugin';
import { AutoArrangePlugin, Presets as ArrangePresets } from 'rete-auto-arrange-plugin';
import { ControlSocket, TypedSocket, controlSocket } from '../../src/sockets.js';
import { resolveNodePorts, type BodyPorts } from '../../src/compiler.js';
import { typeLabel } from '../../src/schema.js';
import type { NodeRegistry } from '../../src/registry.js';
import type { Edge, NodeStatus, WorkflowGraph, WorkflowNode } from '../../src/types.js';

/**
 * Rete editor（area + connection + react render + auto-arrange 都是 Rete 官方 plugin）。
 * 自己寫的只有：WorkflowNode ⇄ Rete node 轉換（ports 由 compiler 的 resolveNodePorts 產生，前後端一致）、
 * typed socket 連線檢查、狀態上色、錯誤徽章、選取事件。
 * Port key 加前綴避免 data / control 同名：d:<name> / c:<name>
 */
export class UINode extends ClassicPreset.Node {
  width = 270;
  height = 60;
  status?: NodeStatus;
  errors = 0;
  picked = false;
  /** 邊界節點（loop_in / loop_out / 子流程的 start / end）：畫成不同底色，port 標籤附上外層對應 */
  boundary?: string;
  constructor(public wf: WorkflowNode, title: string) {
    super(title);
    this.id = wf.id;
  }
}
type Conn = ClassicPreset.Connection<UINode, UINode> & { kind?: 'data' | 'control' };
type Schemes = GetSchemes<UINode, Conn>;
type AreaExtra = ReactArea2D<Schemes>;

export const STATUS_COLOR: Record<string, string> = {
  pending: '#9ca3af',
  running: '#3b82f6',
  success: '#16a34a',
  failed: '#dc2626',
  skipped: '#cbd5e1',
};

/**
 * styled-components v6 預設會把未知 prop 轉給 DOM；classic preset 的 `styles` 是函式 prop，
 * 會被轉到 <div> 上而觸發 React 警告。這裡只擋掉 `styles`（其餘照舊）。
 */
const shouldForwardProp = (prop: string, target: unknown) => typeof target !== 'string' || prop !== 'styles';

function StatusNode(props: { data: UINode; emit: never; styles?: () => unknown }) {
  const n = props.data;
  const s = n.status;
  const ClassicNode = Presets.classic.Node as unknown as (p: Record<string, unknown>) => JSX.Element;
  return (
    <div style={{ position: 'relative' }} data-node-id={n.id} data-status={s ?? ''}>
      {n.errors > 0 && (
        <div title={`${n.errors} 個驗證錯誤`} style={{ position: 'absolute', top: -10, right: -10, zIndex: 2, background: '#dc2626', color: '#fff', borderRadius: 12, minWidth: 22, height: 22, fontSize: 12, fontWeight: 700, display: 'grid', placeItems: 'center', border: '2px solid #fff' }}>
          {n.errors}
        </div>
      )}
      {s && (
        <div style={{ position: 'absolute', top: -11, left: 10, zIndex: 2, background: STATUS_COLOR[s], color: s === 'skipped' ? '#334155' : '#fff', borderRadius: 8, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
          {s}
        </div>
      )}
      {n.boundary && (
        <div style={{ position: 'absolute', top: -11, right: 14, zIndex: 2, background: '#7c3aed', color: '#fff', borderRadius: 8, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
          {n.boundary}
        </div>
      )}
      <StyleSheetManager shouldForwardProp={shouldForwardProp}>
      <ClassicNode
        {...(props as unknown as Record<string, unknown>)}
        styles={() => css`
          ${n.boundary ? 'background: #4c1d95; border-style: dashed;' : ''}
          ${n.picked ? 'box-shadow: 0 0 0 4px #fde047;' : ''}
          ${s ? `border: 4px solid ${STATUS_COLOR[s]};` : n.errors ? 'border: 3px solid #dc2626;' : ''}
          ${s === 'skipped' ? 'opacity: .5;' : ''}
          ${s === 'running' ? 'animation: pulse 1s infinite;' : ''}
        `}
      />
      </StyleSheetManager>
    </div>
  );
}

function SocketView(props: { data: ClassicPreset.Socket }) {
  const control = props.data instanceof ControlSocket;
  return (
    <div
      title={props.data.name}
      style={{
        width: 18, height: 18, margin: 6, cursor: 'pointer', display: 'inline-block',
        borderRadius: control ? 3 : 9, background: control ? '#f59e0b' : '#3b82f6', border: '2px solid #fff',
        transform: control ? 'rotate(45deg) scale(.8)' : undefined,
      }}
    />
  );
}

function ConnectionView(props: { data: Conn }) {
  const { path } = Presets.classic.useConnection();
  if (!path) return null;
  const control = props.data.kind === 'control';
  return (
    <svg style={{ overflow: 'visible', position: 'absolute', pointerEvents: 'none', width: 9999, height: 9999 }}>
      <path d={path} fill="none" stroke={control ? '#f59e0b' : '#3b82f6'} strokeWidth={control ? 3 : 4}
        strokeDasharray={control ? '10 6' : undefined} style={{ pointerEvents: 'auto' }} />
    </svg>
  );
}

export interface LoadOptions {
  /** 目前 body 的 loop_in / loop_out ports */
  body?: BodyPorts;
  /** 唯讀（subflow drill-in）：禁止新增 / 刪除連線與節點 */
  readOnly?: boolean;
  /** 邊界節點 port 註解：{ nodeId: { 'd:port': '← planner.tasks' } } */
  annotations?: Record<string, Record<string, string>>;
  /** 邊界節點的徽章文字：{ nodeId: '輸入邊界' } */
  boundaries?: Record<string, string>;
}

export interface EditorApi {
  load(graph: WorkflowGraph, opts?: LoadOptions): Promise<void>;
  exportGraph(): WorkflowGraph;
  addNode(type: string): Promise<WorkflowNode | undefined>;
  /** 屬性面板改了 label / config / ports：重建該節點的 ports，保留位置與仍有效的連線 */
  updateNode(wf: WorkflowNode): Promise<void>;
  removeNode(id: string): Promise<void>;
  select(id: string | null): void;
  setStatuses(map: Record<string, NodeStatus | undefined>): void;
  setErrors(map: Record<string, number>): void;
  layout(): Promise<void>;
  zoomToFit(): void;
  destroy(): void;
}

export interface EditorEvents {
  log: (msg: string, level?: 'info' | 'error') => void;
  onSelect: (id: string | null) => void;
  /** 圖結構變了（連線新增 / 刪除、節點新增 / 刪除）→ 重新驗證 */
  onChange: () => void;
  /** 雙擊節點（loop / foreach / subflow → drill-in） */
  onOpen?: (id: string) => void;
}

export async function createEditor(container: HTMLElement, registry: NodeRegistry, ev: EditorEvents): Promise<EditorApi> {
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, AreaExtra>(container);
  const connection = new ConnectionPlugin<Schemes, AreaExtra>();
  const render = new ReactPlugin<Schemes, AreaExtra>({ createRoot });
  const arrange = new AutoArrangePlugin<Schemes>();
  let bodyPorts: BodyPorts | undefined;
  let opts: LoadOptions = {};
  let loading = false;
  let selected: string | null = null;

  AreaExtensions.selectableNodes(area, AreaExtensions.selector(), { accumulating: AreaExtensions.accumulateOnCtrl() });
  render.addPreset(
    Presets.classic.setup({
      customize: {
        node: () => StatusNode as never,
        socket: () => SocketView as never,
        connection: () => ConnectionView as never,
      },
    }),
  );
  connection.addPreset(ConnectionPresets.classic.setup());
  arrange.addPreset(ArrangePresets.classic.setup());
  editor.use(area);
  area.use(connection);
  area.use(render);
  area.use(arrange);
  AreaExtensions.simpleNodesOrder(area);

  // 連線檢查：與後端 compiler 共用 TypedSocket.isCompatibleWith（JSON Schema 結構相容）
  editor.addPipe((context) => {
    if (opts.readOnly && !loading && ['connectioncreate', 'connectionremove', 'noderemove', 'nodecreate'].includes(context.type)) {
      if (context.type === 'connectioncreate') ev.log('唯讀畫面（sub-workflow）：不能修改。請按「開啟來源 workflow 編輯」。', 'error');
      return;
    }
    if (context.type === 'connectioncreate') {
      const c = context.data;
      const src = editor.getNode(c.source)?.outputs[c.sourceOutput]?.socket;
      const dst = editor.getNode(c.target)?.inputs[c.targetInput]?.socket;
      if (!src || !dst || !(src as TypedSocket | ControlSocket).isCompatibleWith(dst)) {
        ev.log(`拒絕連線 ${c.source}.${String(c.sourceOutput).slice(2)} → ${c.target}.${String(c.targetInput).slice(2)}：型別或 edge kind 不相容（${src?.name} → ${dst?.name}）`, 'error');
        return;
      }
      c.kind = src instanceof ControlSocket ? 'control' : 'data';
    }
    if (!loading && ['connectioncreated', 'connectionremoved', 'nodecreated', 'noderemoved'].includes(context.type)) queueMicrotask(ev.onChange);
    return context;
  });

  // 雙擊偵測：節點被 pick 時 simpleNodesOrder 會把 DOM 移到最上層，瀏覽器原生 dblclick 因此不會觸發，
  // 改成「同一節點 350ms 內被 pick 兩次」= 雙擊（用來 drill-in）
  let lastPick = { id: '', t: 0 };
  area.addPipe((context) => {
    if (context.type === 'nodepicked') {
      const id = context.data.id;
      const now = performance.now();
      if (lastPick.id === id && now - lastPick.t < 350) {
        lastPick = { id: '', t: 0 };
        queueMicrotask(() => ev.onOpen?.(id));
      } else lastPick = { id, t: now };
      api.select(id);
    }
    // 不要讓 area 預設的「雙擊放大」干擾
    if (context.type === 'zoom' && context.data.source === 'dblclick') return;
    return context;
  });
  container.addEventListener('pointerdown', (e) => {
    if (e.target === container) api.select(null);
  });

  function buildNode(wf: WorkflowNode): UINode {
    const def = registry.get(wf.type);
    if (!def) throw new Error(`unknown node type ${wf.type}`);
    let ports;
    try {
      ports = resolveNodePorts(wf, def, registry, bodyPorts);
    } catch (e) {
      ev.log(`${wf.id}: ${(e as Error).message}`, 'error');
      ports = { inputs: def.inputs, outputs: def.outputs, controlInputs: def.control_inputs, controlOutputs: def.control_outputs };
    }
    const drill = ['loop', 'foreach', 'subflow'].includes(wf.type) ? '  ⤵' : '';
    const node = new UINode(wf, `${wf.label || wf.id}  ·  ${wf.type}${drill}`);
    const ann = opts.annotations?.[wf.id] ?? {};
    const note = (k: string) => (ann[k] ? `  ${ann[k]}` : '');
    node.boundary = opts.boundaries?.[wf.id];
    for (const c of ports.controlInputs) node.addInput(`c:${c}`, new ClassicPreset.Input(controlSocket, `▶ ${c}`, true));
    for (const [k, p] of Object.entries(ports.inputs)) {
      const req = p.required !== false && p.default === undefined && !(wf.inputs && k in wf.inputs) ? '*' : '';
      node.addInput(`d:${k}`, new ClassicPreset.Input(new TypedSocket(p.schema), `${k}${req}: ${typeLabel(p.schema)}${note(`d:${k}`)}`, !!p.multiple));
    }
    for (const c of ports.controlOutputs) node.addOutput(`c:${c}`, new ClassicPreset.Output(controlSocket, `${c} ▶`));
    for (const [k, p] of Object.entries(ports.outputs)) node.addOutput(`d:${k}`, new ClassicPreset.Output(new TypedSocket(p.schema), `${k}: ${typeLabel(p.schema)}${note(`d:${k}`)}`));
    const rows = Object.keys(node.inputs).length + Object.keys(node.outputs).length;
    node.height = 90 + rows * 44;
    if (Object.keys(ann).length) node.width = 420;
    return node;
  }

  async function addConn(e: Edge) {
    const p = e.kind === 'control' ? 'c:' : 'd:';
    const s = editor.getNode(e.from.node);
    const t = editor.getNode(e.to.node);
    if (!s || !t || !s.outputs[p + e.from.port] || !t.inputs[p + e.to.port]) return false;
    const conn = new ClassicPreset.Connection(s, p + e.from.port, t, p + e.to.port) as Conn;
    conn.kind = e.kind;
    await editor.addConnection(conn);
    return true;
  }

  async function clear() {
    for (const c of editor.getConnections()) await editor.removeConnection(c.id);
    for (const n of editor.getNodes()) await editor.removeNode(n.id);
  }

  function exportEdges(): Edge[] {
    return editor.getConnections().map((c) => ({
      kind: String(c.sourceOutput).startsWith('c:') ? 'control' : 'data',
      from: { node: c.source, port: String(c.sourceOutput).slice(2) },
      to: { node: c.target, port: String(c.targetInput).slice(2) },
    }));
  }

  const api: EditorApi = {
    async load(graph, o = {}) {
      loading = true;
      try {
        opts = o;
        bodyPorts = o.body;
        selected = null;
        await clear();
        for (const wf of graph.nodes) await editor.addNode(buildNode(wf));
        for (const e of graph.edges) if (!(await addConn(e))) ev.log(`略過無法顯示的 edge ${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`, 'error');
        if (graph.nodes.length && graph.nodes.every((n) => n.ui)) {
          for (const n of graph.nodes) await area.translate(n.id, n.ui!);
        } else if (graph.nodes.length) await arrange.layout();
        AreaExtensions.zoomAt(area, editor.getNodes());
      } finally {
        loading = false;
      }
    },
    exportGraph() {
      const nodes = editor.getNodes().map((n) => {
        const pos = area.nodeViews.get(n.id)?.position;
        return { ...n.wf, ui: pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : n.wf.ui };
      });
      return { nodes, edges: exportEdges() };
    },
    async addNode(type) {
      if (opts.readOnly) return;
      const def = registry.get(type);
      if (!def) return;
      let i = 1;
      while (editor.getNode(`${type}_${i}`)) i++;
      const wf: WorkflowNode = { id: `${type}_${i}`, type, ...defaultsFor(type) };
      // 放在目前畫面中央
      const k = area.area.transform.k;
      const rect = container.getBoundingClientRect();
      wf.ui = { x: Math.round((rect.width / 2 - area.area.transform.x) / k - 135), y: Math.round((rect.height / 2 - area.area.transform.y) / k - 80) };
      await editor.addNode(buildNode(wf));
      await area.translate(wf.id, wf.ui);
      ev.log(`新增節點 ${wf.id}（${def.description ?? type}）`);
      api.select(wf.id);
      return wf;
    },
    async updateNode(wf) {
      const old = editor.getNode(wf.id);
      if (!old) return;
      loading = true;
      try {
        const pos = area.nodeViews.get(wf.id)?.position;
        const edges = exportEdges().filter((e) => e.from.node === wf.id || e.to.node === wf.id);
        for (const c of editor.getConnections().filter((c) => c.source === wf.id || c.target === wf.id)) await editor.removeConnection(c.id);
        await editor.removeNode(wf.id);
        const node = buildNode(wf);
        node.status = old.status;
        node.errors = old.errors;
        node.picked = old.picked;
        await editor.addNode(node);
        if (pos) await area.translate(wf.id, pos);
        const dropped: string[] = [];
        for (const e of edges) if (!(await addConn(e))) dropped.push(`${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`);
        if (dropped.length) ev.log(`ports 變更後移除了 ${dropped.length} 條連線：${dropped.join('、')}`, 'error');
      } finally {
        loading = false;
      }
      ev.onChange();
    },
    async removeNode(id) {
      for (const c of editor.getConnections().filter((c) => c.source === id || c.target === id)) await editor.removeConnection(c.id);
      await editor.removeNode(id);
      if (selected === id) api.select(null);
    },
    select(id) {
      if (selected === id) return;
      for (const n of editor.getNodes()) {
        const p = n.id === id;
        if (n.picked !== p) {
          n.picked = p;
          void area.update('node', n.id);
        }
      }
      selected = id;
      ev.onSelect(id);
    },
    setStatuses(map) {
      for (const n of editor.getNodes()) {
        if (n.status === map[n.id]) continue;
        n.status = map[n.id];
        void area.update('node', n.id);
      }
    },
    setErrors(map) {
      for (const n of editor.getNodes()) {
        const c = map[n.id] ?? 0;
        if (n.errors === c) continue;
        n.errors = c;
        void area.update('node', n.id);
      }
    },
    async layout() {
      await arrange.layout();
      AreaExtensions.zoomAt(area, editor.getNodes());
    },
    zoomToFit() {
      void AreaExtensions.zoomAt(area, editor.getNodes());
    },
    destroy() {
      area.destroy();
    },
  };
  return api;
}

/** 新節點的預設 config / ports（讓剛拖進來的節點就是合法的） */
export function defaultsFor(type: string): Partial<WorkflowNode> {
  switch (type) {
    case 'condition': return { config: { rule: { op: 'truthy' } } };
    case 'join': return { config: { policy: 'all' } };
    case 'end': return { config: { status: 'success' }, ports: { inputs: {} } };
    case 'start': return { ports: { outputs: { request: { type: 'string' } } } };
    case 'switch': return { config: { cases: [{ name: 'case_1', rule: { op: 'eq', value: 'a' } }], match: 'first' } };
    case 'merge': return { config: { inputs: 2, mode: 'first' } };
    case 'transform': return { config: { expression: '$', timeout_ms: 1000 } };
    case 'filter': return { config: { rule: { op: 'truthy' } } };
    case 'template': return { config: { template: 'Hello {{inputs.name}}' }, ports: { inputs: { name: { type: 'string' } } } };
    case 'set': return { config: { values: { value: 'hello' } }, ports: { outputs: { value: { type: 'string' } } } };
    case 'delay': return { config: { ms: 500 } };
    case 'log': return { config: { level: 'info' } };
    case 'http_request': return { config: { method: 'GET', url: 'https://httpbin.org/json', timeout_ms: 10000, response_type: 'auto' } };
    case 'json_parse': return { config: { extract_code_block: true } };
    case 'schema_validate': return { config: { schema: { type: 'object' } } };
    case 'file_read': return { config: { path: 'notes.txt', format: 'text' } };
    case 'file_write': return { config: { path: 'out.txt', format: 'text', mode: 'overwrite' } };
    case 'loop': return { config: { max_iterations: 3 }, ports: { inputs: {}, outputs: { done: { type: 'boolean' } } }, body: { nodes: [{ id: 'loop_in', type: 'loop_in' }, { id: 'loop_out', type: 'loop_out' }], edges: [{ kind: 'control', from: { node: 'loop_in', port: 'success' }, to: { node: 'loop_out', port: 'execute' } }] } };
    case 'foreach': return { config: { max_items: 100, on_item_failure: 'fail' }, ports: { inputs: { items: { type: 'array' } }, outputs: {} }, body: { nodes: [{ id: 'loop_in', type: 'loop_in' }, { id: 'loop_out', type: 'loop_out' }], edges: [{ kind: 'control', from: { node: 'loop_in', port: 'success' }, to: { node: 'loop_out', port: 'execute' } }] } };
    case 'subflow': return { config: { workflow: 'fix-until-tests-pass' }, ports: { inputs: {}, outputs: {} } };
    default: return {};
  }
}
