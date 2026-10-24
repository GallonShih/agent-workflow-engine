import jsonata from 'jsonata';
import type { CompiledNode } from '../compiler.js';
import { evalRule } from '../rules.js';
import { assertValidSchema, validateValue } from '../schema.js';
import type { RunServices } from '../services.js';
import type { DataPortDef, JSONSchema, NodeRunRecord, Rule } from '../types.js';
import { interpolateReferences } from '../vendor/circuit/orchestrator/references.js';

/**
 * 常用 builtin 節點的「ports 規則 + 設定檢查 + 執行器」。
 * engine.ts 只負責排程語意；composite（loop / foreach / subflow）與 start / end / join 留在 engine，
 * 其餘節點的行為都在這裡，新增節點 = registry YAML + 這裡一個 entry。
 */

export interface PortSet {
  inputs: Record<string, DataPortDef>;
  outputs: Record<string, DataPortDef>;
  controlInputs: string[];
  controlOutputs: string[];
}

export interface ExecArgs {
  cn: CompiledNode;
  cfg: Record<string, unknown>;
  inputs: Record<string, unknown>;
  services: RunServices;
  signal: AbortSignal;
  log: (level: string, message: string, data?: unknown) => void;
}
export interface ExecResult {
  outputs: Record<string, unknown>;
  fire: string[];
  record?: Partial<NodeRunRecord>;
}

