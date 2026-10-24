# Agent Workflow PoC（Rete.js + 薄 TypeScript 後端）

類 ComfyUI 的多 Agent workflow 平台 PoC。**底座是 Rete.js 官方套件**（`rete`、`rete-engine` 的 DataflowEngine / ControlFlowEngine、`rete-area-plugin` / `rete-connection-plugin` / `rete-react-plugin` / `rete-auto-arrange-plugin`），
Claude 執行層沿用 **Circuit** 的 `ClaudeAgent` adapter 與 `{{ }}` reference 插值（Apache-2.0，見 `src/vendor/circuit/`）。
自己寫的只有「膠水層」：registry/compiler、hybrid 排程語意、loop composite、監控紀錄。

> 未使用 Langflow；未 fork Circuit（只 vendor 兩個檔案並標註 patch）。

## 快速開始

```bash
npm install && npm --prefix web install
npm test                 # vitest：7 個檔案 63 個測試
npm run typecheck        # tsc strict（根目錄）；前端：cd web && npx tsc -p .

# 開發模式：後端（Fastify, :3001）+ Vite（:5173，/api proxy 到後端）
npm run server           # 終端機 1
npm run web:dev          # 終端機 2 → http://localhost:5173
#   或一行：npm run dev

# 單一 process：build 前端後由後端直接提供 web/dist
npm start                # → http://127.0.0.1:3001

npm run demo             # CLI：planning → coding → testing → condition → 重試，mock agents，第 3 輪通過
npm run demo -- --scenario fail --no-flaky   # 3 輪都失敗 → loop exhausted → FAILED 路徑
npm run validate -- workflows/invalid-example.json   # compiler 列出 14 個錯誤、2 個警告
npm run plan             # Phase 4 雛形：mock planner → compiler 擋下 → 修正 → 執行
```

後端參數：`npm run server -- --port 3001 --host 127.0.0.1 --mock-delay 250 --runtime mock|claude`。

- **Runtime 預設是 mock。** 只有 `--runtime claude`（或 `AGENT_RUNTIME=claude`）**而且**有 `ANTHROPIC_API_KEY` 時才會走 Circuit 的 Claude adapter；否則一律 mock（`GET /api/health` 會回報原因）。Claude 路徑**尚未用真 key 驗證過**。
- `HTTP_ALLOW_HOSTS=api.example.com,localhost`：HTTP Request 節點的主機白名單（未設定 = 不限制，只允許 http/https）。
- 檔案節點只能讀寫 `.workspace/`（沙盒；擋絕對路徑、`..`、symlink 逃逸）。
- 每次執行都寫進 `.runs/`：`<run_id>.meta.json`、`.workflow.json`、`.events.jsonl`（即時 append）、`.records.json`（key = `run_id/scope/node_id`，例如 `run_x/fix_loop#1/coder`）。後端重啟後，未結束的 run 會顯示為 `interrupted`。

