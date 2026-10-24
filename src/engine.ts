import { ClassicPreset, NodeEditor, type GetSchemes } from 'rete';
import { DataflowEngine, ControlFlowEngine } from 'rete-engine';
import type { CompiledGraph, CompiledNode } from './compiler.js';
import { compileWorkflow, evalRule } from './compiler.js';
import { builtins } from './nodes/builtins.js';
import type { RunServices } from './services.js';
import { ControlSocket, TypedSocket, controlSocket } from './sockets.js';
import { validateValue } from './schema.js';
import { interpolateReferences } from './vendor/circuit/orchestrator/references.js';
import type { AgentEvent, AgentConfig, LoopConfig, NodeRunRecord, NodeStatus, Rule, RunEvent, RunResult, Scope, TokenUsage } from './types.js';
import type { AgentRuntime } from './runtime/types.js';

/**
 * Hybrid Workflow Runtime（Phase 2）
 * - 圖的處理直接用 rete + rete-engine：每個 graph scope 建一個 headless NodeEditor，
 *   DataflowEngine 只看 data ports、ControlFlowEngine 只看 control ports（Rete 官方 Hybrid Engine 作法）。
 * - 這層 glue 只補 Rete 沒有的 workflow 語意：
 *   1. data edge 不觸發；被 control 觸發後，等上游 data 生產者 settle 才執行（多輸入 readiness）
 *   2. 狀態 pending/running/success/failed/skipped，未走的分支做 dead-path 傳播（skipped）
 *   3. Join（all/any）
 *   4. Loop composite：每一輪用全新的 editor/engine + iteration scope（不會讀到上一輪資料）
 *   5. Agent retry / timeout、Ajv 驗證 port 值、事件流與 token/duration 紀錄
 */

class RuntimeNode extends ClassicPreset.Node {
  constructor(public cn: CompiledNode, public graph: GraphRun) {
    super(cn.node.label ?? cn.id);
    this.id = cn.id; // 讓 Rete node id = workflow node id
    for (const [k, p] of Object.entries(cn.inputs)) this.addInput(k, new ClassicPreset.Input(new TypedSocket(p.schema), k, !!p.multiple));
    for (const [k, p] of Object.entries(cn.outputs)) this.addOutput(k, new ClassicPreset.Output(new TypedSocket(p.schema), k));
    for (const k of cn.controlInputs) this.addInput(k, new ClassicPreset.Input(controlSocket, k, true));
    for (const k of cn.controlOutputs) this.addOutput(k, new ClassicPreset.Output(controlSocket, k));
  }
  /** DataflowEngine 呼叫 */
  data(inputs: Record<string, unknown[]>): Promise<Record<string, unknown>> | Record<string, unknown> {
    return this.graph.nodeData(this, inputs);
  }
  /** ControlFlowEngine 呼叫 */
  execute(input: string, forward: (output: string) => void): void {
    this.graph.onTrigger(this, input, forward);
  }
}

type Conn = ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>;
type Schemes = GetSchemes<RuntimeNode, Conn>;

interface NodeState {
  status: NodeStatus;
  triggered: boolean;
  outputs?: Record<string, unknown>;
  settled: Promise<void>;
  resolve: () => void;
}

export interface RunOptions {
  runtime: AgentRuntime;
  /** 依 node definition 選 runtime（例如 claude_agent_sdk 但沒有 API key → mock） */
  selectRuntime?: (def: CompiledNode['def']) => AgentRuntime;
  runId?: string;
  workingDirectory?: string;
  onEvent?: (e: RunEvent) => void;
  /** 有副作用節點用的外部服務（fetch / 沙盒 fs / 載入子 workflow） */
  services?: RunServices;
  /**
   * Resume：先前 run 已成功的 agent 節點結果，key = scopeKey/node_id（例如 fix_loop#1/coder）。
   * 命中的 agent 不再呼叫 runtime，直接沿用輸出（builtin 節點一律重新執行，便宜且無外部成本）。
   */
  resume?: { fromRunId: string; results: Map<string, { outputs: Record<string, unknown>; fired: string[] }> };
  /** 外部取消（例如 server 收到 cancel） */
  signal?: AbortSignal;
}

