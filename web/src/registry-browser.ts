import YAML from 'yaml';
import { NodeRegistry } from '../../src/registry.js';

/** 瀏覽器端：Vite 把 registry/*.yaml 以字串打包進來，再用同一個 NodeRegistry 註冊 */
const files = import.meta.glob('../../registry/**/*.{yaml,yml,json}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function loadBrowserRegistry(): NodeRegistry {
  const reg = new NodeRegistry();
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const parse = (p: string, t: string) => (p.endsWith('.json') ? JSON.parse(t) : YAML.parse(t));
  for (const [p, t] of entries) if (/\/types\.(ya?ml|json)$/.test(p)) reg.addTypes(parse(p, t));
  for (const [p, t] of entries) if (!/\/types\.(ya?ml|json)$/.test(p)) reg.register(parse(p, t), p.replace('../../', ''));
  return reg;
}
