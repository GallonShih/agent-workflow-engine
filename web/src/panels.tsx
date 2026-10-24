import type { CompileResult } from '../../src/compiler.js';
import type { NodeRegistry } from '../../src/registry.js';

export type Tab<T extends string> = [T, string];
export function Tabs<T extends string>(props: { tabs: Tab<T>[]; value: T; onChange: (t: T) => void }) {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', background: '#f8fafc' }}>
      {props.tabs.map(([k, label]) => (
        <button key={k} data-tab={k} onClick={() => props.onChange(k)}
          style={{ flex: 1, padding: '8px 6px', border: 0, borderBottom: props.value === k ? '3px solid #2563eb' : '3px solid transparent', background: 'transparent', fontWeight: props.value === k ? 700 : 400, cursor: 'pointer' }}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** 左側節點庫（分類後的節點名稱） */
export function NodeLibrary(props: { groups: [string, string[]][]; registry: NodeRegistry; onAdd: (name: string) => void }) {
  return (
              <div style={{ padding: 8, fontSize: 12 }} data-testid="node-library">
                {props.groups.map(([cat, names]) => (
                  <div key={cat} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, color: '#475569', margin: '4px 0' }}>{cat}</div>
                    {names.map((name) => (
                      <div key={name} data-library-item={name} title={props.registry.get(name)?.description} onClick={() => props.onAdd(name)}
                        style={{ padding: '4px 8px', margin: '2px 0', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', background: '#fff' }}>
                        {name}
                      </div>
                    ))}
                  </div>
                ))}
                <div style={{ color: '#94a3b8' }}>點一下加入目前畫面</div>
              </div>
  );
}

/** 下方 Diagnostics：錯誤（含修正建議）與警告；點錯誤會選取該節點 */
export function DiagnosticsList({ diag, onSelect }: { diag: CompileResult | null; onSelect: (nodeId: string) => void }) {
  return (
                <div data-testid="diagnostics">
                  {diag?.errors.map((d, i) => (
                    <div key={i} style={{ color: '#b91c1c', cursor: d.node ? 'pointer' : undefined, marginBottom: 2 }} onClick={() => d.node && onSelect(d.node.split('/').pop()!)}>
                      [{d.code}] {d.message}
                      {d.fix && <div style={{ color: '#475569', paddingLeft: 14 }}>↳ {d.fix}</div>}
                    </div>
                  ))}
                  {diag?.warnings.map((d, i) => <div key={i} style={{ color: '#92400e' }}>[{d.code}] {d.message}</div>)}
                  {diag && !diag.errors.length && <div style={{ color: '#15803d' }}>沒有錯誤（每次修改都會用同一份 compileWorkflow 重新驗證）</div>}
                </div>
  );
}
