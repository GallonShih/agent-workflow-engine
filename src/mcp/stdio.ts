/**
 * MCP server（stdio）。npm run mcp
 * - 預設在同一個 process 裡建立 backend（Fastify app，不開 port），runs 一樣寫到 <repo>/.runs（UI 執行紀錄看得到）
 * - WORKFLOW_BACKEND_URL=http://127.0.0.1:3001 → 改成呼叫已在跑的 backend（UI 可即時看到 MCP 啟動的 run）
 * 注意：stdout 是 MCP 通道，不能 console.log。
 */
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../server/app.js';
import { createMcpServer } from './server.js';
import { httpBackend, injectBackend } from './backend.js';

const root = path.resolve(import.meta.dirname, '../..');
const url = process.env.WORKFLOW_BACKEND_URL;
const backend = url
  ? httpBackend(url)
  : injectBackend(buildServer({ root, runsDir: process.env.WORKFLOW_RUNS_DIR, workflowsDir: process.env.WORKFLOW_DIR, mockDelayMs: Number(process.env.MOCK_DELAY_MS ?? 50), logger: false }));
await createMcpServer(backend).connect(new StdioServerTransport());
console.error(`agent-workflow MCP server ready (stdio, backend: ${url ?? 'in-process'})`);
