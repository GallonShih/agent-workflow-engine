import type { FastifyInstance } from 'fastify';

/**
 * MCP server 透過這個介面呼叫既有的 backend REST API（不重寫任何邏輯）：
 * - inject：同一個 process 內的 Fastify app（stdio 模式預設；run 紀錄一樣寫進 .runs，UI 的執行紀錄看得到）
 * - http：已經在跑的 backend（WORKFLOW_BACKEND_URL=http://127.0.0.1:3001）
 */
export interface Backend {
  request(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

export function injectBackend(app: FastifyInstance): Backend {
  return {
    async request(method, url, body) {
      const r = await app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
      let json: unknown;
      try {
        json = r.json();
      } catch {
        json = { error: r.body };
      }
      return { status: r.statusCode, json };
    },
  };
}

export function httpBackend(baseUrl: string): Backend {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async request(method, url, body) {
      const r = await fetch(base + url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text };
      }
      return { status: r.status, json };
    },
  };
}
