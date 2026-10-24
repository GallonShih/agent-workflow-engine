import { Ajv, type ValidateFunction } from 'ajv';
import type { JSONSchema } from './types.js';

/** 共用 Ajv 實例：驗證 schema 本身、常數輸入、Agent 輸出與 port 執行期的值 */
export const ajv = new Ajv({ allErrors: true, strict: false });
// UI 提示用的 format（屬性面板顯示多行輸入），驗證時一律通過
ajv.addFormat('textarea', true);

const cache = new WeakMap<object, ValidateFunction>();

export function compileSchema(schema: JSONSchema): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  return fn;
}

export function assertValidSchema(schema: JSONSchema, where: string): void {
  try {
    compileSchema(schema);
  } catch (e) {
    throw new Error(`${where}: invalid JSON Schema (${(e as Error).message})`);
  }
}

export function validateValue(schema: JSONSchema, value: unknown): { ok: true } | { ok: false; errors: string } {
  const fn = compileSchema(schema);
  if (fn(value)) return { ok: true };
  return { ok: false, errors: ajv.errorsText(fn.errors) };
}

/** 給 UI / log 用的簡短型別名稱，例如 Task[]、string、{passed,issues} */
export function typeLabel(s: JSONSchema | undefined): string {
  if (!s || Object.keys(s).length === 0) return 'any';
  if (typeof s.title === 'string') return s.title;
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join('|');
  if (Array.isArray(s.anyOf)) return (s.anyOf as JSONSchema[]).map(typeLabel).join('|');
  const t = s.type;
  if (t === 'array') return `${typeLabel(s.items as JSONSchema)}[]`;
  if (t === 'object' && s.properties) return `{${Object.keys(s.properties as object).join(',')}}`;
  if (Array.isArray(t)) return t.join('|');
  return String(t ?? 'any');
}

function typesOf(s: JSONSchema): string[] | null {
  if (s.type === undefined) {
    if (s.const !== undefined) return [jsonType(s.const)];
    if (Array.isArray(s.enum)) return [...new Set(s.enum.map(jsonType))];
    return null; // 不限型別
  }
  return Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

/**
 * 結構化的 JSON Schema 相容性檢查：source 輸出的任何值，是否一定能通過 target 輸入的 schema。
 * 支援 PoC 需要的子集：type / integer⊂number / enum / const / array.items /
 * object.properties+required / anyOf / oneOf。未知關鍵字採保守策略（可能被拒絕）。
 * 另外若 source 宣告 examples，會再用 Ajv 實際驗證一次 examples 是否符合 target。
 */
export function isCompatible(source: JSONSchema, target: JSONSchema, path = '$'): { ok: true } | { ok: false; reason: string } {
  const res = compat(source, target, path);
  if (!res.ok) return res;
  if (Array.isArray(source.examples)) {
    for (const ex of source.examples) {
      const v = validateValue(target, ex);
      if (!v.ok) return { ok: false, reason: `${path}: example ${JSON.stringify(ex)} rejected by target (${v.errors})` };
    }
  }
  return res;
}

function compat(s: JSONSchema, t: JSONSchema, path: string): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason: `${path}: ${reason}` });
  if (!t || Object.keys(t).filter((k) => !['title', 'description', 'examples', 'default'].includes(k)).length === 0) {
    return { ok: true }; // target 接受任何值
  }
  // source 是聯集：每個分支都要相容
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[key])) {
      for (const [i, br] of (s[key] as JSONSchema[]).entries()) {
        const r = compat(br, t, `${path}<${key}${i}>`);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
  }
  // target 是聯集：任一分支相容即可
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(t[key])) {
      const reasons: string[] = [];
      for (const br of t[key] as JSONSchema[]) {
        const r = compat(s, br, path);
        if (r.ok) return r;
        reasons.push(r.reason);
      }
      return fail(`no ${key} branch matches (${reasons.join('; ')})`);
    }
  }
  // enum / const
  const tEnum = t.const !== undefined ? [t.const] : (t.enum as unknown[] | undefined);
  if (tEnum) {
    const sEnum = s.const !== undefined ? [s.const] : (s.enum as unknown[] | undefined);
    if (!sEnum) return fail(`target only accepts ${JSON.stringify(tEnum)}`);
    const missing = sEnum.filter((v) => !tEnum.some((x) => JSON.stringify(x) === JSON.stringify(v)));
    if (missing.length) return fail(`values ${JSON.stringify(missing)} not accepted by target enum`);
    return { ok: true };
  }
  const st = typesOf(s);
  const tt = typesOf(t);
  if (tt) {
    if (!st) return fail(`source is untyped (any) but target requires ${tt.join('|')}`);
    for (const x of st) {
      const okType = tt.includes(x) || (x === 'integer' && tt.includes('number'));
      if (!okType) return fail(`type ${x} is not assignable to ${tt.join('|')}`);
    }
  }
  const sType = st?.length === 1 ? st[0] : undefined;
  if (sType === 'array' && t.items) {
    if (!s.items) return fail('source array items are untyped');
    const r = compat(s.items as JSONSchema, t.items as JSONSchema, `${path}[]`);
    if (!r.ok) return r;
  }
  if (sType === 'object' && (t.properties || t.required)) {
    const sProps = (s.properties ?? {}) as Record<string, JSONSchema>;
    const tProps = (t.properties ?? {}) as Record<string, JSONSchema>;
    const sReq = new Set((s.required ?? []) as string[]);
    for (const req of (t.required ?? []) as string[]) {
      if (!sReq.has(req)) return fail(`target requires property "${req}" which source does not guarantee`);
    }
    for (const [k, tp] of Object.entries(tProps)) {
      if (sProps[k]) {
        const r = compat(sProps[k], tp, `${path}.${k}`);
        if (!r.ok) return r;
      }
    }
  }
  return { ok: true };
}