export class RunContext {
  runId: string;
  records = new Map<string, NodeRunRecord>();
  history: NodeRunRecord[] = [];
  events: RunEvent[] = [];
  seq = 0;
  constructor(public opts: RunOptions) {
    this.runId = opts.runId ?? `run_${Date.now().toString(36)}`;
  }
  emitEvent(type: RunEvent['type'], extra: Omit<Partial<RunEvent>, 'seq' | 'ts' | 'run_id' | 'type'> = {}) {
    const e: RunEvent = { seq: ++this.seq, ts: Date.now(), run_id: this.runId, type, ...extra };
    this.events.push(e);
    this.opts.onEvent?.(e);
  }
}

export function scopeKey(scope: Scope): string {
  return scope.length ? scope.map((s) => `${s.loop}#${s.iteration}`).join('/') : 'root';
}

export class GraphRun {
  editor = new NodeEditor<Schemes>();
  dataflow = new DataflowEngine<Schemes>((n) => ({ inputs: () => Object.keys(n.cn.inputs), outputs: () => Object.keys(n.cn.outputs) }));
  control = new ControlFlowEngine<Schemes>((n) => ({ inputs: () => n.cn.controlInputs, outputs: () => n.cn.controlOutputs }));
  states = new Map<string, NodeState>();
  edgeState = new Map<string, 'pending' | 'fired' | 'dead'>();
  inflight = 0;
  idle!: () => void;
  endStatus?: 'success' | 'failed';
  loopOutputs?: Record<string, unknown>;
  endOutputs?: Record<string, unknown>;
  unhandledFailures: string[] = [];

  constructor(public graph: CompiledGraph, public scope: Scope, public ctx: RunContext, public entryValues: Record<string, unknown>) {
    this.editor.use(this.dataflow);
    this.editor.use(this.control);
  }

  key(nodeId: string) {
    return `${this.ctx.runId}/${scopeKey(this.scope)}/${nodeId}`;
  }

  async run(): Promise<void> {
    const nodes = new Map<string, RuntimeNode>();
    for (const cn of this.graph.nodes.values()) {
      const n = new RuntimeNode(cn, this);
      nodes.set(cn.id, n);
      let resolve!: () => void;
      const settled = new Promise<void>((r) => (resolve = r));
      this.states.set(cn.id, { status: 'pending', triggered: false, settled, resolve });
      this.record(cn.id, { status: 'pending' });
      await this.editor.addNode(n);
    }
    for (const e of this.graph.edges) {
      const c = new ClassicPreset.Connection(nodes.get(e.from.node)!, e.from.port, nodes.get(e.to.node)!, e.to.port) as Conn;
      await this.editor.addConnection(c);
      if (e.kind === 'control') this.edgeState.set(c.id, 'pending');
    }
    const done = new Promise<void>((r) => (this.idle = r));
    // 入口：control 節點且沒有 incoming control edge（start / loop_in / 其他 entry）
    const entries = [...this.graph.nodes.values()].filter(
      (cn) => cn.def.mode === 'control' && !this.graph.edges.some((e) => e.kind === 'control' && e.to.node === cn.id),
    );
    this.inflight++; // 保護：entry 全部送出前不算 idle
    for (const cn of entries) this.control.execute(cn.id);
    this.release();
    await done;
    for (const [id, st] of this.states) if (st.status === 'pending') this.skip(id, 'never triggered');
  }

  private release() {
    if (--this.inflight === 0) this.idle();
  }

  private controlConns(filter: (c: Conn) => boolean): Conn[] {
    return this.editor.getConnections().filter((c) => this.edgeState.has(c.id) && filter(c));
  }

  // ------------------------------------------------------------------ control
  onTrigger(node: RuntimeNode, _input: string, forward: (o: string) => void) {
    const st = this.states.get(node.id)!;
    if (st.triggered || st.status !== 'pending') return;
    if (node.cn.def.name === 'join') {
      const incoming = this.controlConns((c) => c.target === node.id).map((c) => this.edgeState.get(c.id));
      const policy = (node.cn.node.config?.policy as string) ?? 'all';
      if (policy === 'all' && incoming.some((s) => s !== 'fired')) return; // 等其他分支
    }
    st.triggered = true;
    this.ctx.emitEvent('node_triggered', { node_id: node.id, key: this.key(node.id), scope: this.scope });
    this.inflight++;
    this.executeNode(node, forward).finally(() => this.release());
  }

