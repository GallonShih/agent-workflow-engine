import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../src/registry-fs.js';
import { compileWorkflow, runWorkflow, makeRuntimeSelector, scopeKey, type RunEvent } from '../src/index.js';
import { demoRuntime } from '../src/demo/scenario.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, d: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };

const root = path.resolve(import.meta.dirname, '..');
const wfFile = opt('workflow', path.join(root, 'workflows/fix-until-tests-pass.json'));
const scenario = opt('scenario', 'pass'); // pass | fail
const registry = loadRegistry(path.join(root, 'registry/builtin'), path.join(root, 'registry/agents'));
const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));

const compiled = compileWorkflow(wf, registry);
for (const w of compiled.warnings) console.log(`  ⚠ ${w.code}: ${w.message}`);
if (!compiled.ok) {
  for (const e of compiled.errors) console.log(`  ✗ ${e.code}: ${e.message}`);
  process.exit(1);
}
console.log(`✓ compiled "${wf.name}" — ${compiled.graph!.nodes.size} nodes, ${compiled.graph!.edges.length} edges (Node Registry: ${registry.list().length} definitions)`);

const mock = demoRuntime({ passOnIteration: scenario === 'fail' ? null : Number(opt('pass-on', '2')), flakyCoder: !flag('no-flaky') });
const selectRuntime = makeRuntimeSelector(mock, { forceMock: flag('mock') });
console.log(`runtime: ${process.env.ANTHROPIC_API_KEY && !flag('mock') ? 'claude_agent_sdk（有 ANTHROPIC_API_KEY）' : 'mock（沒有 ANTHROPIC_API_KEY 或 --mock）'}，scenario=${scenario}\n`);

const t0 = Date.now();
const indent = (e: RunEvent) => '  '.repeat((e.scope?.length ?? 0) + 1);
const where = (e: RunEvent) => `${e.scope?.length ? scopeKey(e.scope) + '/' : ''}${e.node_id}`;
const onEvent = (e: RunEvent) => {
  const t = String(e.ts - t0).padStart(4) + 'ms';
  const d = e.data ?? {};
  switch (e.type) {
    case 'node_started': return console.log(`${t}${indent(e)}▶ ${where(e)}`);
    case 'node_succeeded': {
      const u = d.token_usage as { input_tokens: number; output_tokens: number } | undefined;
      return console.log(`${t}${indent(e)}✓ ${where(e)} → fired [${(d.fired as string[]).join(',')}]${u ? `  tokens ${u.input_tokens}/${u.output_tokens}` : ''}${(d.attempts as number) > 1 ? `  attempts=${d.attempts}` : ''}  ${d.duration_ms}ms`);
    }
    case 'node_failed': return console.log(`${t}${indent(e)}✗ ${where(e)}: ${d.error}${d.handled ? ' (→ failure port)' : ''}`);
    case 'node_skipped': return console.log(`${t}${indent(e)}○ ${where(e)} skipped (${d.reason})`);
    case 'node_retry': return console.log(`${t}${indent(e)}↻ ${where(e)} retry after attempt ${d.attempt}: ${d.error}`);
    case 'loop_iteration_started': return console.log(`${t}${indent(e)}⟳ ${e.node_id} iteration ${d.iteration}${(d.carry as { feedback?: string[] })?.feedback ? `  carry.feedback=${JSON.stringify((d.carry as { feedback?: string[] }).feedback)}` : ''}`);
    case 'loop_iteration_completed': return console.log(`${t}${indent(e)}⟲ ${e.node_id} iteration ${d.iteration} → passed=${(d.outputs as { passed?: boolean })?.passed}`);
  }
};

const result = await runWorkflow(compiled.graph!, { request: '修正 parser 空字串 bug 並讓測試通過', repository: 'github.com/acme/parser' }, { runtime: mock, selectRuntime, onEvent });

console.log(`\nRUN ${result.run_id}: ${result.status.toUpperCase()}  (${result.duration_ms}ms, tokens in/out ${result.token_usage.input_tokens}/${result.token_usage.output_tokens})\n`);
console.log('key (run_id/scope/node_id)'.padEnd(44) + 'status    runtime  attempts');
for (const r of result.records) console.log(`${r.key.padEnd(44)}${r.status.padEnd(10)}${(r.runtime ?? '').padEnd(9)}${r.attempts ?? ''}`);

const outDir = path.join(root, '.runs');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${result.run_id}.events.jsonl`), result.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, `${result.run_id}.records.json`), JSON.stringify(result.records, null, 2));
console.log(`\nevents → .runs/${result.run_id}.events.jsonl  records → .runs/${result.run_id}.records.json`);
process.exitCode = result.status === (scenario === 'fail' ? 'failed' : 'success') ? 0 : 1;
