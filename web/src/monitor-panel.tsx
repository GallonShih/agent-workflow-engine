import type { AgentEvent, NodeDefinition, Scope } from '../../src/types.js';
import type { RunMeta } from './api.js';
import { STATUS_COLOR } from './editor.js';
import { iterationsOf, recordsForNode, scopeKeyOf, type RecView, type RunView } from './monitor.js';

const section: React.CSSProperties = { borderTop: '1px solid #e2e8f0', padding: '8px 12px' };
const h: React.CSSProperties = { margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.04em', color: '#64748b' };
const pre: React.CSSProperties = { margin: 0, padding: 6, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 11, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

export function Badge({ status }: { status?: string }) {
  if (!status) return null;
  const color = STATUS_COLOR[status] ?? (status === 'cancelled' || status === 'interrupted' ? '#a855f7' : '#64748b');
  return <span data-status-badge={status} style={{ background: color, color: status === 'skipped' ? '#334155' : '#fff', borderRadius: 8, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>{status}</span>;
}

function agentEventLine(e: AgentEvent): string {
  switch (e.type) {
    case 'text-delta':
    case 'thinking':
      return e.content;
    case 'tool-use':
      return `${e.name}(${JSON.stringify(e.input).slice(0, 120)})`;
    case 'tool-result':
      return `${e.name} → ${e.result.slice(0, 160)}`;
    case 'complete':
      return e.result.slice(0, 200);
    case 'error':
      return e.message;
    case 'usage':
      return `in ${e.input_tokens} / out ${e.output_tokens}${e.num_turns ? ` · ${e.num_turns} turns` : ''}`;
    case 'run-start':
      return `${e.nodeName} #${e.runCount}`;
    case 'todo-list':
      return e.items.map((i) => `${i.completed ? '☑' : '☐'} ${i.text}`).join('  ');
  }
}

function RecordDetail({ r }: { r: RecView }) {
  const rows: [string, React.ReactNode][] = [
    ['Status', <Badge status={r.status} />],
    ['Key', <code>{r.key}</code>],
    ['Duration', r.duration_ms !== undefined ? `${r.duration_ms} ms` : r.status === 'running' && r.started_at ? `${Date.now() - r.started_at} ms（執行中）` : '—'],
    ['Tokens', r.token_usage ? `in ${r.token_usage.input_tokens} / out ${r.token_usage.output_tokens}` : '—'],
  ];
  if (r.attempts !== undefined) rows.push(['Attempts', String(r.attempts)]);
  if (r.runtime) rows.push(['Runtime', r.runtime]);
  if (r.resumed_from) rows.push(['Resumed', <>沿用 <code>{r.resumed_from}</code> 的結果</>]);
  if (r.fired?.length) rows.push(['Fired', r.fired.join(', ')]);
  if (r.reason) rows.push(['Skip 原因', r.reason]);
  return (
    <div data-testid="run-detail">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><td style={{ padding: '2px 4px', color: '#64748b', width: 80 }}>{k}</td><td style={{ padding: '2px 4px' }}>{v}</td></tr>
          ))}
        </tbody>
      </table>
      {r.error && <div style={{ marginTop: 6, color: '#b91c1c', whiteSpace: 'pre-wrap' }}>✗ {r.error}{r.handled ? '（已由 failure 分支處理）' : ''}</div>}
      {r.retries.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <b>Retries</b>
          {r.retries.map((x, i) => <div key={i} style={{ color: '#b45309' }}>↻ attempt {x.attempt}: {x.error}</div>)}
        </div>
      )}
      <div style={{ marginTop: 8 }}><b>Input</b><pre style={pre}>{r.inputs ? JSON.stringify(r.inputs, null, 2) : '—'}</pre></div>
      <div style={{ marginTop: 8 }}><b>Output</b><pre style={pre}>{r.outputs ? JSON.stringify(r.outputs, null, 2) : '—'}</pre></div>
      {r.logs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <b>Logs</b>
          {r.logs.map((l, i) => <div key={i} style={{ fontFamily: 'ui-monospace, monospace', color: l.level === 'error' ? '#b91c1c' : l.level === 'warn' ? '#b45309' : '#0f172a' }}>[{l.level}] {l.message}</div>)}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <b>Agent Events（{r.agentEvents.length}）</b>
        {r.agentEvents.length === 0 && <div style={{ color: '#94a3b8' }}>—</div>}
        {r.agentEvents.map((e, i) => (
          <div key={i} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, borderBottom: '1px dotted #e2e8f0', padding: '2px 0' }}>
            <span style={{ color: e.type === 'error' ? '#b91c1c' : '#7c3aed' }}>{e.type}</span> {agentEventLine(e)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function NodeRunPanel(props: {
  run: RunView;
  /** 目前畫布所在的 scope（已解析好每層 iteration） */
  scope: Scope;
  nodeId: string;
  def?: NodeDefinition;
  /** 切換最內層的 iteration */
  onIteration: (i: number) => void;
  /** composite / subflow 的某一輪 → drill-in 到畫布 */
  onOpenIteration?: (i: number) => void;
}) {
  const { run, scope, nodeId } = props;
  const recs = recordsForNode(run, scope, nodeId);
  const composite = props.def && ['loop', 'foreach', 'subflow'].includes(props.def.name);
  const iters = iterationsOf(run, scope, nodeId);
  if (run.status === 'idle') return <div style={{ padding: 12, color: '#64748b' }}>尚未執行。按上方「▶ 執行」，或從左側「執行紀錄」開啟一次歷史 run。</div>;
  const here = scope.length ? scope[scope.length - 1] : undefined;
  const current = here ? recs.find((r) => r.iteration === here.iteration) : recs[0];
  const where = scope.length ? scope.map((s) => `${s.loop}#${s.iteration}`).join(' › ') : '主流程';
  return (
    <div style={{ fontSize: 12 }} data-testid="node-run-panel">
      {here && (
        <div style={section}>
          <div style={h}>Iteration（{here.loop}{scope.length > 1 ? `，外層 ${scope.slice(0, -1).map((s) => `${s.loop}#${s.iteration}`).join(' › ')}` : ''}）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} data-testid="iteration-selector">
            {recs.map((r) => (
              <button key={r.key} data-iteration={r.iteration} onClick={() => props.onIteration(r.iteration ?? 0)}
                style={{ border: `2px solid ${STATUS_COLOR[r.status] ?? '#94a3b8'}`, background: r.iteration === here.iteration ? '#fef9c3' : '#fff', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                #{r.iteration} {r.status}
              </button>
            ))}
            {!recs.length && <span style={{ color: '#94a3b8' }}>此節點在這個外層輪次中沒有紀錄</span>}
          </div>
        </div>
      )}
      <div style={section}>
        <div style={h}>節點執行結果 · {nodeId} <span style={{ color: '#64748b', fontWeight: 400 }}>@ {where}</span></div>
        {current ? <RecordDetail r={current} /> : <div style={{ color: '#94a3b8' }}>沒有紀錄（可能尚未觸發）</div>}
      </div>
      {composite && iters.length > 0 && (
        <div style={section}>
          <div style={h}>{props.def?.name === 'subflow' ? '子流程執行' : `每一輪（${iters.length}）`}</div>
          {iters.map((i) => {
            const sk = scopeKeyOf([...scope, { loop: nodeId, iteration: i }]);
            const inner = [...run.records.values()].filter((r) => r.scopeKey === sk);
            const failed = inner.some((r) => r.status === 'failed' && !r.handled);
            const running = inner.some((r) => r.status === 'running');
            return (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                <Badge status={running ? 'running' : failed ? 'failed' : 'success'} />
                <span>{props.def?.name === 'subflow' ? '子流程' : `iteration #${i}`} · {inner.length} 個節點紀錄</span>
                {props.onOpenIteration && <button data-open-iteration={i} onClick={() => props.onOpenIteration!(i)}>在畫布檢視</button>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RunSummary({ run, metaStatus }: { run: RunView; metaStatus?: RunMeta['status'] }) {
  if (run.status === 'idle') return null;
  const status = run.status !== 'running' && (metaStatus === 'cancelled' || metaStatus === 'interrupted') ? metaStatus : run.status;
  const recs = [...run.records.values()];
  const count = (s: string) => recs.filter((r) => r.status === s).length;
  return (
    <div data-testid="run-summary" style={{ padding: '8px 12px', fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <Badge status={status} />
      <code>{run.run_id}</code>
      <span>{run.ended_at && run.started_at ? `${run.ended_at - run.started_at} ms` : '執行中…'}</span>
      <span>✓{count('success')} ✗{count('failed')} ○{count('skipped')}</span>
      <span>tokens {run.token_usage.input_tokens}/{run.token_usage.output_tokens}</span>
      <span>{run.eventCount} events</span>
    </div>
  );
}

export function RunHistory(props: { runs: RunMeta[] | null; activeId?: string; onOpen: (id: string) => void; onRefresh: () => void; backend: boolean }) {
  if (!props.backend) return <div style={{ padding: 12, color: '#64748b', fontSize: 12 }}>執行紀錄需要 backend（<code>npm run server</code>）。目前為瀏覽器內模式。</div>;
  return (
    <div style={{ fontSize: 12 }} data-testid="run-history">
      <div style={{ padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <b>.runs/ 歷史（{props.runs?.length ?? 0}）</b>
        <button onClick={props.onRefresh}>重新整理</button>
      </div>
      {props.runs?.map((r) => (
        <div key={r.run_id} data-run-id={r.run_id} onClick={() => props.onOpen(r.run_id)}
          style={{ padding: '6px 10px', borderTop: '1px solid #f1f5f9', cursor: 'pointer', background: r.run_id === props.activeId ? '#fef9c3' : undefined }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Badge status={r.status} />
            <code style={{ fontSize: 11 }}>{r.run_id}</code>
          </div>
          <div style={{ color: '#475569', marginTop: 2 }}>
            {r.workflow_name} · {new Date(r.started_at).toLocaleString()} · {r.duration_ms !== undefined ? `${r.duration_ms} ms` : '—'} · {r.source}/{r.runtime}
            {r.resumed_from && <> · resume 自 <code>{r.resumed_from}</code></>}
          </div>
        </div>
      ))}
    </div>
  );
}
