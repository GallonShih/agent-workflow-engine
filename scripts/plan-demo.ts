/** npm run plan -- "目標"：Phase 4 雛形，mock planner → compiler 閘門 → 修正 → 用 mock agents 執行 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../src/registry-fs.js';
import { mockPlanGenerator, planWorkflow } from '../src/planner.js';
import { runWorkflow } from '../src/engine.js';
import { demoRuntime } from '../src/demo/scenario.js';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const registry = loadRegistry(path.join(root, 'registry/builtin'), path.join(root, 'registry/agents'));
const template = JSON.parse(fs.readFileSync(path.join(root, 'workflows/fix-until-tests-pass.json'), 'utf8'));
const goal = process.argv.slice(2).filter((a) => a !== '--').join(' ') || '修正 parser 空字串 bug，測試失敗最多 3 次重試';

const res = await planWorkflow({ goal, registry, generate: mockPlanGenerator(template) });
for (const a of res.attempts) {
  console.log(`attempt ${a.attempt}: ${a.errors.length ? '❌' : '✅'} ${a.errors.length} errors`);
  for (const e of a.errors) console.log(`   [${e.code}] ${e.message}`);
}
if (!res.ok) process.exit(1);
const loop = res.workflow!.nodes.find((n) => n.type === 'loop');
console.log(`planner 產生 ${res.workflow!.nodes.length} 個節點；loop max_iterations=${loop?.config?.max_iterations}`);
const run = await runWorkflow(res.compiled!.graph!, { request: goal, repository: 'github.com/acme/parser' }, { runtime: demoRuntime({ passOnIteration: 2 }), workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-plan-workspace-')) });
console.log(`run ${run.run_id} → ${run.status.toUpperCase()}`);
