import { useState } from 'react';
import type { Diagnostic, ResolvedPorts } from '../../src/compiler.js';
import type { NodeRegistry } from '../../src/registry.js';
import { typeLabel } from '../../src/schema.js';
import type { DataPortDef, JSONSchema, NodeDefinition, WorkflowNode } from '../../src/types.js';
import { JsonField, SchemaForm, inputStyle } from './schema-form.js';

/** 哪些節點有哪一側的 dynamic ports（由使用者在面板宣告） */
const DYNAMIC_SIDES: Record<string, ('inputs' | 'outputs')[]> = {
  start: ['outputs'],
  set: ['outputs'],
  end: ['inputs'],
  template: ['inputs'],
  loop: ['inputs', 'outputs'],
  foreach: ['inputs', 'outputs'],
  subflow: ['inputs', 'outputs'],
};
const POLICY: [keyof NodeDefinition, string][] = [
  ['runtime', 'Runtime'],
  ['model', 'Model'],
  ['system_prompt', 'System prompt'],
  ['prompt', 'Prompt 模板'],
  ['allowed_tools', 'Allowed tools'],
  ['mcp', 'MCP servers'],
  ['skills', 'Skills'],
];

const section: React.CSSProperties = { borderTop: '1px solid #e2e8f0', padding: '8px 12px' };
const h: React.CSSProperties = { margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.04em', color: '#64748b' };
const td: React.CSSProperties = { padding: '3px 4px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' };

// ---------------------------------------------------------------- type picker
function typeOptions(registry: NodeRegistry) {
  const base: [string, JSONSchema][] = [
    ['string', { type: 'string' }],
    ['number', { type: 'number' }],
    ['integer', { type: 'integer' }],
    ['boolean', { type: 'boolean' }],
    ['object', { type: 'object' }],
    ['array', { type: 'array' }],
    ['string[]', { type: 'array', items: { type: 'string' } }],
    ['number[]', { type: 'array', items: { type: 'number' } }],
    ['object[]', { type: 'array', items: { type: 'object' } }],
    ['any', {}],
  ];
  for (const t of Object.keys(registry.types)) base.push([t, { $type: t }], [`${t}[]`, { type: 'array', items: { $type: t } }]);
  return base;
}
const keyOf = (schema: JSONSchema, opts: [string, JSONSchema][]) => opts.find(([, s]) => JSON.stringify(s) === JSON.stringify(schema))?.[0] ?? 'custom';
const asPort = (raw: DataPortDef | JSONSchema): DataPortDef => (raw && typeof raw === 'object' && 'schema' in raw ? (raw as DataPortDef) : { schema: raw as JSONSchema });

function PortEditor(props: {
  side: 'inputs' | 'outputs';
  ports: Record<string, DataPortDef | JSONSchema>;
  registry: NodeRegistry;
  fixedNames?: string[];
  allowAdd?: boolean;
  onChange: (p: Record<string, DataPortDef | JSONSchema>) => void;
}) {
  const opts = typeOptions(props.registry);
  const entries = Object.entries(props.ports);
  const [newName, setNewName] = useState('');
  const update = (name: string, next: DataPortDef | JSONSchema | null, rename?: string) => {
    const out: Record<string, DataPortDef | JSONSchema> = {};
    for (const [k, v] of entries) {
      if (k !== name) out[k] = v;
      else if (next) out[rename ?? k] = next;
    }
    props.onChange(out);
  };
  const store = (p: DataPortDef): DataPortDef | JSONSchema => (p.required === false || p.default !== undefined || p.description ? p : p.schema);
  return (
    <div data-port-editor={props.side}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {entries.map(([name, raw]) => {
            const p = asPort(raw);
            const k = keyOf(p.schema, opts);
            const fixed = props.fixedNames?.includes(name);
            return (
              <tr key={name}>
                <td style={td}>
                  <input style={{ ...inputStyle, width: 110 }} defaultValue={name} readOnly={fixed} onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) update(name, raw, v);
                    else e.target.value = name;
                  }} />
                </td>
                <td style={td}>
                  <select style={inputStyle} value={k} onChange={(e) => {
                    const s = opts.find(([o]) => o === e.target.value)?.[1];
                    if (s) update(name, store({ ...p, schema: s }));
                  }}>
                    {opts.map(([o]) => <option key={o} value={o}>{o}</option>)}
                    {k === 'custom' && <option value="custom">{typeLabel(p.schema)}（自訂）</option>}
                  </select>
                </td>
                {props.side === 'inputs' && (
                  <td style={td} title="必填">
                    <label><input type="checkbox" checked={p.required !== false} onChange={(e) => update(name, store({ ...p, required: e.target.checked ? undefined : false }))} />必填</label>
                  </td>
                )}
                <td style={td}>{!fixed && <button title="刪除 port" onClick={() => update(name, null)}>✕</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {props.allowAdd !== false && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <input data-new-port={props.side} style={{ ...inputStyle, width: 140 }} placeholder="新 port 名稱" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button data-add-port={props.side} disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) || newName in props.ports} onClick={() => {
            props.onChange({ ...props.ports, [newName]: { type: 'string' } });
            setNewName('');
          }}>＋ 新增 {props.side === 'inputs' ? '輸入' : '輸出'}</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- panel
export function PropertiesPanel(props: {
  node: WorkflowNode;
  def: NodeDefinition;
  registry: NodeRegistry;
  ports: ResolvedPorts | null;
  errors: Diagnostic[];
  connectedInputs: Set<string>;
  onChange: (wf: WorkflowNode) => void;
  onDelete: () => void;
  onOpenBody?: () => void;
}) {
  const { node, def, registry, ports } = props;
  const set = (patch: Partial<WorkflowNode>) => props.onChange({ ...node, ...patch });
  const sides = DYNAMIC_SIDES[node.type] ?? [];
  const overrides = def.output_overrides ?? [];
  const isAgent = def.kind === 'agent';

  return (
    <div data-testid="properties-panel" style={{ fontSize: 12 }}>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{node.label || node.id}</div>
        <div style={{ color: '#64748b' }}>
          <code>{node.type}</code> · {def.category ?? (isAgent ? 'Agent Nodes' : 'Builtin')} · {def.mode === 'data' ? 'data 節點（lazy）' : 'control 節點'}
        </div>
        {def.description && <div style={{ marginTop: 4, color: '#334155' }}>{def.description}</div>}
      </div>

      {props.errors.length > 0 && (
        <div style={{ ...section, background: '#fef2f2' }} data-testid="node-errors">
          <div style={{ ...h, color: '#b91c1c' }}>驗證錯誤（{props.errors.length}）</div>
          {props.errors.map((e, i) => <div key={i} style={{ color: '#b91c1c', marginBottom: 2 }}>[{e.code}] {e.message}</div>)}
        </div>
      )}

      <div style={section}>
        <div style={h}>基本</div>
        <label style={{ display: 'block', fontWeight: 600 }}>ID</label>
        <input style={{ ...inputStyle, background: '#f8fafc' }} value={node.id} readOnly />
        <label style={{ display: 'block', fontWeight: 600, marginTop: 6 }}>Label</label>
        <input data-field="label" style={inputStyle} value={node.label ?? ''} placeholder={node.id} onChange={(e) => set({ label: e.target.value || undefined })} />
      </div>

      {isAgent && (
        <div style={section} data-testid="agent-settings">
          <div style={h}>Agent 設定</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {POLICY.map(([k, label]) => {
                const v = def[k];
                if (v === undefined || (Array.isArray(v) && !v.length)) return null;
                return (
                  <tr key={k}>
                    <td style={{ ...td, width: 105, color: '#475569' }}>🔒 {label}</td>
                    <td style={{ ...td, whiteSpace: 'pre-wrap', fontFamily: Array.isArray(v) || k === 'prompt' ? 'ui-monospace, monospace' : undefined }}>{Array.isArray(v) ? v.join(', ') : String(v)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ color: '#64748b', margin: '4px 0 2px' }}>🔒 = 權限 / 模型由 Node Registry（{def.source ?? 'registry'}）決定，實例不可覆寫。以下欄位可依節點調整（instance_overridable）：</div>
        </div>
      )}

      {def.config_schema && (
        <div style={section} data-testid="config-form">
          <div style={h}>{isAgent ? '執行參數' : '設定'}</div>
          <SchemaForm schema={def.config_schema} value={node.config ?? {}} onChange={(v) => set({ config: v && Object.keys(v as object).length ? (v as Record<string, unknown>) : undefined })} />
        </div>
      )}

      {(sides.length > 0 || overrides.length > 0) && (
        <div style={section} data-testid="dynamic-ports">
          <div style={h}>動態 Ports</div>
          {sides.map((side) => (
            <div key={side} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, margin: '4px 0' }}>{side === 'inputs' ? '輸入' : '輸出'}{node.type === 'foreach' && side === 'outputs' ? '（每個元素的結果，會收集成陣列）' : ''}</div>
              <PortEditor side={side} registry={registry} ports={(node.ports?.[side] ?? {}) as Record<string, DataPortDef | JSONSchema>}
                fixedNames={node.type === 'foreach' && side === 'inputs' ? ['items'] : []}
                onChange={(p) => set({ ports: { ...node.ports, [side]: p } })} />
            </div>
          ))}
          {overrides.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, margin: '4px 0' }}>收窄輸出型別（output_overrides）</div>
              <PortEditor side="outputs" registry={registry} allowAdd={false} fixedNames={overrides}
                ports={Object.fromEntries(overrides.map((k) => [k, (node.ports?.outputs?.[k] ?? def.outputs[k]?.schema ?? {}) as JSONSchema]))}
                onChange={(p) => {
                  const outs: Record<string, DataPortDef | JSONSchema> = {};
                  for (const [k, v] of Object.entries(p)) if (JSON.stringify(asPort(v).schema) !== JSON.stringify(def.outputs[k]?.schema ?? {})) outs[k] = v;
                  const rest = { ...node.ports, outputs: Object.keys(outs).length ? outs : undefined };
                  set({ ports: rest.outputs || rest.inputs ? rest : undefined });
                }} />
            </div>
          )}
        </div>
      )}

      {ports && (
        <div style={section} data-testid="ports-table">
          <div style={h}>Ports（解析後）</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {ports.controlInputs.map((c) => <tr key={'ci' + c}><td style={td}>▶ in</td><td style={td}><b>{c}</b></td><td style={{ ...td, color: '#b45309' }}>control</td><td style={td} /></tr>)}
              {Object.entries(ports.inputs).map(([k, p]) => (
                <tr key={'i' + k}>
                  <td style={td}>● in</td>
                  <td style={td}><b>{k}</b>{p.required !== false && p.default === undefined ? <span style={{ color: '#dc2626' }}>*</span> : ''}</td>
                  <td style={{ ...td, color: '#1d4ed8' }}>{typeLabel(p.schema)}</td>
                  <td style={{ ...td, color: '#64748b' }}>{props.connectedInputs.has(k) ? '已連線' : node.inputs && k in node.inputs ? '常數' : p.default !== undefined ? '預設值' : '—'}</td>
                </tr>
              ))}
              {Object.entries(ports.outputs).map(([k, p]) => <tr key={'o' + k}><td style={td}>out ●</td><td style={td}><b>{k}</b></td><td style={{ ...td, color: '#1d4ed8' }}>{typeLabel(p.schema)}</td><td style={td} /></tr>)}
              {ports.controlOutputs.map((c) => <tr key={'co' + c}><td style={td}>out ▶</td><td style={td}><b>{c}</b></td><td style={{ ...td, color: '#b45309' }}>control</td><td style={td} /></tr>)}
            </tbody>
          </table>
          {Object.keys(ports.inputs).some((k) => !props.connectedInputs.has(k)) && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>常數輸入（未連線的 data 輸入）</summary>
              {Object.keys(ports.inputs).filter((k) => !props.connectedInputs.has(k)).map((k) => (
                <div key={k}>
                  <label style={{ display: 'block', fontWeight: 600, marginTop: 6 }}>{k}: {typeLabel(ports.inputs[k].schema)}</label>
                  <JsonField value={node.inputs?.[k]} onChange={(v) => {
                    const inputs = { ...(node.inputs ?? {}) };
                    if (v === undefined) delete inputs[k];
                    else inputs[k] = v;
                    set({ inputs: Object.keys(inputs).length ? inputs : undefined });
                  }} />
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      <div style={{ ...section, display: 'flex', gap: 6 }}>
        {props.onOpenBody && <button onClick={props.onOpenBody}>開啟 body 子圖</button>}
        {!['loop_in', 'loop_out'].includes(node.type) && <button style={{ color: '#b91c1c' }} onClick={props.onDelete}>刪除節點</button>}
      </div>
    </div>
  );
}