  /** 沒被選中的 control output → dead；目標節點所有 incoming control 都 dead → skipped（往下游傳播） */
  private markDead(nodeId: string, output: string) {
    for (const c of this.controlConns((c) => c.source === nodeId && c.sourceOutput === output)) {
      this.edgeState.set(c.id, 'dead');
      const target = this.states.get(c.target)!;
      if (target.triggered || target.status !== 'pending') continue;
      const incoming = this.controlConns((x) => x.target === c.target).map((x) => this.edgeState.get(x.id));
      const isJoinAll = this.graph.nodes.get(c.target)!.def.name === 'join' && ((this.graph.nodes.get(c.target)!.node.config?.policy as string) ?? 'all') === 'all';
      if (incoming.every((s) => s === 'dead') || isJoinAll) this.skip(c.target, isJoinAll ? 'join(all): a branch was not taken' : 'all incoming control edges dead');
    }
  }

  private skip(nodeId: string, reason: string) {
    const st = this.states.get(nodeId)!;
    if (st.status !== 'pending') return;
    st.status = 'skipped';
    this.record(nodeId, { status: 'skipped', error: undefined });
    this.ctx.emitEvent('node_skipped', { node_id: nodeId, key: this.key(nodeId), scope: this.scope, data: { reason } });
    st.resolve();
    for (const out of this.graph.nodes.get(nodeId)!.controlOutputs) this.markDead(nodeId, out);
  }

  // ------------------------------------------------------------------ data
  /** 上游 control 節點（穿過純 data 節點）— 這些要先 settle 才能讀資料 */
  private producers(nodeId: string, seen = new Set<string>()): string[] {
    const res: string[] = [];
    for (const e of this.graph.edges) {
      if (e.kind !== 'data' || e.to.node !== nodeId || seen.has(e.from.node)) continue;
      seen.add(e.from.node);
      const src = this.graph.nodes.get(e.from.node)!;
      if (src.def.mode === 'data') res.push(...this.producers(src.id, seen));
      else res.push(src.id);
    }
    return res;
  }

  async nodeData(node: RuntimeNode, rawInputs: Record<string, unknown[]>): Promise<Record<string, unknown>> {
    const keys = Object.keys(node.cn.outputs);
    if (node.cn.def.mode === 'control') {
      // control 節點對 dataflow 而言只是「已存好的輸出」
      const out = this.states.get(node.id)!.outputs ?? {};
      return Object.fromEntries(keys.map((k) => [k, out[k]]));
    }
    // 純 data 節點（lazy pull）
    const inputs = this.flattenInputs(node.cn, rawInputs);
    const started = Date.now();
    const st = this.states.get(node.id)!;
    const spec = builtins[node.cn.def.name];
    try {
      if (!spec?.compute) throw new Error(`no compute for data node type ${node.cn.def.name}`);
      const outputs = await spec.compute({ cn: node.cn, cfg: node.cn.node.config ?? {}, inputs });
      st.status = 'success';
      st.outputs = outputs;
      this.record(node.id, { status: 'success', inputs, outputs, duration_ms: Date.now() - started });
      this.ctx.emitEvent('node_succeeded', { node_id: node.id, key: this.key(node.id), scope: this.scope, data: { inputs, outputs, fired: [], duration_ms: Date.now() - started, lazy: true } });
      return Object.fromEntries(keys.map((k) => [k, outputs[k]]));
    } catch (e) {
      st.status = 'failed';
      this.record(node.id, { status: 'failed', inputs, error: (e as Error).message, duration_ms: Date.now() - started });
      this.ctx.emitEvent('node_failed', { node_id: node.id, key: this.key(node.id), scope: this.scope, data: { error: (e as Error).message, handled: false } });
      throw e;
    } finally {
      st.resolve();
    }
  }