export interface BuiltinSpec {
  /** 依實例 config 調整 ports（Merge 輸入數、Switch cases、Join 輸入數...） */
  ports?: (cfg: Record<string, unknown>, base: PortSet) => PortSet;
  /** 語意檢查（schema 以外），回傳錯誤訊息 */
  check?: (cfg: Record<string, unknown>, ports: PortSet) => string[];
  /** control-mode 執行器 */
  execute?: (a: ExecArgs) => Promise<ExecResult> | ExecResult;
  /** data-mode 計算（lazy pull，無副作用） */
  compute?: (a: Omit<ExecArgs, 'signal' | 'log' | 'services'>) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

const ANY: DataPortDef = { schema: {}, required: false };
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

export function interpolate(tpl: string, inputs: Record<string, unknown>): string {
  return interpolateReferences(tpl, new Map([['inputs', inputs]]), new Map([['inputs', 'inputs']]));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

function plain(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export function extractJson(text: string, codeBlock = true): unknown {
  const m = codeBlock ? text.match(/```(?:json)?\s*([\s\S]*?)```/) : null;
  return JSON.parse((m ? m[1] : text).trim());
}

function requireFs(services: RunServices) {
  if (!services.fs) throw new Error('file nodes need a sandboxed workspace (not available in in-browser mode; run through the backend)');
  return services.fs;
}

export const builtins: Record<string, BuiltinSpec> = {
  condition: {
    execute: ({ cfg, inputs }) => {
      const result = evalRule(cfg.rule as Rule, inputs.value);
      return { outputs: {}, fire: [result ? 'true' : 'false'], record: { outputs: { result } } };
    },
  },

  join: {
    ports: (cfg, base) => ({ ...base, controlInputs: cfg.inputs ? range(Number(cfg.inputs)).map((i) => `in_${i}`) : ['in'] }),
  },

  switch: {
    ports: (cfg, base) => {
      const cases = Array.isArray(cfg.cases) ? (cfg.cases as { name: string }[]) : [];
      return { ...base, controlOutputs: [...cases.map((c) => c.name).filter((n) => typeof n === 'string'), 'default'] };
    },
    check: (cfg, ports) => {
      const names = ((cfg.cases as { name: string }[]) ?? []).map((c) => c.name);
      const errs: string[] = [];
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      if (dup.length) errs.push(`duplicate case names: ${[...new Set(dup)].join(', ')}`);
      if (names.includes('default')) errs.push('"default" is reserved');
      const clash = names.filter((n) => n in ports.outputs || n === 'execute');
      if (clash.length) errs.push(`case names clash with data ports: ${clash.join(', ')}`);
      return errs;
    },
    execute: ({ cfg, inputs }) => {
      const cases = cfg.cases as { name: string; rule: Rule }[];
      const all = cases.filter((c) => evalRule(c.rule, inputs.value)).map((c) => c.name);
      const matched = cfg.match === 'all' ? all : all.slice(0, 1);
      return { outputs: { value: inputs.value, matched }, fire: matched.length ? matched : ['default'] };
    },
  },

  merge: {
    ports: (cfg, base) => ({
      ...base,
      inputs: Object.fromEntries(range(Number(cfg.inputs ?? 2)).map((i) => [`in_${i}`, ANY])),
    }),
    compute: ({ cfg, inputs, cn }) => {
      const keys = Object.keys(cn.inputs);
      const mode = (cfg.mode as string) ?? 'array';
      if (mode === 'object') return { merged: Object.fromEntries(keys.filter((k) => inputs[k] !== undefined).map((k) => [k, inputs[k]])) };
      const vals = keys.map((k) => inputs[k]).filter((v) => v !== undefined && v !== null);
      return { merged: mode === 'first' ? (vals[0] ?? null) : vals };
    },
  },

  template: {
    compute: ({ cfg, inputs }) => ({ text: interpolate(String(cfg.template ?? ''), inputs) }),
  },

  set: {
    check: (cfg, ports) => {
      const values = (cfg.values ?? {}) as Record<string, unknown>;
      const errs: string[] = [];
      for (const [k, p] of Object.entries(ports.outputs)) {
        if (!(k in values)) errs.push(`values.${k} is missing`);
        else {
          const v = validateValue(p.schema, values[k]);
          if (!v.ok) errs.push(`values.${k}: ${v.errors}`);
        }
      }
      for (const k of Object.keys(values)) if (!(k in ports.outputs)) errs.push(`values.${k} has no output port (declare it in ports.outputs)`);
      return errs;
    },
    compute: ({ cfg }) => ({ ...((cfg.values ?? {}) as Record<string, unknown>) }),
  },

  transform: {
    check: (cfg) => {
      try {
        jsonata(String(cfg.expression ?? ''));
        return [];
      } catch (e) {
        return [`JSONata syntax error: ${(e as Error).message}`];
      }
    },
    execute: async ({ cfg, inputs, signal }) => {
      const expr = jsonata(String(cfg.expression));
      const ms = Number(cfg.timeout_ms ?? 1000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          expr.evaluate(inputs.input, { input: inputs.input }),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`JSONata timeout after ${ms}ms`)), ms);
            signal.addEventListener('abort', () => rej(new Error('aborted')));
          }),
        ]);
        return { outputs: { result: plain(result) }, fire: ['success'] };
      } finally {
        clearTimeout(timer);
      }
    },
  },

  filter: {
    execute: ({ cfg, inputs }) => {
      const items = inputs.items as unknown[];
      const keep: unknown[] = [];
      const rejected: unknown[] = [];
      for (const it of items) (evalRule(cfg.rule as Rule, it) ? keep : rejected).push(it);
      return { outputs: { items: keep, rejected, count: keep.length }, fire: ['success'] };
    },
  },

  delay: {
    execute: async ({ cfg, inputs, signal }) => {
      await sleep(Number(cfg.ms ?? 0), signal);
      return { outputs: { value: inputs.value }, fire: ['success'] };
    },
  },

  log: {
    execute: ({ cfg, inputs, log }) => {
      const msg = typeof inputs.message === 'string' ? inputs.message : JSON.stringify(inputs.message);
      log(String(cfg.level ?? 'info'), cfg.label ? `${cfg.label}: ${msg}` : msg, inputs.message);
      return { outputs: { value: inputs.message }, fire: ['success'] };
    },
  },

  json_parse: {
    execute: ({ cfg, inputs }) => {
      try {
        return { outputs: { value: extractJson(String(inputs.text), cfg.extract_code_block !== false) }, fire: ['success'] };
      } catch (e) {
        throw new Error(`invalid JSON: ${(e as Error).message}`);
      }
    },
  },

  schema_validate: {
    ports: (cfg, base) =>
      cfg.schema && typeof cfg.schema === 'object' ? { ...base, outputs: { ...base.outputs, value: { schema: cfg.schema as JSONSchema, required: false } } } : base,
    check: (cfg) => {
      try {
        assertValidSchema(cfg.schema as JSONSchema, 'config.schema');
        return [];
      } catch (e) {
        return [(e as Error).message];
      }
    },
    execute: ({ cfg, inputs }) => {
      const v = validateValue(cfg.schema as JSONSchema, inputs.value);
      const errors = v.ok ? [] : v.errors.split(', ');
      return { outputs: { value: v.ok ? inputs.value : undefined, is_valid: v.ok, errors }, fire: [v.ok ? 'valid' : 'invalid'] };
    },
  },

  http_request: {
    execute: async ({ cfg, inputs, services, signal }) => {
      const doFetch = services.fetch ?? globalThis.fetch;
      if (!doFetch) throw new Error('fetch is not available');
      const raw = (inputs.url as string | undefined) ?? (cfg.url ? interpolate(String(cfg.url), inputs) : '');
      if (!raw) throw new Error('no URL (connect the url input or set config.url)');
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`protocol not allowed: ${url.protocol}`);
      if (services.httpAllowHosts?.length && !services.httpAllowHosts.includes(url.hostname)) throw new Error(`host not in allowlist: ${url.hostname}`);
      for (const [k, v] of Object.entries((inputs.query ?? {}) as Record<string, unknown>)) url.searchParams.set(k, String(v));
      const method = String(cfg.method ?? 'GET');
      const headers: Record<string, string> = { ...((cfg.headers ?? {}) as Record<string, string>), ...((inputs.headers ?? {}) as Record<string, string>) };
      let body: string | undefined;
      if (inputs.body !== undefined && method !== 'GET') {
        body = typeof inputs.body === 'string' ? inputs.body : JSON.stringify(inputs.body);
        if (typeof inputs.body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
      const timeout = Number(cfg.timeout_ms ?? 10000);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener('abort', onAbort);
      const timer = setTimeout(() => ac.abort(), timeout);
      let res: Response;
      try {
        res = await doFetch(url, { method, headers, body, signal: ac.signal });
      } catch (e) {
        throw new Error(ac.signal.aborted && !signal.aborted ? `HTTP timeout after ${timeout}ms` : `HTTP request failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
      const text = await res.text();
      const type = (cfg.response_type as string) ?? 'auto';
      let parsed: unknown = text;
      if (type === 'json' || (type === 'auto' && (res.headers.get('content-type') ?? '').includes('json'))) {
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          if (type === 'json') throw new Error(`response is not JSON: ${(e as Error).message}`);
        }
      }
      const outputs = { status: res.status, ok: res.ok, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
      if (!res.ok && cfg.fail_on_http_error !== false)
        throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), { record: { outputs } });
      return { outputs, fire: ['success'] };
    },
  },

  file_read: {
    ports: (cfg, base) => ((cfg.format ?? 'text') === 'text' ? { ...base, outputs: { ...base.outputs, content: { schema: { type: 'string' } } } } : base),
    execute: async ({ cfg, inputs, services }) => {
      const fs = requireFs(services);
      const p = (inputs.path as string | undefined) ?? (cfg.path as string | undefined);
      if (!p) throw new Error('no path (connect the path input or set config.path)');
      const text = await fs.readFile(p);
      const content = cfg.format === 'json' ? JSON.parse(text) : text;
      return { outputs: { content, path: p, bytes: new TextEncoder().encode(text).length }, fire: ['success'] };
    },
  },

  file_write: {
    execute: async ({ cfg, inputs, services }) => {
      const fs = requireFs(services);
      const p = (inputs.path as string | undefined) ?? (cfg.path as string | undefined);
      if (!p) throw new Error('no path (connect the path input or set config.path)');
      const c = inputs.content;
      const text = cfg.format === 'json' ? JSON.stringify(c, null, 2) + '\n' : typeof c === 'string' ? c : JSON.stringify(c);
      const res = await fs.writeFile(p, text, (cfg.mode as 'overwrite' | 'append') ?? 'overwrite');
      return { outputs: res, fire: ['success'] };
    },
  },

  subflow: {
    check: (cfg) => (typeof cfg.workflow === 'string' && /^[A-Za-z0-9_.-]+$/.test(cfg.workflow) ? [] : ['workflow must be a workflow id (file name in workflows/)']),
  },
};
