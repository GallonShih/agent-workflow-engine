import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { NodeRegistry } from './registry.js';

/** 從一或多個目錄載入 *.yaml / *.json；types.yaml 先載入（具名型別） */
export function loadRegistry(...dirs: string[]): NodeRegistry {
  const reg = new NodeRegistry();
  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
    const parse = (f: string) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return f.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
    };
    const typesFile = files.find((f) => /^types\.(ya?ml|json)$/.test(f));
    if (typesFile) reg.addTypes(parse(typesFile));
    for (const f of files) if (f !== typesFile) reg.register(parse(f), path.join(dir, f));
  }
  return reg;
}
