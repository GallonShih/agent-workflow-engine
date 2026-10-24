/**
 * 舊版 workflow JSON（data + control edges）→ v1。
 *   npm run convert -- workflows/old.json            # 印到 stdout
 *   npm run convert -- workflows/old.json --write    # 覆寫原檔
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../src/registry-fs.js';
import { convertToV1 } from '../src/convert.js';
import { compileWorkflow } from '../src/compiler.js';

const root = path.resolve(import.meta.dirname, '..');
const registry = loadRegistry(path.join(root, 'registry/builtin'), path.join(root, 'registry/agents'));
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const write = process.argv.includes('--write');
if (!files.length) {
  console.error('usage: npm run convert -- <workflow.json> [--write]');
  process.exit(2);
}
let failed = false;
for (const f of files) {
  const { workflow, notes } = convertToV1(JSON.parse(fs.readFileSync(f, 'utf8')), registry);
  const v1 = compileWorkflow(workflow, registry);
  const adv = v1.ok ? v1 : compileWorkflow(workflow, registry, { advanced: true });
  console.error(`# ${f}: ${v1.ok ? 'valid v1' : adv.ok ? 'valid with advanced features' : 'INVALID'}`);
  for (const n of notes) console.error(`  - ${n}`);
  if (!adv.ok) {
    failed = true;
    for (const e of adv.errors) console.error(`  ✗ ${e.code} ${e.message}`);
  }
  const text = JSON.stringify(workflow, null, 2) + '\n';
  if (write) fs.writeFileSync(f, text);
  else process.stdout.write(text);
}
process.exit(failed ? 1 : 0);
