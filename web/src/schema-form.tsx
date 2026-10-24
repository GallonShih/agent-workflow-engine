import { useEffect, useState } from 'react';
import type { JSONSchema } from '../../src/types.js';

/**
 * 依 registry 的 config_schema（JSON Schema）遞迴產生表單：
 * enum → select、boolean → checkbox、number / integer、string（format: textarea → 多行）、
 * 有 properties 的 object → fieldset、array → 可增刪的列表、其他（any / 無 properties 的 object）→ JSON 編輯。
 */
type S = JSONSchema & {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, S>;
  required?: string[];
  items?: S;
  title?: string;
  description?: string;
  format?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  examples?: unknown[];
};

export const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 12, fontFamily: 'inherit', background: '#fff' };
const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 600, margin: '8px 0 3px', color: '#334155' };

export function defaultFor(schema: S): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'string': return '';
    case 'number':
    case 'integer': return schema.minimum ?? 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const k of schema.required ?? []) if (schema.properties?.[k]) o[k] = defaultFor(schema.properties[k]);
      return o;
    }
    default: return null;
  }
}

/** 任意值的 JSON 編輯器：失焦時解析；不是合法 JSON 就當字串 */
export function JsonField(props: { value: unknown; onChange: (v: unknown) => void; readOnly?: boolean; rows?: number; strict?: boolean; testId?: string }) {
  const fmt = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));
  const [text, setText] = useState(fmt(props.value));
  const [err, setErr] = useState('');
  useEffect(() => setText(fmt(props.value)), [JSON.stringify(props.value)]);
  return (
    <div>
      <textarea
        data-testid={props.testId}
        style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', minHeight: (props.rows ?? 3) * 16 }}
        value={text}
        readOnly={props.readOnly}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() === '') return (setErr(''), props.onChange(undefined));
          try {
            props.onChange(JSON.parse(text));
            setErr('');
          } catch (e) {
            if (props.strict) setErr(`JSON 格式錯誤：${(e as Error).message}`);
            else (props.onChange(text), setErr(''));
          }
        }}
      />
      {err && <div style={{ color: '#b91c1c' }}>{err}</div>}
    </div>
  );
}

export function SchemaForm(props: { schema: S; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean; path?: string; label?: string; required?: boolean }) {
  const { schema: s, value, onChange, readOnly } = props;
  const path = props.path ?? 'config';
  const title = props.label ?? s.title;
  const label = title ? (
    <label style={labelStyle} title={s.description}>
      {title}
      {props.required && <span style={{ color: '#dc2626' }}> *</span>}
      {path !== 'config' && <span style={{ color: '#94a3b8', fontWeight: 400 }}>  {path.replace(/^config\./, '')}</span>}
    </label>
  ) : null;
  const t = Array.isArray(s.type) ? s.type[0] : s.type;

  if (s.enum) {
    return (
      <div>
        {label}
        <select data-field={path} style={inputStyle} disabled={readOnly} value={value === undefined ? '' : JSON.stringify(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : JSON.parse(e.target.value))}>
          {!props.required && <option value="">（預設{s.default !== undefined ? `：${String(s.default)}` : ''}）</option>}
          {s.enum.map((o) => <option key={JSON.stringify(o)} value={JSON.stringify(o)}>{String(o)}</option>)}
        </select>
      </div>
    );
  }
  if (t === 'boolean') {
    return (
      <label style={{ ...labelStyle, display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
        <input data-field={path} type="checkbox" disabled={readOnly} checked={value === undefined ? !!s.default : !!value} onChange={(e) => onChange(e.target.checked)} />
        {title ?? path}
      </label>
    );
  }
  if (t === 'number' || t === 'integer') {
    return (
      <div>
        {label}
        <input data-field={path} style={inputStyle} type="number" readOnly={readOnly} step={t === 'integer' ? 1 : 'any'} min={s.minimum} max={s.maximum}
          placeholder={s.default !== undefined ? `預設 ${s.default}` : ''} value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : t === 'integer' ? parseInt(e.target.value, 10) : Number(e.target.value))} />
      </div>
    );
  }
  if (t === 'string') {
    const common = { 'data-field': path, style: inputStyle, readOnly, value: (value as string) ?? '', placeholder: s.examples?.length ? `例：${String(s.examples[0])}` : '', onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
    return (
      <div>
        {label}
        {s.format === 'textarea' ? <textarea {...common} style={{ ...inputStyle, minHeight: 70, fontFamily: 'ui-monospace, monospace' }} /> : <input {...common} />}
      </div>
    );
  }
  if (t === 'object' && s.properties) {
    const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const set = (k: string, v: unknown) => {
      const next = { ...obj };
      if (v === undefined) delete next[k];
      else next[k] = v;
      onChange(next);
    };
    const inner = Object.entries(s.properties).map(([k, ps]) => (
      <SchemaForm key={k} schema={ps} value={obj[k]} readOnly={readOnly} path={`${path}.${k}`} label={ps.title ?? k} required={s.required?.includes(k)} onChange={(v) => set(k, v)} />
    ));
    if (path === 'config') return <div>{inner}</div>;
    return (
      <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '2px 8px 8px', margin: '8px 0' }}>
        <legend style={{ fontWeight: 600, color: '#334155' }}>{title ?? path}</legend>
        {inner}
      </fieldset>
    );
  }
  if (t === 'array' && s.items && (s.items.type || s.items.enum)) {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div>
        {label}
        {arr.map((item, i) => (
          <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-start', borderLeft: '3px solid #e2e8f0', paddingLeft: 6, marginBottom: 4 }}>
            <div style={{ flex: 1 }}>
              <SchemaForm schema={s.items!} value={item} readOnly={readOnly} path={`${path}[${i}]`} label={s.items!.properties ? `#${i + 1}` : undefined} onChange={(v) => onChange(arr.map((x, j) => (j === i ? v : x)))} />
            </div>
            {!readOnly && <button title="移除" onClick={() => onChange(arr.filter((_, j) => j !== i))} style={{ marginTop: s.items!.properties ? 14 : 2 }}>✕</button>}
          </div>
        ))}
        {!readOnly && <button data-add={path} onClick={() => onChange([...arr, defaultFor(s.items!)])}>＋ 新增</button>}
      </div>
    );
  }
  return (
    <div>
      {label ?? <label style={labelStyle}>{path}</label>}
      <JsonField value={value} onChange={onChange} readOnly={readOnly} strict={t === 'object' || t === 'array'} rows={t === 'object' ? 5 : 2} />
    </div>
  );
}