  private flattenInputs(cn: CompiledNode, raw: Record<string, unknown[]>): Record<string, unknown> {
    const res: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(cn.inputs)) {
      const vals = (raw[k] ?? []).filter((v) => v !== undefined);
      let v: unknown = p.multiple ? (vals.length ? vals : undefined) : vals[0];
      if (v === undefined) v = cn.node.inputs?.[k];
      if (v === undefined) v = p.default;
      if (v !== undefined) res[k] = v;
    }
    return res;
  }

  // ------------------------------------------------------------------ execute
  private async executeNode(node: RuntimeNode, forward: (o: string) => void) {
    const cn = node.cn;
    const st = this.states.get(node.id)!;
    const key = this.key(node.id);
    // 1) 等上游資料生產者 settle（data edge 不觸發，但會擋住執行直到資料就緒）
    //    不呼叫 dataflow.reset()：reset 會 cancel 其他平行節點正在 fetch 的 promise；
    //    因為一定先等 producer settle 才 fetch，cache 不會存到舊值；每一輪 loop 又是全新的 engine。
    let fire: string[] = [];
    let started = Date.now();
    try {
      await Promise.all(this.producers(node.id).map((p) => this.states.get(p)!.settled));
      const inputs = this.flattenInputs(cn, (await this.dataflow.fetchInputs(node.id)) as Record<string, unknown[]>);
      st.status = 'running';
      started = Date.now();
      this.record(node.id, { status: 'running', inputs, started_at: started });
      this.ctx.emitEvent('node_started', { node_id: node.id, key, scope: this.scope, data: { inputs } });
      for (const [k, p] of Object.entries(cn.inputs)) {
        if (inputs[k] === undefined) {
          if (p.required !== false) throw new Error(`required input "${k}" has no value (upstream skipped or failed?)`);
          continue;
        }
        const v = validateValue(p.schema, inputs[k]);
        if (!v.ok) throw new Error(`input "${k}" failed schema validation: ${v.errors}`);
      }
      const res = await this.behavior(node, inputs);
      for (const [k, p] of Object.entries(cn.outputs)) {
        if (res.outputs[k] === undefined && p.required === false) continue;
        const v = validateValue(p.schema, res.outputs[k]);
        if (!v.ok) throw new Error(`output "${k}" failed schema validation: ${v.errors}`);
      }
      st.outputs = res.outputs;
      st.status = 'success';
      fire = res.fire;
      this.record(node.id, { status: 'success', outputs: res.outputs, fired: fire, duration_ms: Date.now() - started, ...res.record });
      this.ctx.emitEvent('node_succeeded', {
        node_id: node.id, key, scope: this.scope,
        data: { outputs: res.outputs, fired: fire, duration_ms: Date.now() - started, token_usage: res.record?.token_usage, attempts: res.record?.attempts, node_kind: cn.def.kind, runtime: res.record?.runtime, resumed_from: res.record?.resumed_from },
      });
    } catch (e) {
      const message = (e as Error).message;
      const extra = (e as { record?: Partial<NodeRunRecord> }).record ?? {};
      st.status = 'failed';
      // 失敗節點的部分輸出（例如 HTTP 404 的 status / body）仍提供給 failure 分支讀取
      if (extra.outputs) st.outputs = extra.outputs as Record<string, unknown>;
      fire = cn.controlOutputs.includes('failure') ? ['failure'] : [];
      const handled = fire.length > 0 && this.controlConns((c) => c.source === node.id && c.sourceOutput === 'failure').length > 0;
      if (!handled) this.unhandledFailures.push(`${key}: ${message}`);
      this.record(node.id, { status: 'failed', error: message, fired: fire, duration_ms: Date.now() - started, ...extra });
      this.ctx.emitEvent('node_failed', { node_id: node.id, key, scope: this.scope, data: { error: message, handled, duration_ms: Date.now() - started, outputs: extra.outputs, attempts: extra.attempts, token_usage: extra.token_usage, node_kind: cn.def.kind, runtime: extra.runtime } });
    }
    // 2) 先 settle（讓等資料的下游可以讀），再做 dead-path，最後 forward 給 ControlFlowEngine
    st.resolve();
    for (const out of cn.controlOutputs) {
      if (fire.includes(out)) for (const c of this.controlConns((c) => c.source === node.id && c.sourceOutput === out)) this.edgeState.set(c.id, 'fired');
      else this.markDead(node.id, out);
    }
    for (const out of fire) {
      this.ctx.emitEvent('control_fired', { node_id: node.id, key, scope: this.scope, data: { port: out } });
      forward(out);
    }
  }

  private async behavior(node: RuntimeNode, inputs: Record<string, unknown>): Promise<{ outputs: Record<string, unknown>; fire: string[]; record?: Partial<NodeRunRecord> }> {
    const cn = node.cn;
    const cfg = cn.node.config ?? {};
    switch (cn.def.name) {
      case 'start':
      case 'loop_in':
        return { outputs: this.entryValues, fire: ['success'] };
      case 'end':
        this.endStatus = (cfg.status as 'success' | 'failed') ?? 'success';
        this.endOutputs = inputs;
        return { outputs: {}, fire: [], record: { outputs: { status: this.endStatus, ...inputs } } };
      case 'loop_out':
        this.loopOutputs = inputs;
        return { outputs: {}, fire: [], record: { outputs: inputs } };
      case 'join':
        return { outputs: {}, fire: ['success'] };
      case 'loop':
        return this.runLoop(cn, inputs);
      case 'foreach':
        return this.runForeach(cn, inputs);
      case 'subflow':
        return this.runSubflow(cn, inputs);
    }
    if (cn.def.kind === 'agent') return this.runAgent(cn, inputs);
    const spec = builtins[cn.def.name];
    if (spec?.execute) {
      const ac = new AbortController();
      const outer = this.ctx.opts.signal;
      const onAbort = () => ac.abort();
      outer?.addEventListener('abort', onAbort);
      try {
        return await spec.execute({
          cn, cfg, inputs, services: this.ctx.opts.services ?? {}, signal: ac.signal,
          log: (level, message, data) => this.ctx.emitEvent('log', { node_id: cn.id, key: this.key(cn.id), scope: this.scope, data: { level, message, value: data } }),
        });
      } finally {
        outer?.removeEventListener('abort', onAbort);
      }
    }
    throw new Error(`no behavior for node type ${cn.def.name}`);
  }

  private async runLoop(cn: CompiledNode, inputs: Record<string, unknown>) {
    const cfg = cn.node.config as unknown as LoopConfig;
    let carry: Record<string, unknown> = {};
    let last: Record<string, unknown> | undefined;
    let done = false;
    let i = 0;
    for (; i < cfg.max_iterations; i++) {
      const scope = [...this.scope, { loop: cn.id, iteration: i }];
      this.ctx.emitEvent('loop_iteration_started', { node_id: cn.id, key: this.key(cn.id), scope, data: { iteration: i, carry } });
      const sub = new GraphRun(cn.body!, scope, this.ctx, { ...inputs, ...carry, iteration: i });
      await sub.run();
      const ok = sub.loopOutputs !== undefined && sub.unhandledFailures.length === 0;
      this.ctx.emitEvent('loop_iteration_completed', { node_id: cn.id, key: this.key(cn.id), scope, data: { iteration: i, ok, outputs: sub.loopOutputs, failures: sub.unhandledFailures } });
      if (!ok) {
        if ((cfg.on_body_failure ?? 'fail') === 'fail') throw Object.assign(new Error(`loop body failed at iteration ${i}: ${sub.unhandledFailures.join('; ') || 'loop_out not reached'}`), { record: { iteration: null } });
        continue;
      }
      last = sub.loopOutputs!;
      if (cfg.until && evalRule(cfg.until, last[cfg.until.port])) {
        done = true;
        i++;
        break;
      }
      carry = Object.fromEntries((cfg.carry ?? []).map((c) => [c.to, last![c.from]]));
    }
    if (!last) throw new Error(`loop produced no successful iteration in ${i} attempts`);
    return { outputs: { ...last, iterations: i }, fire: ['completed', done || !cfg.until ? 'done' : 'exhausted'] };
  }

  /** foreach：每個元素一個 iteration scope（全新 GraphRun），loop_out 的輸入收集成陣列 */
  private async runForeach(cn: CompiledNode, inputs: Record<string, unknown>) {
    const cfg = cn.node.config ?? {};
    const items = inputs.items as unknown[];
    const max = Number(cfg.max_items ?? 100);
    if (items.length > max) throw new Error(`foreach: ${items.length} items exceeds max_items ${max}`);
    const extra = Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== 'items'));
    const outKeys = Object.keys(cn.outputs).filter((k) => k !== 'count');
    const collected: Record<string, unknown[]> = Object.fromEntries(outKeys.map((k) => [k, []]));
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      const scope = [...this.scope, { loop: cn.id, iteration: i }];
      this.ctx.emitEvent('loop_iteration_started', { node_id: cn.id, key: this.key(cn.id), scope, data: { iteration: i, item: items[i] } });
      const sub = new GraphRun(cn.body!, scope, this.ctx, { ...extra, item: items[i], index: i });
      await sub.run();
      const ok = sub.loopOutputs !== undefined && sub.unhandledFailures.length === 0;
      this.ctx.emitEvent('loop_iteration_completed', { node_id: cn.id, key: this.key(cn.id), scope, data: { iteration: i, ok, outputs: sub.loopOutputs, failures: sub.unhandledFailures } });
      if (!ok) {
        if ((cfg.on_item_failure ?? 'fail') === 'fail') throw new Error(`foreach item ${i} failed: ${sub.unhandledFailures.join('; ') || 'loop_out not reached'}`);
        continue;
      }
      for (const k of outKeys) collected[k].push(sub.loopOutputs![k] ?? null);
      count++;
    }
    return { outputs: { ...collected, count }, fire: ['success'] };
  }

  /** subflow：載入 workflows/<id>.json，在 [..., {loop: nodeId, iteration: 0}] scope 內執行 */
  private async runSubflow(cn: CompiledNode, inputs: Record<string, unknown>) {
    const services = this.ctx.opts.services ?? {};
    if (!services.loadWorkflow || !services.registry) throw new Error('subflow needs services.loadWorkflow + services.registry (run through the backend / CLI)');
    if (this.scope.length >= 8) throw new Error('subflow nesting too deep (max 8 scopes)');
    const id = String(cn.node.config?.workflow);
    const source = await services.loadWorkflow(id);
    const compiled = compileWorkflow(source, services.registry);
    if (!compiled.ok) throw new Error(`subflow "${id}" does not compile: ${compiled.errors.map((e) => e.code + ' ' + e.message).join('; ')}`);
    const scope = [...this.scope, { loop: cn.id, iteration: 0 }];
    // 把子流程「當下」的結構快照進事件流：歷史回放時即使來源 workflow 之後被改，也能畫出當時跑的圖
    this.ctx.emitEvent('subflow_started', { node_id: cn.id, key: this.key(cn.id), scope, data: { workflow_id: id, workflow: source, inputs } });
    const sub = new GraphRun(compiled.graph!, scope, this.ctx, inputs);
    await sub.run();
    const status = sub.endStatus ?? (sub.unhandledFailures.length ? 'failed' : 'success');
    const outputs = Object.fromEntries(Object.keys(cn.outputs).map((k) => [k, sub.endOutputs?.[k]]));
    if (status === 'failed' || sub.unhandledFailures.length)
      throw Object.assign(new Error(`subflow "${id}" ended ${status}${sub.unhandledFailures.length ? ': ' + sub.unhandledFailures.join('; ') : ''}`), { record: { outputs } });
    return { outputs, fire: ['success'] };
  }

  private async runAgent(cn: CompiledNode, inputs: Record<string, unknown>) {
    // 實例 config 只能覆寫 registry 允許的欄位（compiler 已驗證）
    const overrides = Object.fromEntries(Object.entries(cn.node.config ?? {}).filter(([k]) => (cn.def.instance_overridable ?? []).includes(k))) as AgentConfig;
    const def = { ...cn.def, config: { ...cn.def.config, ...overrides } };
    const cached = this.ctx.opts.resume?.results.get(`${scopeKey(this.scope)}/${cn.id}`);
    if (cached) {
      return { outputs: cached.outputs, fire: cached.fired, record: { attempts: 0, runtime: 'resumed', resumed_from: this.ctx.opts.resume!.fromRunId } };
    }
    const runtime = this.ctx.opts.selectRuntime?.(def) ?? this.ctx.opts.runtime;
    const prompt = interpolateReferences(def.prompt ?? '', new Map([['inputs', inputs]]), new Map([['inputs', 'inputs']]));
    const outputSchema = {
      type: 'object',
      properties: Object.fromEntries(Object.entries(cn.outputs).map(([k, p]) => [k, p.schema])),
      required: Object.entries(cn.outputs).filter(([, p]) => p.required !== false).map(([k]) => k),
      additionalProperties: false,
    };
    const maxAttempts = def.config?.retry?.max_attempts ?? 1;
    const timeoutMs = (def.config?.timeout_seconds ?? 300) * 1000;
    const iteration = this.scope.length ? this.scope[this.scope.length - 1].iteration : null;
    const events: AgentEvent[] = [];
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    let lastErr = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outer = this.ctx.opts.signal;
      const onAbort = () => ac.abort();
      outer?.addEventListener('abort', onAbort);
      try {
        if (outer?.aborted) throw new Error('run cancelled');
        const res = await Promise.race([
          runtime.run({ def, nodeId: cn.id, inputs, prompt, outputSchema, scope: this.scope, iteration, attempt, signal: ac.signal, workingDirectory: this.ctx.opts.workingDirectory ?? (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '/' }),
          new Promise<never>((_, rej) => (timer = setTimeout(() => { ac.abort(); rej(new Error(`timeout after ${timeoutMs}ms`)); }, timeoutMs))),
        ]);
        events.push(...res.events);
        for (const ev of res.events) this.ctx.emitEvent('agent_event', { node_id: cn.id, key: this.key(cn.id), scope: this.scope, data: ev as unknown as Record<string, unknown> });
        if (res.usage) {
          usage.input_tokens += res.usage.input_tokens;
          usage.output_tokens += res.usage.output_tokens;
          usage.cost_usd = (usage.cost_usd ?? 0) + (res.usage.cost_usd ?? 0);
        }
        const v = validateValue(outputSchema, res.outputs);
        if (!v.ok) throw new Error(`structured output failed schema validation: ${v.errors}`);
        return { outputs: res.outputs, fire: ['success'], record: { attempts: attempt, token_usage: usage, runtime: runtime.name, agent_events: events } };
      } catch (e) {
        lastErr = (e as Error).message;
        events.push({ type: 'error', message: lastErr });
        if (attempt < maxAttempts) {
          this.ctx.emitEvent('node_retry', { node_id: cn.id, key: this.key(cn.id), scope: this.scope, data: { attempt, error: lastErr } });
          await new Promise((r) => setTimeout(r, def.config?.retry?.backoff_ms ?? 0));
        }
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener('abort', onAbort);
      }
      if (outer?.aborted) break;
    }
    throw Object.assign(new Error(`agent failed after ${maxAttempts} attempt(s): ${lastErr}`), { record: { attempts: maxAttempts, token_usage: usage, runtime: runtime.name, agent_events: events } });
  }

  // ------------------------------------------------------------------ records
  private record(nodeId: string, patch: Partial<NodeRunRecord>) {
    const key = this.key(nodeId);
    const prev = this.ctx.records.get(key);
    const rec: NodeRunRecord = {
      ...(prev ?? { run_id: this.ctx.runId, node_id: nodeId, scope: this.scope, key, iteration: this.scope.length ? this.scope[this.scope.length - 1].iteration : null, status: 'pending' as NodeStatus }),
      ...patch,
    };
    this.ctx.records.set(key, rec);
  }
}

export async function runWorkflow(graph: CompiledGraph, inputs: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
  const ctx = new RunContext(opts);
  const started = Date.now();
  ctx.emitEvent('run_started', { data: { inputs } });
  const root = new GraphRun(graph, [], ctx, inputs);
  await root.run();
  const records = [...ctx.records.values()];
  const usage = records.reduce<TokenUsage>(
    (a, r) => ({ input_tokens: a.input_tokens + (r.token_usage?.input_tokens ?? 0), output_tokens: a.output_tokens + (r.token_usage?.output_tokens ?? 0), cost_usd: (a.cost_usd ?? 0) + (r.token_usage?.cost_usd ?? 0) }),
    { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  );
  const status = root.endStatus ?? (root.unhandledFailures.length ? 'failed' : 'success');
  ctx.emitEvent('run_completed', { data: { status, unhandled_failures: root.unhandledFailures, duration_ms: Date.now() - started } });
  return { run_id: ctx.runId, status: status === 'failed' || root.unhandledFailures.length ? 'failed' : 'success', records, events: ctx.events, duration_ms: Date.now() - started, token_usage: usage };
}

export { ControlSocket, TypedSocket };
