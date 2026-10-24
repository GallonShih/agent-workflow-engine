/**
 * npm run validate -- <workflow.json> [...] [--advanced]
 * 用 Node Registry + compiler 檢查 workflow JSON（與前端「驗證」按鈕同一份 compileWorkflow）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../src/registry-fs.js';
import { compileWorkflow } from '../src/compiler.js';

const root = path.resolve(import.meta.dirname, '..');
const registry = loadRegistry(path.join(root, 'registry/builtin'), path.join(root, 'registry/agents'));
const advanced = process.argv.includes('--advanced');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) files.push(path.join(root, 'workflows/fix-until-tests-pass.json'));
let bad = 0;
for (const f of files) {
  const r = compileWorkflow(JSON.parse(fs.readFileSync(f, 'utf8')), registry, { advanced });
  console.log(`\n${r.ok ? '✅' : '❌'} ${path.relative(process.cwd(), f)}  (${r.errors.length} errors, ${r.warnings.length} warnings)`);
  for (const e of r.errors) console.log(`  error   [${e.code}] ${e.message}${e.fix ? `\n          ↳ fix: ${e.fix}` : ''}`);
  for (const w of r.warnings) console.log(`  warning [${w.code}] ${w.message}`);
  if (!r.ok) bad++;
}
process.exitCode = bad ? 1 : 0;
