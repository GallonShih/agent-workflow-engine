import { createRoot } from 'react-dom/client';
import { css } from 'styled-components';
import { ClassicPreset, NodeEditor, type GetSchemes } from 'rete';
import { AreaExtensions, AreaPlugin } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { Presets, ReactPlugin, type ReactArea2D } from 'rete-react-plugin';
import { AutoArrangePlugin, Presets as ArrangePresets } from 'rete-auto-arrange-plugin';
import { ControlSocket, TypedSocket, controlSocket } from '../../src/sockets.js';
import { resolveNodePorts, type LoopPorts } from '../../src/compiler.js';
import { typeLabel } from '../../src/schema.js';
import type { NodeRegistry } from '../../src/registry.js';
import type { Edge, NodeStatus, WorkflowGraph, WorkflowNode } from '../../src/types.js';

/**
 * Phase 1 前端：Rete editor（area + connection + react render + auto-arrange 全部是 Rete 官方 plugin）。
 * 自己寫的只有：WorkflowNode ⇄ Rete node 的轉換、typed socket 連線檢查 pipe、狀態上色。
 * Port key 加前綴避免 data / control 同名：d:<name> / c:<name>
 */
export class UINode extends ClassicPreset.Node {
  width = 260;
  height = 60;
  status?: NodeStatus;
  constructor(public wf: WorkflowNode, title: string) {
    super(title);
    this.id = wf.id;
  }
}
type Conn = ClassicPreset.Connection<UINode, UINode> & { kind?: 'data' | 'control' };
type Schemes = GetSchemes<UINode, Conn>;
type AreaExtra = ReactArea2D<Schemes>;

const STATUS_COLOR: Record<string, string> = {
  pending: '#9ca3af',
  running: '#3b82f6',
  success: '#16a34a',
  failed: '#dc2626',
  skipped: '#d1d5db',
};

