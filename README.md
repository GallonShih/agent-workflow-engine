# Agent Workflow PoC（Rete.js + 薄 TypeScript 後端）

類 ComfyUI 的多 Agent workflow 平台 PoC。**底座是 Rete.js 官方套件**（`rete`、`rete-engine` 的 DataflowEngine / ControlFlowEngine、`rete-area-plugin` / `rete-connection-plugin` / `rete-react-plugin` / `rete-auto-arrange-plugin`），
Claude 執行層沿用 **Circuit** 的 `ClaudeAgent` adapter 與 `{{ }}` reference 插值（Apache-2.0，見 `src/vendor/circuit/`）。
自己寫的只有「膠水層」：registry/compiler、hybrid 排程語意、loop composite、監控紀錄。

> 未使用 Langflow；未 fork Circuit（只 vendor 兩個檔案並標註 patch）。

## 快速開始

```bash
npm install
npm test                 # vitest：4 個檔案 30 個測試
npm run typecheck        # tsc strict
npm run demo             # planning → coding → testing → condition → 重試 (<3 輪) ，mock agents，第 3 輪通過
npm run demo -- --scenario fail --no-flaky   # 3 輪都失敗 → loop exhausted → FAILED 路徑
npm run demo -- --pass-on 0                  # 第 1 輪就通過（提早結束）
npm run validate -- workflows/invalid-example.json   # compiler 列出 14 個錯誤
npm run plan             # Phase 4 雛形：mock planner → compiler 擋下 → 修正 → 執行

cd web && npm install && npm run dev   # Phase 1 前端 Rete editor（http://localhost:5173）
npm run web:build                      # 或在根目錄 build 前端
```

Demo 每次執行會寫出 `.runs/<run_id>.events.jsonl` 與 `.runs/<run_id>.records.json`（key = `run_id/scope/node_id`，例如 `run_x/fix_loop#1/coder`）。

有設定 `ANTHROPIC_API_KEY` 且沒加 `--mock` 時，`runtime: claude_agent_sdk` 的節點會改走真的 Claude Agent SDK（**尚未用真 key 驗證過**，目前只有 fake query 的單元測試）。

## 架構

```
registry/*.yaml ──► NodeRegistry ──► compileWorkflow (Ajv 型別檢查 / policy / cycle / loop body)
                                         │
workflow JSON ◄── Rete editor (web/) ────┘ 同一份 compiler、同一個 TypedSocket.isCompatibleWith
                                         ▼
                         GraphRun（每層 / 每輪各一個 Rete NodeEditor）
                         ├─ ControlFlowEngine：只看 control ports（誰被觸發）
                         ├─ DataflowEngine：只看 data ports（pull 輸入）
                         └─ glue：等上游 settle、dead-path skip、join all/any、loop composite、retry/timeout
                                         ▼
                         AgentRuntime：MockAgentRuntime | ClaudeAgentRuntime（Circuit ClaudeAgent）
```

### 四個架構問題的決定

| 問題 | 決定 |
|---|---|
| data edge 會觸發執行嗎？ | **不會。** 只有 control edge 觸發；data edge 只在節點被觸發後 pull（Rete 官方 hybrid engine 作法）。 |
| 多輸入什麼時候 ready？ | 被觸發的節點先等所有「上游 control producer」（穿過 data-mode 節點遞移追溯）settle，再一次 pull 所有輸入；非 join 節點多條 control 入邊 = OR、只跑一次；Join 支援 `all` / `any`。沒被走到的分支用 dead-path elimination 標成 skipped 並往下傳。 |
| Loop 怎麼避免 stale data？ | Loop 是外層 DAG 裡的 composite node；**每一輪建一個全新的 GraphRun（新的 editor + engines）**，scope = `[{loop, iteration}]`；上一輪資料只能經由 `carry` 明確帶入。測試 agent 讀到舊資料會直接報錯，demo 證明沒有發生。 |
| Planner 可以建立哪些節點？ | **只能用 Node Registry 裡的類型**；workflow JSON 不得覆寫 `runtime / allowed_tools / mcp / skills / system_prompt / model`。由 compiler 強制（`UNKNOWN_NODE_TYPE`、`POLICY_OVERRIDE`），planner 產出必須通過 compiler 才會執行。 |

