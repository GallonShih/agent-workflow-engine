/**
 * 進階功能測試共用：舊版 hybrid 格式（control edges）、join / foreach / subflow / 巢狀 loop / resume / planner。
 * 這些功能在 v1 預設關閉，這裡一律以 advanced: true 編譯與執行。
 */
import { compileWorkflow as compileRaw, type CompileOptions } from '../../src/compiler.js';
import { runWorkflow as runRaw, type RunOptions } from '../../src/engine.js';
import type { NodeRegistry } from '../../src/registry.js';
import type { CompiledGraph } from '../../src/compiler.js';

export const compileWorkflow = (raw: unknown, registry: NodeRegistry, opts: CompileOptions = {}) => compileRaw(raw, registry, { advanced: true, ...opts });
export const runWorkflow = (graph: CompiledGraph, inputs: Record<string, unknown>, opts: RunOptions) => runRaw(graph, inputs, { advanced: true, ...opts });
