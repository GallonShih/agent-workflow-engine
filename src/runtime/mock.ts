import type { JSONSchema } from '../types.js';
import type { AgentRunRequest, AgentRunResult, AgentRuntime } from './types.js';

export type MockHandler = (req: AgentRunRequest) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * 確定性的 Mock Agent：沒有 API key 也能跑完整 workflow。
 * handlers 以 node definition name（或 node id）為 key；沒有 handler 時依 output schema 產生假資料。
 * token 用量用字數估算（prompt/4、output/4），只用來讓 Execution Monitor 有欄位可顯示。
 */
export class MockAgentRuntime implements AgentRuntime {
  name = 'mock';
  constructor(private handlers: Record<string, MockHandler> = {}, private delayMs = 0) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    if (this.delayMs) await sleep(this.delayMs, req.signal);
    const h = this.handlers[req.nodeId] ?? this.handlers[req.def.name];
    const outputs = h ? await h(req) : (synth(req.outputSchema) as Record<string, unknown>);
    const out = JSON.stringify(outputs);
    return {
      outputs,
      events: [
        { type: 'tool-use', name: 'MockTool', input: { node: req.nodeId, iteration: req.iteration } },
        { type: 'complete', result: out.slice(0, 200) },
      ],
      usage: { input_tokens: Math.ceil(req.prompt.length / 4), output_tokens: Math.ceil(out.length / 4), cost_usd: 0 },
    };
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

function synth(s: JSONSchema): unknown {
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  switch (s.type) {
    case 'string': return `mock ${String(s.title ?? 'text')}`;
    case 'number':
    case 'integer': return 1;
    case 'boolean': return true;
    case 'array': return [synth((s.items ?? {}) as JSONSchema)];
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, JSONSchema>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, synth(v)]));
    }
    default: return null;
  }
}
