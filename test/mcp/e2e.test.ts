import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpE2E, stdioTransport } from '../../scripts/mcp-demo.js';
import { root } from '../helpers.js';

describe('MCP end-to-end over stdio (official SDK client → npm run mcp)', () => {
  it('list nodes → broken workflow → errors with fixes → fix → save → run (mock agents) → poll get_run until success', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));
    const wfDir = path.join(tmp, 'workflows');
    fs.cpSync(path.join(root, 'workflows'), wfDir, { recursive: true });
    const client = new Client({ name: 'e2e', version: '1' });
    const workspace = path.join(tmp, 'ws');
    fs.mkdirSync(workspace);
    const transport = stdioTransport({ WORKFLOW_DIR: wfDir, WORKFLOW_RUNS_DIR: path.join(tmp, 'runs'), MOCK_DELAY_MS: '1', WORKSPACE_ROOTS: workspace });
    await client.connect(transport);
    const steps: string[] = [];
    try {
      const r = await mcpE2E(client, (s) => steps.push(s), workspace);
      expect(r.tools.tools).toHaveLength(9);
      expect(r.bad.ok).toBe(false);
      expect(r.bad.errors.map((e: { code: string }) => e.code)).toEqual(expect.arrayContaining(['POLICY_OVERRIDE', 'UNKNOWN_PORT', 'TYPE_MISMATCH', 'END_UNCONNECTED', 'INVALID_CONFIG']));
      expect(r.bad.errors.every((e: { fix?: string }) => !!e.fix)).toBe(true);
      expect(r.rejected.isError).toBe(true);
      expect(r.good.ok).toBe(true);
      expect(r.saved.json.ok).toBe(true);
      expect(fs.existsSync(path.join(wfDir, 'mcp-demo.json'))).toBe(true);
      expect(r.run.status).toBe('success');
      expect(r.run.ended_at).toEqual(['end_ok']);
      // run 紀錄寫進 runs 資料夾（UI 的執行紀錄看得到）
      expect(fs.readdirSync(path.join(tmp, 'runs')).some((f) => f.startsWith(r.started.run_id))).toBe(true);
      expect(steps[0]).toBe('tools/list');
      // 沒給 workspace：WORKSPACE_REQUIRED + fix；有給：get_run 列出 mock coding agent 寫的檔案
      expect(r.noWs.isError).toBe(true);
      expect(r.noWs.json.errors[0]).toMatchObject({ code: 'WORKSPACE_REQUIRED', fix: expect.stringContaining('WORKSPACE_ROOTS') });
      expect(r.run.workspace.path).toBe(fs.realpathSync(workspace));
      expect(r.run.workspace.changed_files.map((c: { path: string }) => c.path)).toEqual(['agent-workflow-demo/CHANGELOG.md', 'agent-workflow-demo/iteration-0.md', 'agent-workflow-demo/iteration-1.md']);
    } finally {
      await client.close();
    }
  }, 30_000);
});
