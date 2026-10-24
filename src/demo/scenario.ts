import { MockAgentRuntime } from '../runtime/mock.js';

export interface ScenarioOptions {
  /** 第幾輪（0-based iteration）測試會通過；null = 永遠不通過 */
  passOnIteration: number | null;
  /** coding agent 在第 0 輪第 1 次嘗試會丟錯，用來展示 retry policy */
  flakyCoder?: boolean;
  delayMs?: number;
}

/**
 * Demo 用的確定性 mock agents。
 * coder 每一輪輸出帶有 iteration 標記的檔名；tester 檢查自己拿到的是「這一輪」的檔案，
 * 若讀到上一輪的舊資料就直接報錯 —— 用來證明 per-iteration context 沒有 stale data。
 */
export function demoRuntime(opts: ScenarioOptions): MockAgentRuntime {
  return new MockAgentRuntime(
    {
      planning_agent: ({ inputs }) => ({
        plan: `針對「${inputs.request}」：先重現錯誤，再修正 parser，最後補測試`,
        tasks: [
          { id: 'T1', title: '修正 parser 的空字串處理', files: ['src/parser.ts'] },
          { id: 'T2', title: '補上回歸測試', files: ['test/parser.test.ts'] },
        ],
        acceptance_criteria: ['空字串回傳 []', '既有測試全部通過'],
      }),
      coding_agent: ({ inputs, iteration, attempt }) => {
        if (opts.flakyCoder && iteration === 0 && attempt === 1) throw new Error('mock: transient tool error (rate limited)');
        const feedback = (inputs.feedback as string[]) ?? [];
        return {
          files_modified: [`src/parser.ts@iter${iteration}`, `test/parser.test.ts@iter${iteration}`],
          summary: feedback.length ? `依回饋修正：${feedback.join('；')}` : '初版修改 parser 與測試',
        };
      },
      testing_agent: ({ inputs, iteration }) => {
        const files = inputs.files_modified as string[];
        if (!files.every((f) => f.endsWith(`@iter${iteration}`))) throw new Error(`stale data: iteration ${iteration} got ${files.join(',')}`);
        const passed = opts.passOnIteration !== null && (iteration ?? 0) >= opts.passOnIteration;
        return {
          passed,
          failures: passed ? [] : [`iter${iteration}: parser.test.ts > 空字串應回傳 [] 失敗`],
          report: passed ? `iter${iteration}: 12/12 passed` : `iter${iteration}: 11/12 passed`,
        };
      },
      risk_review_agent: () => ({
        issues: [{ severity: 'low', message: 'parser 修改未影響公開 API' }],
        risk_level: 'low',
      }),
      report_agent: ({ inputs }) => ({ report: `# 交付報告\n${inputs.headline}\n計畫：${inputs.plan}` }),
    },
    opts.delayMs ?? 0,
  );
}
