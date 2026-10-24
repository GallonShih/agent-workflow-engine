import type { DataPortDef, JSONSchema, NodeDefinition, NodeTier } from './types.js';
import { assertValidSchema } from './schema.js';

/**
 * Node Registry（不依賴 fs，瀏覽器也能用；從目錄載入見 registry-fs.ts）：YAML/JSON 節點定義（Agent 與 builtin 都一樣格式）。
 * - `types.yaml` 可以定義具名型別（Task、Issue...），port schema 用 `$type: Task` 引用，
 *   載入時展開成完整 JSON Schema 並加上 title（UI socket 名稱）。
 * - 簡寫：port 直接寫 JSON Schema（`{type: string}`），或寫成 `{schema: ..., required: false}`。
 */
export class NodeRegistry {
  private defs = new Map<string, NodeDefinition>();
  types: Record<string, JSONSchema> = {};

  /** 註冊具名型別（types.yaml） */
  addTypes(raw: Record<string, JSONSchema>): void {
    for (const [name, schema] of Object.entries(raw)) this.types[name] = { title: name, ...schema };
  }

  register(raw: Record<string, unknown>, source = '<inline>'): NodeDefinition {
    if (typeof raw.name !== 'string') throw new Error(`${source}: node definition needs "name"`);
    const kind = (raw.kind as NodeDefinition['kind']) ?? (raw.runtime ? 'agent' : 'builtin');
    const def: NodeDefinition = {
      ...(raw as unknown as NodeDefinition),
      version: Number(raw.version ?? 1),
      kind,
      mode: (raw.mode as NodeDefinition['mode']) ?? 'control',
      inputs: this.normalizePorts(raw.inputs, `${source}#inputs`),
      outputs: this.normalizePorts(raw.outputs, `${source}#outputs`),
      control_inputs: (raw.control_inputs as string[]) ?? ((raw.mode ?? 'control') === 'control' ? ['execute'] : []),
      control_outputs: (raw.control_outputs as string[]) ?? ((raw.mode ?? 'control') === 'control' ? ['success', 'failure'] : []),
      source,
    };
    if (def.kind === 'agent' && !def.runtime) throw new Error(`${source}: agent node needs "runtime"`);
    if (def.kind === 'agent') {
      def.instance_overridable ??= ['max_turns', 'timeout_seconds', 'retry'];
      def.config_schema ??= agentConfigSchema(def);
    }
    if (def.config_schema) {
      def.config_schema = this.resolveTypes(def.config_schema, `${source}#config_schema`);
      assertValidSchema(def.config_schema, `${source}#config_schema`);
    }
    const dup = [...Object.keys(def.inputs), ...Object.keys(def.outputs)].filter((k) => def.control_inputs.includes(k) || def.control_outputs.includes(k));
    if (dup.length) throw new Error(`${source}: port names used for both data and control: ${dup.join(', ')}`);
    this.defs.set(def.name, def);
    return def;
  }

  normalizePorts(raw: unknown, where: string): Record<string, DataPortDef> {
    const out: Record<string, DataPortDef> = {};
    for (const [name, v] of Object.entries((raw ?? {}) as Record<string, Record<string, unknown>>)) {
      const port: DataPortDef = v && typeof v === 'object' && 'schema' in v ? { ...(v as unknown as DataPortDef) } : { schema: v as JSONSchema };
      port.schema = this.resolveTypes(port.schema, `${where}.${name}`);
      assertValidSchema(port.schema, `${where}.${name}`);
      out[name] = port;
    }
    return out;
  }

  resolveTypes(schema: unknown, where: string): JSONSchema {
    if (Array.isArray(schema)) return schema.map((s) => this.resolveTypes(s, where)) as unknown as JSONSchema;
    if (!schema || typeof schema !== 'object') return schema as JSONSchema;
    const s = schema as Record<string, unknown>;
    if (typeof s.$type === 'string') {
      const t = this.types[s.$type];
      if (!t) throw new Error(`${where}: unknown $type "${s.$type}"`);
      const { $type: _omit, ...rest } = s;
      return { ...t, ...rest };
    }
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) res[k] = typeof v === 'object' && v !== null ? this.resolveTypes(v, where) : v;
    return res;
  }

  get(name: string): NodeDefinition | undefined {
    return this.defs.get(name);
  }

  /**
   * 預設只列出 v1 節點（精簡版給使用者 / MCP agent）；advanced: true 列出 v1 + advanced；all: true 連 internal（loop_in / loop_out）也列。
   * tier 沒寫的 builtin 視為 advanced、agent 視為 v1。
   */
  list(opts: { advanced?: boolean; all?: boolean } = {}): NodeDefinition[] {
    const defs = [...this.defs.values()];
    if (opts.all) return defs;
    return defs.filter((d) => tierOf(d) === 'v1' || (opts.advanced && tierOf(d) === 'advanced'));
  }
}


export function tierOf(def: NodeDefinition): NodeTier {
  return def.tier ?? (def.kind === 'agent' ? 'v1' : 'advanced');
}

/** Agent 節點實例可調整的欄位（預設值取自 registry 的 config）；model / tools / MCP / skills 不在其中 */
function agentConfigSchema(def: NodeDefinition): JSONSchema {
  const all: Record<string, JSONSchema> = {
    max_turns: { type: 'integer', minimum: 1, maximum: 200, title: '最大回合數', default: def.config?.max_turns },
    timeout_seconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600, title: '逾時（秒）', default: def.config?.timeout_seconds },
    retry: {
      type: 'object',
      title: '重試',
      properties: {
        max_attempts: { type: 'integer', minimum: 1, maximum: 10, title: '最多嘗試次數', default: def.config?.retry?.max_attempts ?? 1 },
        backoff_ms: { type: 'integer', minimum: 0, maximum: 60000, title: '間隔（ms）', default: def.config?.retry?.backoff_ms ?? 0 },
      },
      required: ['max_attempts'],
      additionalProperties: false,
    },
  };
  const allowed = def.instance_overridable ?? [];
  return JSON.parse(JSON.stringify({
    type: 'object',
    properties: Object.fromEntries(Object.entries(all).filter(([k]) => allowed.includes(k))),
    additionalProperties: false,
  }));
}
