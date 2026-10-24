import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { DataPortDef, JSONSchema, NodeDefinition } from './types.js';
import { assertValidSchema } from './schema.js';

/**
 * Node Registry：從目錄載入 YAML/JSON 節點定義（Agent 與 builtin 都一樣格式）。
 * - `types.yaml` 可以定義具名型別（Task、Issue...），port schema 用 `$type: Task` 引用，
 *   載入時展開成完整 JSON Schema 並加上 title（UI socket 名稱）。
 * - 簡寫：port 直接寫 JSON Schema（`{type: string}`），或寫成 `{schema: ..., required: false}`。
 */
export class NodeRegistry {
  private defs = new Map<string, NodeDefinition>();
  types: Record<string, JSONSchema> = {};

  static fromDirs(...dirs: string[]): NodeRegistry {
    const reg = new NodeRegistry();
    for (const dir of dirs) reg.loadDir(dir);
    return reg;
  }

  loadDir(dir: string): void {
    const files = fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
    const typesFile = files.find((f) => /^types\.(ya?ml|json)$/.test(f));
    if (typesFile) {
      const raw = parseFile(path.join(dir, typesFile)) as Record<string, JSONSchema>;
      for (const [name, schema] of Object.entries(raw)) this.types[name] = { title: name, ...schema };
    }
    for (const f of files) {
      if (f === typesFile) continue;
      this.register(parseFile(path.join(dir, f)) as Record<string, unknown>, path.join(dir, f));
    }
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

  list(): NodeDefinition[] {
    return [...this.defs.values()];
  }
}

function parseFile(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  return file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
}
