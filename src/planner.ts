import type { NodeRegistry } from './registry.js';
import { compileWorkflow, type CompileResult, type Diagnostic } from './compiler.js';
import { typeLabel } from './schema.js';
import type { WorkflowGraph } from './types.js';

/**
 * Phase 4 雛形：Planner = 「LLM 產生 Workflow JSON」+「compiler 當閘門」+「把錯誤回饋給 LLM 修正」。
 * Planner 只看得到 Node Registry 的目錄（catalog），不能發明新節點、不能改 tools/MCP/model ——
 * 這些都由 compileWorkflow 強制（UNKNOWN_NODE_TYPE / POLICY_OVERRIDE），不靠 prompt 自律。
 */
export type PlanGenerator = (prompt: string, attempt: number) => Promise<string>;

export interface PlanAttempt {
  attempt: number;
  raw: string;
  parseError?: string;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
export interface PlanResult {
  ok: boolean;
  workflow?: WorkflowGraph;
  compiled?: CompileResult;
  attempts: PlanAttempt[];
}

/** 給 LLM 看的 registry 目錄（只列名稱、說明、ports 型別；不含 system prompt / tools） */
export function registryCatalog(registry: NodeRegistry): string {
  return registry
    .list()
    .map((d) => {
      const ins = Object.entries(d.inputs).map(([k, p]) => `${k}${p.required === false || p.default !== undefined ? '?' : ''}: ${typeLabel(p.schema)}`);
      const outs = Object.entries(d.outputs).map(([k, p]) => `${k}: ${typeLabel(p.schema)}`);
      return [
        `- ${d.name} (${d.kind}${d.dynamic_ports ? ', dynamic ports' : ''})${d.description ? ' — ' + d.description : ''}`,
        `    data in:  ${ins.join(', ') || '—'}`,
        `    data out: ${outs.join(', ') || '—'}`,
        `    control in: ${d.control_inputs.join(', ') || '—'} | control out: ${d.control_outputs.join(', ') || '—'}`,
      ].join('\n');
    })
    .join('\n');
}

export function buildPlannerPrompt(registry: NodeRegistry, goal: string): string {
  return [
    '你是 workflow planner。請只輸出一個 JSON 物件（WorkflowGraph：{ id, name, nodes[], edges[] }），不要其他文字。',
    '規則：',
    '1. node.type 只能使用下列 Node Registry 中的名稱；不得新增節點類型。',
    '2. 不得在 node.config 設定 runtime / allowed_tools / mcp / skills / system_prompt / model（權限只來自 registry）。',
    '3. edge 分 kind:"data"（傳資料，不觸發）與 kind:"control"（觸發執行）；data edge 兩端型別必須相容。',
    '4. 外層必須是 DAG；需要重試請用 loop composite（config.max_iterations、until、carry；body 內恰好一個 loop_in 與 loop_out）。',
    '5. 失敗路徑要接到 end（config.status:"failed"）。',
    '',
    'Node Registry：',
    registryCatalog(registry),
    '',
    `使用者目標：${goal}`,
  ].join('\n');
}

function repairPrompt(base: string, prev: PlanAttempt): string {
  const issues = prev.parseError ? [`JSON 解析失敗：${prev.parseError}`] : prev.errors.map((e) => `[${e.code}] ${e.message}`);
  return `${base}\n\n上一版 workflow 沒有通過 compiler，請修正後重新輸出完整 JSON：\n${issues.map((s) => '- ' + s).join('\n')}`;
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(text);
}

/** 產生 → 編譯 → 有錯就帶著 diagnostics 重試（最多 maxAttempts 次） */
export async function planWorkflow(opts: { goal: string; registry: NodeRegistry; generate: PlanGenerator; maxAttempts?: number }): Promise<PlanResult> {
  const base = buildPlannerPrompt(opts.registry, opts.goal);
  const attempts: PlanAttempt[] = [];
  const max = opts.maxAttempts ?? 3;
  for (let i = 1; i <= max; i++) {
    const prompt = i === 1 ? base : repairPrompt(base, attempts[attempts.length - 1]);
    const raw = await opts.generate(prompt, i);
    let wf: WorkflowGraph;
    try {
      wf = extractJson(raw) as WorkflowGraph;
    } catch (e) {
      attempts.push({ attempt: i, raw, parseError: (e as Error).message, errors: [], warnings: [] });
      continue;
    }
    const compiled = compileWorkflow(wf, opts.registry);
    attempts.push({ attempt: i, raw, errors: compiled.errors, warnings: compiled.warnings });
    if (compiled.ok) return { ok: true, workflow: wf, compiled, attempts };
  }
  return { ok: false, attempts };
}

/**
 * Mock planner（沒有 API key 時用）：第一版故意犯兩個典型錯誤（發明節點類型、偷改 allowed_tools），
 * 收到 compiler 回饋後輸出正確版本 —— 用來展示「planner 只能用 registry 節點」由 compiler 強制。
 */
export function mockPlanGenerator(template: WorkflowGraph): PlanGenerator {
  return async (prompt, attempt) => {
    const wf: WorkflowGraph = JSON.parse(JSON.stringify(template));
    if (attempt === 1) {
      wf.nodes.push({ id: 'web', type: 'web_search_agent' });
      const coder = findNode(wf, 'coder');
      if (coder) coder.config = { ...(coder.config ?? {}), allowed_tools: ['Bash', 'WebFetch'] };
    }
    const m = prompt.match(/最多\s*(\d+)\s*次/);
    if (m) {
      const loop = wf.nodes.find((n) => n.type === 'loop');
      if (loop) loop.config = { ...(loop.config ?? {}), max_iterations: Number(m[1]) };
    }
    return '```json\n' + JSON.stringify(wf, null, 2) + '\n```';
  };
}

function findNode(wf: WorkflowGraph, id: string) {
  for (const n of wf.nodes) {
    if (n.id === id) return n;
    const inner = n.body?.nodes.find((b) => b.id === id);
    if (inner) return inner;
  }
  return undefined;
}
