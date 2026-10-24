import type { Rule } from './types.js';

export const RULE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsy', 'contains', 'is_empty', 'not_empty'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

/** Condition / Switch / Filter / Loop until 共用的規則求值 */
export function evalRule(rule: Rule, input: unknown): boolean {
  let v: unknown = input;
  if (rule.path) for (const p of rule.path.split('.')) v = v == null ? undefined : (v as Record<string, unknown>)[p];
  const x = rule.value;
  switch (rule.op) {
    case 'eq': return JSON.stringify(v) === JSON.stringify(x);
    case 'neq': return JSON.stringify(v) !== JSON.stringify(x);
    case 'gt': return Number(v) > Number(x);
    case 'gte': return Number(v) >= Number(x);
    case 'lt': return Number(v) < Number(x);
    case 'lte': return Number(v) <= Number(x);
    case 'truthy': return Boolean(v);
    case 'falsy': return !v;
    case 'contains': return Array.isArray(v) ? v.some((i) => JSON.stringify(i) === JSON.stringify(x)) : String(v ?? '').includes(String(x));
    case 'is_empty': return v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' ? Object.keys(v as object).length === 0 : String(v).trim() === '');
    case 'not_empty': return !evalRule({ ...rule, op: 'is_empty', path: undefined }, v);
  }
}