## 後端 API（`src/server/app.ts`）

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/health` | 狀態 + 目前 runtime（mode / reason）+ registry 節點數 |
| GET | `/api/registry` | 全部節點定義（含 config_schema、instance_overridable、output_overrides） |
| GET | `/api/workflows`、`/api/workflows/:id` | `workflows/*.json` |
| PUT | `/api/workflows/:id` | 存回 `workflows/<id>.json`；有驗證錯誤回 `422`（避免把被 subflow 引用的 workflow 存成跑不動的版本） |
| POST | `/api/validate` | `{workflow}` → compiler 的 errors / warnings |
| POST | `/api/runs` | `{workflow \| workflow_id, inputs, scenario, pass_on, mock_delay_ms}` → `202 {run_id}`；編譯失敗回 `422` |
| GET | `/api/runs`、`/api/runs/:id` | 執行紀錄列表；單一 run 的 meta + workflow + events + records |
| GET | `/api/runs/:id/events` | SSE（`event: run`、`id: seq`）；支援 `?after=` / `Last-Event-ID`，先補發歷史再即時推送，結束時送 `event: end` |
| POST | `/api/runs/:id/cancel` | 取消執行中的 run（AbortSignal 傳到 agent / HTTP / delay） |
| POST | `/api/runs/:id/resume` | 以同一份 workflow 重跑，**已成功的 agent 節點沿用上次輸出**（依 scope/node_id 對應），其餘重新執行 |

## Web UI

- **節點屬性面板（右側「屬性」）**：Label、依 `config_schema` 自動產生的設定表單；Agent 節點的 runtime / model / prompt / allowed tools / MCP / skills 以 🔒 唯讀顯示，只有 `max_turns`、`timeout_seconds`、`retry` 可改；動態 ports（start / end / set / template / loop / foreach / subflow）可新增、刪除、改型別；`output_overrides` 可收窄 any 型別輸出；解析後的 ports 與型別表。修改即時反映到畫布與 Workflow JSON，並 debounce 重新驗證，錯誤以紅色 badge 標在節點上。
- **執行監控（右側「執行監控」）**：Backend 模式透過 SSE 即時上色（running 會脈動）；點節點看 Status / Input / Output / Agent Events / Duration / Tokens / Attempts / Retries；Loop、Foreach 節點有 iteration 選擇器。
- **巢狀 Loop / Sub-workflow 在畫布上 drill-down**（任意深度）：
  - **雙擊** loop / foreach / subflow 節點（標題有 `⤵`）進入子圖；也可從屬性面板「進入子圖」或監控面板「在畫布檢視」某一輪。
  - 畫布上方 **breadcrumb**：`主流程 › review_rounds（loop） › fix_loop（loop）`，點任一段回到那一層。
  - **邊界節點**：body 裡的 `loop_in` / `loop_out`（subflow 裡的 `start` / `end`）畫成紫色虛線框，每個 port 後面標出外層對應，例如 `tasks ← planner.tasks`、`feedback ← … ；第 2 輪起 ← carry(loop_out.failures)`、`passed → fix_loop.passed → gate.value`。左上角說明列顯示 max_iterations / until / carry。
  - **在任何一層 body 都能完整編輯**：新增節點、typed 連線檢查、屬性面板、即時驗證；存檔寫回**同一份** workflow JSON 的巢狀位置（`src/graph-path.ts` 的 `setGraphAt`）。深層的驗證錯誤會一路標到外層 composite 的紅色 badge 上（錯誤的 `node` / `path` 帶完整路徑，例如 `review_rounds.body/fix_loop.body/log_1`）。
  - **監控跟著 drill-down**：只顯示目前 scope 的節點狀態；breadcrumb 每一層各有 iteration 下拉，外層輪次與內層輪次可**分開選**（例如 `review_rounds#0 › fix_loop#1`），右側面板顯示該輪的真實 Input / Output。即時 run 與歷史 replay 都適用。
  - **Sub-workflow drill-in 預設唯讀**（可能有其他 workflow 引用它）：顯示被引用 workflow 的結構與這次 run 的狀態 / 資料（優先用 run 事件裡的 `subflow_started` 快照，所以來源之後被改也能正確回放）；「✎ 開啟來源 workflow 編輯」會把來源載入成主流程（有「← 返回」），backend 模式可「存回 workflows/<id>.json」。
- **執行紀錄（左側）**：列出 `.runs/` 的所有 run，可開啟、用時間軸滑桿 replay 事件、Resume、取消。
- **瀏覽器內模式**：沒有後端時改在瀏覽器裡跑同一份 engine；subflow 會從打包進前端的 `workflows/*.json` 載入（file_* 節點仍不可用、沒有執行紀錄）。

截圖（headless Chrome 實測，`screenshots/`）：
`01-editor-properties-agent.png`（屬性面板）、`02-editor-validation-errors.png`（INVALID_CONFIG badge）、`03-monitor-running.png`、`04-monitor-completed-loop-body.png`（loop body + iteration 選擇器）、`05-monitor-completed-run.png`（完成的 run）、`06-history-replay.png`、`07-resume.png`、`08-nested-loop-drilldown.png`（兩層 loop drill-down + breadcrumb + 邊界節點）、`09-nested-loop-monitor-iterations.png`（外層 #0 / 內層 #1 分開選，tester 該輪的資料）、`10-subworkflow-readonly.png`（subflow 唯讀 drill-in + run 資料）。

巢狀 demo：工具列「開啟 workflows/…」選 `nested-review`（subflow `plan-subflow` 拆解任務 → 外層 review 2 輪 × 內層 coding⇄testing 迴圈）。

## 節點目錄（`registry/`）

| 節點 | 類別 | 觸發 | 主要 ports | 設定 | 說明 |
|---|---|---|---|---|---|
| start | Flow | control | 動態輸出 → `success` | — | 入口；輸出 = run inputs |
| end | Flow | control | 動態輸入 | `status` | 終點；決定 run 成功 / 失敗，輸入記為 run 輸出 |
| subflow | Flow | control | 動態輸入 / 輸出；`success`/`failure` | `workflow` | 執行 `workflows/<id>.json`（僅後端 / CLI；最多 8 層） |
| condition | Logic | control | `value` → `true`/`false` | `rule` | 規則判斷分支 |
| switch | Logic | control | `value` → 各 case / `default`；輸出 `value`,`matched` | `cases`,`match` | 多路分支（first / all） |
| loop | Logic | control | 動態；`completed`/`done`/`exhausted`/`failure` | `max_iterations`,`until`,`carry`,`on_body_failure` | composite；每輪全新 GraphRun |
| foreach | Logic | control | `items` + 動態 → 每個輸出收集成陣列 + `count` | `max_items`,`on_item_failure` | 每個元素一個 iteration scope |
| join | Logic | control | `in`（或 `in_1..N`）→ `success` | `policy`,`inputs` | all / any 同步 |
| merge | Logic | data | `in_1..N` → `merged` | `inputs`,`mode` | array / object / first |
| transform | Logic | control | `input` → `result` | `expression`,`timeout_ms` | JSONata（不執行任意程式碼） |
| set | Data | data | 動態輸出 | `values` | 常數 |
| template | Data | data | 動態輸入 → `text` | `template` | `{{inputs.x}}` 組字串 |
| filter | Data | control | `items` → `items`,`rejected`,`count` | `rule` | 依規則過濾陣列 |
| http_request | Utility | control | `url`,`body`,`headers`,`query` → `status`,`ok`,`body`,`headers` | `method`,`url`,`headers`,`timeout_ms`,`response_type`,`fail_on_http_error` | 只允許 http/https；非 2xx 走 failure |
| json_parse | Utility | control | `text` → `value` | `extract_code_block` | 可從 ``` 區塊擷取 |
| schema_validate | Utility | control | `value` → `value`,`is_valid`,`errors`；`valid`/`invalid` | `schema` | Ajv |
| delay | Utility | control | `value` → `value` | `ms` | 可被取消 |
| log | Utility | control | `message` → `value` | `level`,`label` | 寫入監控的 log 事件 |
| file_read | IO | control | `path` → `content`,`path`,`bytes` | `path`,`format` | 沙盒 `.workspace/`（僅後端 / CLI） |
| file_write | IO | control | `content`,`path` → `path`,`bytes` | `path`,`format`,`mode` | 同上 |
| loop_in / loop_out | （body） | — | 由 loop / foreach 決定 | — | body 子圖的出入口 |
| planning / coding / testing / risk_review / report_agent | Agent | control | 見 YAML；`success`/`failure` | `max_turns`,`timeout_seconds`,`retry` | mock 或 Claude（policy 欄位不可覆寫） |

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
| `fastify`、`jsonata` | 薄後端 / SSE；Transform 節點的表達式語言 |
| 自己寫（glue） | `registry.ts`、`compiler.ts`、`schema.ts#isCompatible`、`engine.ts`（hybrid 語意、loop / foreach / subflow、join、skip、retry/timeout、resume、紀錄）、`nodes/builtins.ts`、`server/*`、`runtime/*`、`planner.ts`、`web/src/*` |

設計參考（未複製程式碼）：Circuit `orchestrator/engine.ts`（ready nodes、inactive branch）、Rivet `LoopUntilNode` / `LoopControllerNode`、Google ADK `_join_node.py` / `_retry_config.py`。

## Phase 狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | typed multi-port、Ajv、compiler、Rete editor、**節點屬性面板**（schema 表單、動態 ports、即時驗證 badge） | ✅ 完成（headless Chrome 實測） |
| 2 | hybrid dataflow + control flow、Condition / Switch / Join / Merge / Loop / Foreach、dead-path skip、監控 key | ✅ 完成（測試 + demo） |
| 2.5 | 常用節點：Transform（JSONata）、HTTP、JSON Parser、Schema Validator、Template、Set、Delay、Filter、Log、檔案讀寫、Sub-workflow | ✅ 完成（`test/nodes.test.ts` 19 個測試，HTTP 用本機 stub server） |
| 3 | AgentRuntime、mock runtime、Circuit Claude adapter、retry/timeout、token 統計 | 🟡 部分：mock 完整；Claude 只用 fake query 測過（沒有 API key）；MCP / skills 掛載尚未做 |
| 3.5 | 薄後端（Fastify）+ 執行監控：SSE、`.runs/` 持久化、執行紀錄、replay、cancel、resume | ✅ 完成（`test/server.test.ts` 8 個測試 + 瀏覽器實測） |
| 3.6 | 巢狀 loop（loop 裡的 loop）+ sub-workflow 在畫布上 drill-down、邊界節點、scope 化監控、唯讀 subflow | ✅ 完成（`test/nested.test.ts` 5 個測試 + headless Chrome 實測） |
| 4 | Planner：catalog prompt → workflow JSON → compiler 閘門 → 修正 | 🟡 雛形：生成器是 mock |

### 尚未做 / 已知限制

- Claude runtime 沒有用真 API key 跑過；MCP 設定檔載入、skills 實際掛載未做。
- Drill-down 一次顯示一層（沒有「在外層展開預覽內層」的 group / 縮圖）；邊界節點是既有的 loop_in / loop_out 加註解，不是自動產生的虛擬節點。
- 唯讀 subflow 內再 drill 進它的 loop 仍是唯讀；「存回 workflows/」不會檢查其他引用者的 ports 是否仍相容（只驗證這份 workflow 自己）。
- 瀏覽器內模式沒有檔案系統（file_* 節點會失敗）與執行紀錄；subflow 只能用打包時的 `workflows/*.json`（或 backend 的版本）。
- v1 範圍審查（哪些概念太複雜、建議簡化）：見 `docs/v1-scope-review.md`。
- Resume 只沿用成功的 **agent** 節點輸出；builtin 節點一律重跑（HTTP 等有副作用的節點要注意）。
- HTTP 白名單未設定時不限制主機，也沒有阻擋內網 IP（SSRF）；正式環境務必設定 `HTTP_ALLOW_HOSTS`。
- `.runs/` 是 JSON 檔，沒有 DB、沒有驗證 / 多使用者；後端預設只聽 127.0.0.1。
- 沒有 git worktree / container 隔離真實 coding agent。

## 目錄

```
src/            核心（registry、compiler、schema、sockets、engine、planner、runtime/）
src/vendor/circuit/   vendored Circuit 程式碼（LICENSE、UPSTREAM_COMMIT）
registry/       builtin 與 agent 節點定義（YAML）、types.yaml 具名型別
workflows/      fix-until-tests-pass.json（demo）、nested-review.json + plan-subflow.json（巢狀 / subflow demo）、invalid-example.json
docs/           v1-scope-review.md（v1 簡化建議，未實作）
src/nodes/      builtin 節點的 check / execute / compute
src/server/     Fastify app、RunStore（.runs/）
scripts/        server.ts、run-demo.ts、validate.ts、plan-demo.ts
screenshots/    headless Chrome 截圖
test/           vitest
web/            Rete editor + 屬性面板 + 執行監控（Vite + React）
```
