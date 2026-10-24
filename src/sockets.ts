import { ClassicPreset } from 'rete';
import type { JSONSchema } from './types.js';
import { isCompatible, typeLabel } from './schema.js';

/**
 * Rete socket 加上 JSON Schema。前端（rete-connection-plugin）與後端 compiler 用同一個
 * isCompatibleWith 判斷能不能連線（Rete 官方 Chatbot 範例的 socket 相容性作法）。
 */
export class TypedSocket extends ClassicPreset.Socket {
  constructor(public schema: JSONSchema) {
    super(typeLabel(schema));
  }
  isCompatibleWith(target: ClassicPreset.Socket): boolean {
    if (target instanceof ControlSocket) return false;
    if (!(target instanceof TypedSocket)) return false;
    return isCompatible(this.schema, target.schema).ok;
  }
}

/** Control port（success / failure / true / false / execute ...） */
export class ControlSocket extends ClassicPreset.Socket {
  constructor() {
    super('control');
  }
  isCompatibleWith(target: ClassicPreset.Socket): boolean {
    return target instanceof ControlSocket;
  }
}

export const controlSocket = new ControlSocket();
