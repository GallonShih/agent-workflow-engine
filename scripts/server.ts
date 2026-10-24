import path from 'node:path';
import { buildServer } from '../src/server/app.js';
import { resolveRuntimeMode } from '../src/runtime/select.js';

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const root = path.resolve(import.meta.dirname, '..');
const port = Number(opt('port', process.env.PORT ?? '3001'));
const runtime = opt('runtime');
const app = buildServer({ root, runtime, mockDelayMs: Number(opt('mock-delay', '250')), staticDir: path.join(root, 'web/dist'), logger: false });
await app.listen({ port, host: opt('host', '127.0.0.1') });
const rt = resolveRuntimeMode(runtime);
console.log(`agent-workflow backend → http://127.0.0.1:${port}  (runtime: ${rt.mode} — ${rt.reason})`);
console.log('API: GET /api/registry · GET /api/workflows · POST /api/validate · POST /api/runs · GET /api/runs · GET /api/runs/:id · GET /api/runs/:id/events (SSE) · POST /api/runs/:id/resume · POST /api/runs/:id/cancel');