## 重用 vs 自己寫

| 來源 | 用在哪 |
|---|---|
| `rete` / `rete-engine` | headless NodeEditor、DataflowEngine（pull + cache）、ControlFlowEngine（forward） |
| `rete-area-plugin` / `rete-connection-plugin` / `rete-react-plugin` / `rete-auto-arrange-plugin`（elkjs） | 前端畫布、拖拉連線、React 渲染、自動排版 |
| `ajv` | JSON Schema 驗證（常數、輸入、輸出、範例） |
| Circuit `agents/base.ts`、`agents/claude.ts` | Claude Agent SDK adapter（3 處標記 `PoC patch`：可注入 queryFn、輸出 usage 事件、debug log） |
| Circuit `orchestrator/references.ts` | `{{inputs.x}}` prompt 插值 |
| 自己寫（glue） | `registry.ts`、`compiler.ts`、`schema.ts#isCompatible`、`engine.ts`（hybrid 語意、loop、join、skip、retry/timeout、紀錄）、`runtime/*`、`planner.ts`、`web/src/*` |

設計參考（未複製程式碼）：Circuit `orchestrator/engine.ts`（ready nodes、inactive branch）、Rivet `LoopUntilNode` / `LoopControllerNode`、Google ADK `_join_node.py` / `_retry_config.py`。

## Phase 狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | typed multi-port、fan-out、Ajv schema 驗證、compiler、Rete 前端 editor（連線型別檢查、驗證、存檔/載入 JSON、localStorage、從 registry 新增節點、loop body 檢視、mock run 狀態上色） | ✅ 完成（前端以 headless Chrome 實測載入 / 拒絕不相容連線 / 存檔 / mock run） |
| 2 | hybrid dataflow + control flow、Condition、Join、Loop（max_iterations、until、carry、per-iteration context）、failure port、dead-path skip、run_id+node_id+iteration 監控 | ✅ 完成（測試 + demo） |
| 3 | AgentRuntime 介面、mock runtime、Circuit Claude adapter、retry/timeout、output schema 驗證、token 統計 | 🟡 部分：mock 完整；Claude 路徑只用 fake query 測過（沒有 API key）；MCP 設定檔載入、真正的 skills 掛載尚未做（skills 目前只寫進 system prompt） |
| 4 | Planner：registry catalog prompt → 產生 workflow JSON → compiler 閘門 → 帶錯誤修正 | 🟡 雛形：流程與測試完成，但生成器是 mock；真 LLM generator 尚未接 |

### 尚未做 / 已知限制

- 前端沒有 node 屬性編輯面板（config、dynamic ports 要改 JSON）；沒有 loop body 巢狀顯示（用下拉切換 body）。
- 執行監控只有前端 log 與 `.runs/*.jsonl`；沒有後端 API / WebSocket / 持久化 DB。
- 前端的 mock run 在瀏覽器內執行（同一份 engine），不是呼叫後端。
- Loop 不支援巢狀 loop 的 UI；engine 層理論上可遞迴但沒測。
- 沒有 sandbox / git worktree 隔離真實 coding agent。

## 目錄

```
src/            核心（registry、compiler、schema、sockets、engine、planner、runtime/）
src/vendor/circuit/   vendored Circuit 程式碼（LICENSE、UPSTREAM_COMMIT）
registry/       builtin 與 agent 節點定義（YAML）、types.yaml 具名型別
workflows/      fix-until-tests-pass.json（demo）、invalid-example.json
scripts/        run-demo.ts、validate.ts、plan-demo.ts
test/           vitest
web/            Phase 1 Rete editor（Vite + React）
```
