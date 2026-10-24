# agent-workflow-engine

類 ComfyUI 的多 Agent workflow 引擎：在畫布上（或讓 AI agent 透過 **MCP**）把 Planning / Coding / Testing / Review 等 agent 節點用**有型別的資料連線**接起來，compiler 先驗證，再交給 hybrid dataflow 引擎執行，執行過程即時顯示在畫布上。

- 底座：**Rete.js 官方套件**（`rete`、`rete-engine`、`rete-area-plugin` / `rete-connection-plugin` / `rete-react-plugin` / `rete-auto-arrange-plugin`）。
- Claude 執行層沿用 [Circuit](https://github.com/smogili1/circuit) 的 `ClaudeAgent` adapter 與 `{{ }}` 插值（Apache-2.0，vendored 在 `src/vendor/circuit/`，見下方「授權」）。
- 預設是 **mock runtime**（不需要任何 API key）；Claude runtime 尚未用真 key 驗證過。
- 狀態：PoC / 實驗性質。

## 快速開始

```bash
npm install && npm --prefix web install
npm test                 # 全部測試（v1 + 進階 + MCP）
npm run test:v1          # 只跑 v1 + MCP
npm run test:advanced    # 只跑進階功能（test/advanced/）
npm run typecheck        # tsc（根目錄）；前端：cd web && npx tsc -p .

export WORKSPACE_ROOTS=~/code   # 允許 agent 操作的目錄（見下方「Workspace」）；沒設定時所有 workspace 都會被拒絕
npm start                # build 前端後由後端直接提供 → http://127.0.0.1:3001
npm run dev              # 開發：後端 :3001 + Vite :5173（/api proxy 到後端）

npm run demo             # CLI：planning → coding ⇄ testing（loop，第 3 輪通過）→ report；沒給 --workspace 時用暫存目錄
npm run demo -- --workspace ~/code/my-repo --mock-writes   # 指定 workspace（需在 WORKSPACE_ROOTS 內）
npm run validate -- workflows/invalid-example.json   # compiler 列出錯誤，每個都附修正建議
npm run convert -- workflows/old.json                # 舊格式（control edges）→ v1
npm run mcp              # MCP server（stdio）
npm run mcp:demo         # MCP 端到端示範：AI 寫錯 → validate → 照 fix 修正 → run → 讀結果
```

後端參數：`npm run server -- --port 3001 --host 127.0.0.1 --mock-delay 250 --runtime mock|claude`。

## Workflow DSL v1

v1 只有 **6 個概念**：**節點**、**有型別的 port**、**資料連線**、**start / end**、**condition（true / false 分支）**、**loop（body + until，同名輸出自動帶到下一輪）**。沒有 control edge、沒有「data 節點 vs control 節點」的區分：**節點的必要輸入都到齊就執行**。

```json
{
  "version": 1,
  "nodes": [
    { "id": "start", "type": "start", "ports": { "outputs": { "request": { "type": "string" } } } },
    { "id": "planner", "type": "planning_agent" },
    { "id": "gate", "type": "condition", "config": { "rule": { "op": "gt", "path": "length", "value": 0 } } },
    { "id": "ok", "type": "end", "config": { "status": "success" }, "ports": { "inputs": { "tasks": { "type": "array" } } } },
    { "id": "empty", "type": "end", "config": { "status": "failed" }, "ports": { "inputs": { "reason": {} } } }
  ],
  "edges": [
    "start.request -> planner.request",
    "planner.tasks -> gate.data",
    "gate.true -> ok.tasks",
    "gate.false -> empty.reason"
  ]
}
```

- **edges** 寫成 `"節點.輸出 -> 節點.輸入"` 字串（也接受 `{"from": "a.x", "to": "b.y"}`）。型別不相容會被 compiler 擋下。
- **condition**：依 `rule` 判斷 `value`（或 `data`），把 `data` 原樣從 `true` 或 `false` 輸出；沒走到的那一邊（以及只依賴它的下游）會被標成 skipped。
- **多條連線接到同一個輸入**：第一個有值的勝出（用來合流 condition 的兩個分支）。
- **loop**：`body` 是子圖（`loop_in` → 步驟 → `loop_out`）；`config.until` 成立或達到 `max_iterations` 就結束。**body 輸出與 loop 輸入同名**（例如 `feedback`）就自動帶到下一輪；loop 另外輸出 `done`、`iterations`。
- 保留：agent 的 retry / timeout、port 的 JSON Schema 驗證、policy 欄位不可覆寫（`POLICY_OVERRIDE`）。
- 每個 compiler 錯誤都附 **`fix`**（例如 `Connect a compatible output, e.g. "planner.tasks -> coder.tasks"`），UI 的 Diagnostics、`npm run validate`、MCP 的 `validate_workflow` 都會顯示。

### v1 節點（14 個 = 9 builtin + 5 agent）

| 節點 | 主要 ports | 說明 |
|---|---|---|
| start | 動態輸出 | 入口；輸出 = run inputs |
| end | 動態輸入 | 終點；`config.status` 決定 run 成功 / 失敗（任何一個 failed end 被執行，run 就是 failed） |
| condition | `value` / `data` → `true` / `false` | 規則判斷並把資料分流 |
| loop | 動態；`done`、`iterations` | 重複執行 body 直到 `until` |
| transform | `input` → `result` | JSONata 表達式（不執行任意程式碼） |
| template | 動態輸入 → `text` | `{{inputs.x}}` 組字串 |
| http_request | `url`,`body`,`headers`,`query` → `status`,`ok`,`body`,`headers` | 只允許 http/https；預設擋私有 / loopback 位址，redirect 逐跳檢查；`HTTP_ALLOW_HOSTS` 白名單 |
| json_parse | `text` → `value` | 可從 ``` 區塊擷取 |
| log | `message` → `value` | 寫入監控 log |
| planning / coding / testing / risk_review / report_agent | 見 `registry/agents/*.yaml` | mock 或 Claude；runtime / model / prompt / allowed_tools 等由 registry 決定，workflow 不可覆寫 |

### 進階功能（預設關閉）

舊版 control-edge 格式（`kind: "control"`、`success` / `failure` / `execute` ports）、進階節點（switch、join、merge、foreach、subflow、set、filter、schema_validate、delay、file_read / file_write）、巢狀 loop、loop 的 `carry` / `on_body_failure`、resume、瀏覽器內執行。

- 後端：`WORKFLOW_ADVANCED=1`，或個別 request 帶 `advanced: true`（PUT 用 `?advanced=1`）。
- CLI：`npm run validate -- <file> --advanced`。
- UI：工具列右上「進階功能」開關（記在 localStorage）。
- 測試在 `test/advanced/`（`npm run test:advanced`）。
- 舊檔轉 v1：`npm run convert -- <file>`（`convertToV1`：control edge 拿掉、condition 分支改成資料分流、`carry` 改成同名自動帶入；轉不了的會列在 notes）。

## Workspace（agent 操作的本機 repo / 目錄）

每次 run 可以指定一個 **workspace**：本機 repo 或目錄的絕對路徑。agent 會**直接在這個目錄裡**工作（沒有複製、沒有 git worktree）。

- **指定方式**：REST `POST /api/runs {"workspace": "/abs/path"}`、MCP `run_workflow` 的 `workspace`、CLI `--workspace`、Web UI 工具列的 workspace 欄位（記在 localStorage）。
- **白名單 `WORKSPACE_ROOTS`**：用 `:` 分隔（Windows 用 `;`），支援 `~`，例如 `WORKSPACE_ROOTS=~/code:/srv/repos`。workspace 會先解析 symlink（realpath），必須存在、是目錄、而且在某個 root 底下；否則 REST 回 `400 {error, fix}`、MCP 回 tool error（附 `fix`）。`..` 穿越、同前綴的兄弟目錄（`/root-evil`）、指向外面的 symlink 都會被擋。**沒設定 `WORKSPACE_ROOTS` 時拒絕所有 workspace**，錯誤訊息會說明怎麼設定。
- **節點權限（registry 層級，workflow 不能覆寫）**：node definition 的 `workspace: none | read | write`（預設 none）。`workspace` 跟 `allowed_tools` 一樣是鎖定欄位，實例 config 想改會得到 `POLICY_OVERRIDE`。

  | 權限 | 執行時 | 內建 agent |
  |---|---|---|
  | `none` | 不給 workingDirectory；拿掉所有檔案 / Bash 工具（Read、Grep、Glob、LS、Edit、Write、Bash…） | 測試用小節點 |
  | `read` | workingDirectory = workspace；只留唯讀工具，拿掉 Edit / MultiEdit / Write / Bash / NotebookEdit | planning / risk_review / report |
  | `write` | workingDirectory = workspace；`allowed_tools` 照定義 | coding / testing |

- **沒有 workspace 時**：workflow 裡有 read / write agent 就編譯失敗（`WORKSPACE_REQUIRED`，附修正建議）；直接呼叫 engine 時，這些節點會失敗並寫明原因。不再退回 `process.cwd()`。`POST /api/validate` 會回報 `workspace_required`，UI 會在欄位旁顯示「需要 workspace（write）」。
- **Claude runtime 的對應**（依 `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts`）：`cwd` = workspace（none 用一個空的暫存目錄）、`tools` = 過濾後的工具（`[]` = 關掉所有內建工具）、`disallowedTools` = 被權限拿掉的工具、`permissionMode` = write 用 `acceptEdits`，none / read 用 `dontAsk`（沒在 allowedTools 的一律拒絕，不跳詢問）。實作在 `src/runtime/claude.ts#sdkPermissionOptions` 與 vendored `ClaudeAgent` 的 PoC patch 4。
- **⚠ Bash 沒有被 sandbox 在 workspace 內。** `cwd` 只是起始目錄，write 權限的 agent（coding / testing）用 Bash 仍可讀寫 workspace 以外的檔案。真正的隔離需要 container / VM，v1 沒做。
- **監控**：run 紀錄（`meta.workspace`）包含 workspace 路徑、開始時的 git branch / HEAD；run 結束後列出**這次 run 期間**變更的檔案（added / modified / deleted，含 +/− 行數）與 diff stat。
  - git repo：以開始時的 HEAD 為基準（`git diff --name-status/--numstat <HEAD>` + untracked），開始前就已經 dirty、run 期間沒再動的檔案不列；run 期間的 commit 也算（`head_after` 會不同）。git 指令會關掉 fsmonitor / hooks / 外部 diff / textconv。
  - 非 git 目錄：前後各做一次快照（size + mtime，1 MB 以下算 sha1），最多 5000 個檔案（略過 `.git`、`node_modules`），變更清單最多 500 筆；超過會標「已截斷」。修改的檔案沒有行數。
  - UI 的執行監控有 Workspace 區塊（路徑、branch@HEAD、變更檔案、diff stat），執行紀錄列表顯示 workspace 名稱與變更數；MCP `get_run` 回傳 `workspace`。
- **mock 寫檔示範**：mock runtime 不會碰檔案；`mock_writes: true`（UI「mock 寫檔」、CLI `--mock-writes`）時，mock coding agent 會在 `<workspace>/agent-workflow-demo/` 寫 `iteration-N.md` 與 `CHANGELOG.md`（只在權限為 write 且有 Write 工具時），讓變更清單有內容。

截圖：`screenshots/13-workspace-run.png`（workspace 欄位、mock 寫檔、run 完成後的變更清單、執行紀錄的 workspace 摘要、Log 裡的 WORKSPACE_REQUIRED / 白名單錯誤）。

## MCP server

讓 Claude Desktop / Claude Code / Cursor 等 MCP client 直接查節點、寫 workflow、驗證、執行、讀結果。server 的 `instructions` 內含 v1 DSL 說明。

| Tool | 說明 |
|---|---|
| `list_node_types` | v1 節點摘要（ports、型別、可設定的 config） |
| `get_node_type` | 單一節點完整定義 + 範例 |
| `list_workflows` / `get_workflow` | `workflows/*.json` |
| `validate_workflow` | compiler 結果；每個錯誤附 `fix` |
| `save_workflow` | 驗證通過才存成 `workflows/<id>.json` |
| `run_workflow` | 啟動執行，回 `run_id`（非同步）；`workspace` = agent 操作的目錄（需在 `WORKSPACE_ROOTS` 內）、`mock_writes` |
| `get_run` | 狀態、每個節點的 status / 輸出摘要、token、錯誤；`workspace`（路徑、git branch / HEAD、變更檔案、diff stat） |
| `cancel_run` | 取消執行中的 run |

**stdio**（預設在同一個 process 內建立 backend，不開 port；runs 一樣寫到 `.runs/`，UI 的執行紀錄看得到）：

- 環境變數：`WORKSPACE_ROOTS`（允許的 workspace 根目錄，見上方）、`WORKFLOW_BACKEND_URL=http://127.0.0.1:3001`（改成呼叫已在跑的後端，UI 可即時看到 MCP 啟動的 run）、`WORKFLOW_DIR`、`WORKFLOW_RUNS_DIR`、`MOCK_DELAY_MS`。
- 下面的 `/path/to/agent-workflow-engine` 換成你 clone 的絕對路徑。

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "agent-workflow": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-workflow-engine/src/mcp/stdio.ts"],
      "env": { "WORKSPACE_ROOTS": "/Users/me/code" }
    }
  }
}
```

Claude Code：

```bash
claude mcp add agent-workflow -e WORKSPACE_ROOTS=~/code -- npx tsx /path/to/agent-workflow-engine/src/mcp/stdio.ts
# 或接到已在跑的後端（Streamable HTTP）
claude mcp add --transport http agent-workflow http://127.0.0.1:3001/mcp
```

Cursor（專案的 `.cursor/mcp.json` 或 `~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "agent-workflow": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-workflow-engine/src/mcp/stdio.ts"],
      "env": { "WORKFLOW_BACKEND_URL": "http://127.0.0.1:3001" }
    }
  }
}
```

**Streamable HTTP**：`npm run server` 之後，MCP endpoint 是 `http://127.0.0.1:3001/mcp`（stateless；支援 HTTP transport 的 client 填 `"url": "http://127.0.0.1:3001/mcp"`）。後端預設只聽 127.0.0.1，沒有驗證，不要直接對外開放。

## Web UI

- **預設 v1**：只有資料連線（沒有 control socket）、節點庫只列 v1 節點、存檔 / 下載 / Workflow JSON 都寫成 v1 格式（字串 edges）。condition 的 `true` / `false` 型別跟著接到 `data` 的上游走。
- **屬性面板**：依 `config_schema` 產生設定表單；agent 的 runtime / model / prompt / allowed tools 以 🔒 唯讀顯示，只有 `max_turns`、`timeout_seconds`、`retry` 可改；動態 ports 可新增 / 刪除 / 改型別；即時驗證，錯誤以紅色 badge 標在節點上，Diagnostics 顯示修正建議。
- **執行監控**：透過 SSE 即時上色；點節點看 Status / Input / Output / Agent Events / Duration / Tokens；loop 有 iteration 選擇器；**雙擊 loop 進入 body** 編輯或查看每一輪。
- **執行紀錄**：列出 `.runs/` 的 run，可開啟、用時間軸 replay、取消。
- **Workspace**：工具列輸入 workspace 路徑（記在 localStorage），workflow 需要時欄位旁會提示；執行監控顯示 workspace、git branch@HEAD 與 run 結束後的變更檔案。
- **開啟「進階功能」後**：多層 drill-down（巢狀 loop、foreach、subflow 唯讀 drill-in）、resume、瀏覽器內執行（沒有後端時）。

截圖（headless Chrome 實測，`screenshots/`）：`13-workspace-run.png`（workspace 欄位 + 變更清單）、`11-v1-editor.png`（v1 編輯器 + agent 屬性面板 + v1 JSON）、`12-v1-monitor.png`（v1 run 完成、loop 3 輪）。`01`–`10` 是進階 / 舊格式時期的截圖（屬性面板、驗證錯誤、監控、replay、resume、巢狀 loop、subflow）。

### UI 細節（屬性面板、監控、巢狀 drill-down）

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

## 執行與安全設定

- **Runtime 預設是 mock。** 只有 `--runtime claude`（或 `AGENT_RUNTIME=claude`）**而且**有 `ANTHROPIC_API_KEY` 時才會走 Circuit 的 Claude adapter；否則一律 mock（`GET /api/health` 會回報原因）。
- **HTTP Request 節點（SSRF 防護）**：只允許 http/https。沒設白名單時，預設**擋掉 loopback / 私有 / link-local（含雲端 metadata `169.254.169.254`）/ 保留位址**，Node 端會先做 DNS 解析再檢查；**每一次 redirect 都重新檢查**（最多 5 次）。
  - `HTTP_ALLOW_HOSTS=api.example.com,localhost`：白名單模式，只允許列出的 host（明確列出的 localhost 也可以）。
  - `HTTP_ALLOW_PRIVATE=1`：本機開發時允許私有位址。
  - 已知限制：DNS 解析與實際連線之間仍有 DNS rebinding 的空窗；要嚴格限制請用白名單。
- **檔案節點（進階）** 只能讀寫 `.workspace/`（沙盒）：拒絕絕對路徑、`..`、經由 symlink（含懸空 symlink）逃出沙盒。
- **後端只接受 Host = localhost / 127.0.0.1 / [::1]**（防 DNS rebinding 從瀏覽器打本機 API / MCP）；綁其他介面時用 `ALLOWED_HOSTS=my-host.example` 設定。API 會檢查 workflow id / run id 格式與 body 形狀；壞掉的 workflow JSON 不會讓編譯器或列表 crash。
- 每次執行都寫進 `.runs/`（`<run_id>.meta.json`、`.workflow.json`、`.events.jsonl`、`.records.json`）；`.runs/`、`.workspace/` 已列在 `.gitignore`。

## 後端 API（`src/server/app.ts`）

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/health` | 狀態 + 目前 runtime（mode / reason）+ registry 節點數 + `workspace_roots` |
| GET | `/api/registry` | 節點定義；預設只回 v1 節點，`?advanced=1` 回全部 |
| GET | `/api/workflows`、`/api/workflows/:id` | `workflows/*.json` |
| PUT | `/api/workflows/:id[?advanced=1]` | 存回 `workflows/<id>.json`；有驗證錯誤回 `422`（避免把被 subflow 引用的 workflow 存成跑不動的版本） |
| POST | `/api/validate` | `{workflow, advanced?, workspace?}` → compiler 的 errors / warnings（每個都附 `fix` 修正建議）+ `workspace_required` |
| POST | `/api/runs` | `{workflow \| workflow_id, inputs, scenario, pass_on, mock_delay_ms, workspace?, mock_writes?}` → `202 {run_id}`；workspace 不合法回 `400 {error, fix}`；編譯失敗（含 `WORKSPACE_REQUIRED`）回 `422` |
| GET | `/api/runs`、`/api/runs/:id` | 執行紀錄列表；單一 run 的 meta + workflow + events + records |
| GET | `/api/runs/:id/events` | SSE（`event: run`、`id: seq`）；支援 `?after=` / `Last-Event-ID`，先補發歷史再即時推送，結束時送 `event: end` |
| POST | `/api/runs/:id/cancel` | 取消執行中的 run（AbortSignal 傳到 agent / HTTP / delay） |
| POST | `/api/runs/:id/resume`（進階） | 以同一份 workflow 重跑，**已成功的 agent 節點沿用上次輸出**（依 scope/node_id 對應），其餘重新執行 |
| POST | `/mcp` | MCP Streamable HTTP（stateless；GET / DELETE 回 405） |


## 架構（進階：舊格式的 hybrid 引擎）

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
| `rete` / `rete-engine` | headless NodeEditor、DataflowEngine、ControlFlowEngine |
| `rete-area-plugin` / `rete-connection-plugin` / `rete-react-plugin` / `rete-auto-arrange-plugin`（elkjs） | 前端畫布、拖拉連線、React 渲染、自動排版 |
| `ajv` | JSON Schema 驗證 |
| `@modelcontextprotocol/sdk` | MCP server（stdio / Streamable HTTP） |
| Circuit `agents/base.ts`、`agents/claude.ts` 等（`src/vendor/circuit/`） | Claude Agent SDK adapter（標記 `PoC patch` 的地方是修改處） |
| Circuit `orchestrator/references.ts` | `{{inputs.x}}` prompt 插值 |
| `fastify`、`jsonata` | 薄後端 / SSE；Transform 節點的表達式語言 |
| 自己寫 | `dsl.ts`、`registry.ts`、`compiler.ts`、`fixes.ts`、`convert.ts`、`engine.ts`、`nodes/builtins.ts`、`server/*`、`mcp/*`、`runtime/*`、`planner.ts`、`web/src/*` |

設計參考（未複製程式碼）：Circuit `orchestrator/engine.ts`、Rivet `LoopUntilNode`、Google ADK `_join_node.py` / `_retry_config.py`。

## 已知限制

- Claude runtime 沒有用真 API key 跑過；MCP 設定檔載入、skills 掛載未做。Planner（`npm run plan`）的生成器是 mock。
- 後端與 MCP HTTP endpoint 沒有帳號驗證 / 多使用者（只有 Host header 檢查），預設只聽 127.0.0.1，不要直接對外開放；`.runs/` 是 JSON 檔，沒有 DB。
- UI 載入 workflow 時，畫不出來的 edge（例如接到不存在的 port）會略過並寫在 Log，不會保留在畫布上。
- 沒有 git worktree / container 隔離：agent 直接在你指定的 workspace 裡工作；**Bash 沒有被限制在 workspace 內**（`cwd` 只是起始目錄）。工具權限（none / read / write）只在 Claude runtime 透過 SDK 的 `tools` / `disallowedTools` / `permissionMode` 生效，Claude runtime 本身仍沒用真 API key 跑過。
- 變更清單是 run 前後的快照比對：同一個 workspace 同時跑多個 run、或使用者在 run 期間自己改檔，都會被算進去；git 的 +/− 行數以開始時的 HEAD 為基準（開始前就 dirty、run 期間又改的檔案，行數包含原本的修改）；非 git 目錄修改的檔案沒有行數，超過 5000 個檔案會截斷。
- 瀏覽器內執行（進階）不驗證 workspace 路徑（只有 mock agents，不碰檔案）。
- v1 範圍審查與簡化理由：`docs/v1-scope-review.md`。

## 目錄

```
src/            dsl（v1 解析 / 序列化）、registry、compiler、fixes（修正建議）、convert（舊格式 → v1）、engine、planner、runtime/、
                workspace.ts（WORKSPACE_ROOTS / 快照 / 變更清單，node 專用）、workspace-policy.ts（權限 → 工具，瀏覽器也可用）
src/mcp/        MCP server（tools、stdio、backend 介面）
src/server/     Fastify app（含 POST /mcp）、RunStore（.runs/）
src/nodes/      builtin 節點實作
src/vendor/circuit/   vendored Circuit 程式碼（Apache-2.0 LICENSE、UPSTREAM_COMMIT）
registry/       builtin 與 agent 節點定義（YAML，tier: v1 / advanced / internal）、types.yaml
workflows/      fix-until-tests-pass.json（demo）、invalid-example.json；nested-review / plan-subflow（進階）
scripts/        server、run-demo、validate、convert、plan-demo、mcp-demo
test/           v1/、mcp/、advanced/（vitest）
web/            Rete editor + 屬性面板 + 執行監控（Vite + React）
docs/           v1-scope-review.md
screenshots/    headless Chrome 截圖
```

## 授權

本專案以 **MIT License** 授權（見 [`LICENSE`](LICENSE)，Copyright (c) 2026 GallonShih），**`src/vendor/circuit/` 除外**。

`src/vendor/circuit/` 內的檔案來自 Circuit（[smogili1/circuit](https://github.com/smogili1/circuit) @ `b563153`），以 **Apache License 2.0** 授權（全文見 `src/vendor/circuit/LICENSE`，上游 commit 見 `UPSTREAM_COMMIT`）；修改處以 `PoC patch` 註解標示。

選用的 Claude runtime 依賴 npm 套件 `@anthropic-ai/claude-agent-sdk`（Anthropic 專有授權，不包含在本 repo 內，`npm install` 時才下載；mock runtime 不需要它的服務）。