function StatusNode(props: { data: UINode; emit: never; styles?: () => unknown }) {
  const s = props.data.status;
  const ClassicNode = Presets.classic.Node as unknown as (p: Record<string, unknown>) => JSX.Element;
  return (
    <ClassicNode
      {...(props as unknown as Record<string, unknown>)}
      styles={() => css`
        ${s ? `border: 4px solid ${STATUS_COLOR[s]};` : ''}
        ${s === 'skipped' ? 'opacity: .45;' : ''}
      `}
    />
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

export interface EditorApi {
  load(graph: WorkflowGraph, loop?: LoopPorts): Promise<void>;
  exportGraph(): WorkflowGraph;
  addNode(type: string): Promise<void>;
  setStatuses(map: Record<string, NodeStatus | undefined>): void;
  layout(): Promise<void>;
  destroy(): void;
}

export async function createEditor(container: HTMLElement, registry: NodeRegistry, log: (msg: string, level?: 'info' | 'error') => void): Promise<EditorApi> {
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, AreaExtra>(container);
  const connection = new ConnectionPlugin<Schemes, AreaExtra>();
  const render = new ReactPlugin<Schemes, AreaExtra>({ createRoot });
  const arrange = new AutoArrangePlugin<Schemes>();
  let loopPorts: LoopPorts | undefined;

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
    if (context.type === 'connectioncreate') {
      const c = context.data;
      const src = editor.getNode(c.source)?.outputs[c.sourceOutput]?.socket;
      const dst = editor.getNode(c.target)?.inputs[c.targetInput]?.socket;
      if (!src || !dst || !(src as TypedSocket | ControlSocket).isCompatibleWith(dst)) {
        log(`拒絕連線 ${c.source}.${String(c.sourceOutput).slice(2)} → ${c.target}.${String(c.targetInput).slice(2)}：型別或 edge kind 不相容（${src?.name} → ${dst?.name}）`, 'error');
        return;
      }
      c.kind = src instanceof ControlSocket ? 'control' : 'data';
    }
    return context;
  });

  function buildNode(wf: WorkflowNode): UINode {
    const def = registry.get(wf.type);
    if (!def) throw new Error(`unknown node type ${wf.type}`);
    const { inputs, outputs } = resolveNodePorts(wf, def, registry, loopPorts);
    const node = new UINode(wf, `${wf.label ?? wf.id}  ·  ${wf.type}`);
    for (const c of def.control_inputs) node.addInput(`c:${c}`, new ClassicPreset.Input(controlSocket, `▶ ${c}`, true));
    for (const [k, p] of Object.entries(inputs)) {
      const req = p.required !== false && p.default === undefined && !(wf.inputs && k in wf.inputs) ? '*' : '';
      node.addInput(`d:${k}`, new ClassicPreset.Input(new TypedSocket(p.schema), `${k}${req}: ${typeLabel(p.schema)}`, !!p.multiple));
    }
    for (const c of def.control_outputs) node.addOutput(`c:${c}`, new ClassicPreset.Output(controlSocket, `${c} ▶`));
    for (const [k, p] of Object.entries(outputs)) node.addOutput(`d:${k}`, new ClassicPreset.Output(new TypedSocket(p.schema), `${k}: ${typeLabel(p.schema)}`));
    const rows = Object.keys(node.inputs).length + Object.keys(node.outputs).length;
    node.height = 90 + rows * 44;
    return node;
  }

  async function clear() {
    for (const c of editor.getConnections()) await editor.removeConnection(c.id);
    for (const n of editor.getNodes()) await editor.removeNode(n.id);
  }

  const api: EditorApi = {
    async load(graph, loop) {
      loopPorts = loop;
      await clear();
      for (const wf of graph.nodes) await editor.addNode(buildNode(wf));
      for (const e of graph.edges) {
        const p = e.kind === 'control' ? 'c:' : 'd:';
        const s = editor.getNode(e.from.node);
        const t = editor.getNode(e.to.node);
        if (!s || !t || !s.outputs[p + e.from.port] || !t.inputs[p + e.to.port]) {
          log(`略過無法顯示的 edge ${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`, 'error');
          continue;
        }
        const conn = new ClassicPreset.Connection(s, p + e.from.port, t, p + e.to.port) as Conn;
        conn.kind = e.kind;
        await editor.addConnection(conn);
      }
      if (graph.nodes.every((n) => n.ui)) {
        for (const n of graph.nodes) await area.translate(n.id, n.ui!);
      } else await arrange.layout();
      AreaExtensions.zoomAt(area, editor.getNodes());
    },
    exportGraph() {
      const nodes = editor.getNodes().map((n) => {
        const pos = area.nodeViews.get(n.id)?.position;
        return { ...n.wf, ui: pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : undefined };
      });
      const edges: Edge[] = editor.getConnections().map((c) => ({
        kind: String(c.sourceOutput).startsWith('c:') ? 'control' : 'data',
        from: { node: c.source, port: String(c.sourceOutput).slice(2) },
        to: { node: c.target, port: String(c.targetInput).slice(2) },
      }));
      return { nodes, edges };
    },
    async addNode(type) {
      const def = registry.get(type);
      if (!def) return;
      let i = 1;
      while (editor.getNode(`${type}_${i}`)) i++;
      const wf: WorkflowNode = { id: `${type}_${i}`, type };
      if (type === 'condition') wf.config = { rule: { op: 'truthy' } };
      if (type === 'join') wf.config = { policy: 'all' };
      if (type === 'end') wf.config = { status: 'success' };
      await editor.addNode(buildNode(wf));
      log(`新增節點 ${wf.id}（${def.description ?? type}）`);
    },
    setStatuses(map) {
      for (const n of editor.getNodes()) {
        n.status = map[n.id];
        void area.update('node', n.id);
      }
    },
    async layout() {
      await arrange.layout();
      AreaExtensions.zoomAt(area, editor.getNodes());
    },
    destroy() {
      area.destroy();
    },
  };
  return api;
}
