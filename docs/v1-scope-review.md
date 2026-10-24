# v1 範圍審查：哪裡太複雜、該怎麼收斂（只提建議，尚未實作）

審查對象：commit 之後的 PoC（iteration 3）。兩個視角：
**(A) 人**用編輯器 / 監控；**(B) AI agent** 透過 MCP 使用系統。引擎目前**沒有 MCP server**，(B) 是評估它需要提供哪些工具、DSL 對 agent 好不好寫。

## 證據摘要（數字都是實際量的）

- 程式量：核心 `src/`（不含 vendor）約 2.6k 行（engine.ts 514、builtins.ts 305、compiler.ts 286、app.ts 252）；前端 `web/src/` 約 2k 行（main.tsx 726、editor.tsx 407）。
- 節點：27 種（20 個 builtin 加 loop_in / loop_out 兩個內部節點，再加 5 個 agent）。
- 要學的 DSL 概念大約 **18 個**：
  - 基本：typed port、JSON Schema 與 `$type` 具名型別。
  - 連線：**兩種 edge**（data / control）、每種節點各自的 control port 名稱（loop 有 4 個：`completed / done / exhausted / failure`，condition 是 `true / false`，schema_validate 是 `valid / invalid`）、entry node。
  - 動態 ports：dynamic ports、`output_overrides`。
  - 匯流：join（`all / any` 加上 `inputs` 展開）、merge（`array / object / first`）。
  - 執行語意：dead-path 的 skipped 傳播。
  - loop：`max_iterations`、`until`（11 種 op）、`carry`、`on_body_failure`、loop_in / loop_out。
  - 其他 composite：foreach（`max_items`、`on_item_failure`）、subflow。
  - 執行紀錄：scope / iteration 鍵。
  - agent 設定：retry / timeout、`instance_overridable`。
- 連線量：
  - `fix-until-tests-pass.json`：14 個節點（含 body），22 條 data edge 加 14 條 control edge。14 條 control edge 裡約 7 條只是重複 data 依賴，例如 `start.success→planner` 和 `start.request→planner.request` 表達的是同一件事。
  - `nested-review.json`：13 個節點、31 條 edge、13.3 KB JSON。每條 edge 約 120 字元：`{kind, from:{node,port}, to:{node,port}}`。
- **實際踩坑（AI 視角的直接證據）**：這一輪我自己手寫巢狀測試 workflow 時，第一次編譯就錯兩次。
  1. loop 的 control 輸出寫成 `success`，正確是 `completed`。
  2. 忘了 log 節點必填的 `message`。
  
  compiler 都抓到了，但這表示 **agent 一定要先拿到每個節點的 schema，而且要有 validate → 修正的迴圈**。
- 引擎的特例：`engine.ts:173` 為 `join(all)` 寫了專門的 skip 規則。dead-path 語意已經需要逐節點特判。
- 這一輪為了巢狀 drill-down 和 subflow 唯讀加的東西：
  - `graph-path.ts` 122 行；
  - monitor 的 scope 解析；
  - `subflow_started` 快照；
  - `PUT /api/workflows` 加 422 保護；
  - 前端導覽與唯讀邏輯，約 +250 行。

  用處很大，但說明 **subflow 和多層巢狀會一路帶進版本 / 引用 / 回放的問題**。

## 各區塊評分

複雜度：1 = 很簡單，5 = 很難懂 / 很難維護。v1 價值：1 = 可有可無，5 = 核心。

| 區塊 | 複雜度 | v1 價值 | 建議 | 理由 / 證據 |
|---|---|---|---|---|
| Typed ports + JSON Schema 相容檢查 | 3 | 5 | **保留，簡化** | 擋錯最有效；v1 型別限制在 string / number / boolean / object / array\<T\> / 具名型別 |
| data edge 與 control edge 兩種連線 | 4 | 2 | **簡化** | 人要拉兩種線，agent 要記每種節點的 control port。v1 改成「只有 data edge」，執行順序從資料依賴推出來；分支用 condition 的 `true` / `false` **資料輸出**路由（n8n 式） |
| Condition | 2 | 5 | **保留** | 改成資料路由：值從 `true` 或 `false` 輸出 |
| Switch | 3 | 2 | **延後** | 多個 condition 就能做到 |
| Join（all / any、inputs 展開） | 4 | 1 | **v1 拿掉** | 沒有 control edge 後，「等所有輸入都有值」就是隱含的 join |
| Merge（array / object / first） | 3 | 2 | **簡化** | 只留「分支匯流取第一個有值的」，或併進 end |
| Skipped / dead-path 傳播 | 4 | 3 | **簡化（隱藏）** | 引擎內部保留；UI 只顯示灰色「未走到」，使用者不必理解規則；拿掉 join 特例 |
| Loop composite（body、loop_in / out、carry、until、4 個 control 輸出） | 5 | 5 | **簡化** | v1 只留一種「重試直到條件成立」：`max_iterations` + `until`，carry 用慣例（輸出 `feedback` 自動帶進下一輪），只剩 `completed` / `failed` 兩種結果 |
| 巢狀 loop（loop 裡的 loop） | 4 | 1 | **v1 拿掉（引擎保留）** | 引擎、compiler 已支援也有測試；v1 由 compiler 規則擋掉，降低 authoring 和監控的心智負擔 |
| Foreach | 4 | 2 | **延後** | 平行 / 逐項是第二階段需求 |
| Sub-workflow | 4 | 2 | **延後** | 會帶進引用版本、唯讀、存檔相容性（目前只驗證自己，不檢查引用者）、快照回放 |
| 巢狀 drill-down UI（breadcrumb、多層 iteration 選擇） | 4 | 2 | **延後（程式保留）** | 沒有巢狀和 subflow 時，一層 body 檢視就夠；breadcrumb 留著，最多兩層 |
| Scope / record key（`a#0/b#1/node`） | 3 | 4 | **保留（只在內部）** | 監控 loop 一定要；MCP / UI 改回結構化的 `{node, iteration}`，不要讓人或 agent 拼字串 |
| 節點數 27 | 3 | — | **簡化到大約 10 個** | 見下方 v1 節點清單 |
| Agent 權限鎖定（實例只能改 max_turns / timeout / retry） | 1 | 5 | **保留** | 規則簡單、安全價值高 |
| Retry / timeout | 2 | 4 | **保留**（只放在 agent 節點） | — |
| Resume（沿用成功的 agent 輸出，builtin 重跑） | 4 | 2 | **延後**（v1 只留 cancel 和「整個重跑」） | 語意不直覺：HTTP 等有副作用的節點會重跑；還要懂 scope 對應 |
| Replay 滑桿 | 2 | 2 | **保留但不強調** | 成本低：事件 reduce 已經有了 |
| 瀏覽器內執行模式 | 3 | 1 | **v1 拿掉**（只留給 demo） | 兩條執行路徑、兩套 services、還要打包 workflows |
| Planner（Phase 4） | 3 | 2 | **延後** | 外部 agent 透過 MCP 寫 workflow 就能取代 |
| Transform（JSONata） | 2 | 4 | **保留** | agent 寫 JSONata 還算可靠；template 處理字串 |
| file_read / file_write、HTTP 白名單 | 3 | 2 | **延後檔案節點** | 等 worktree / container 隔離方案 |
| `output_overrides`、可編輯的 port schema | 3 | 2 | **收進「進階」** | 專家功能 |

## 提議的最小 v1

**概念，6 個**：
- Workflow；
- Node（從目錄挑）；
- Port（型別很少）；
- Connection（只有一種）；
- Run（每個節點的狀態與 I/O）；
- Retry Loop（一層）。

**執行規則**用一句話講得完：節點在「所有連入的輸入都有值」時執行。condition 只把值送往 `true` 或 `false` 其中一邊，沒收到值的下游顯示「未走到」。

**節點，約 10 個**：
- start、end；
- agent：registry 裡的 planning / coding / testing / review / report，都是同一種「agent」節點；
- condition；
- loop（retry-until）；
- transform、template；
- http_request；
- parse_json（可選 schema，合併 json_parse 與 schema_validate）；
- log。

**畫面，3 個**：
1. 編輯器：畫布、節點目錄、屬性、即時驗證。
2. 執行監控：同一張畫布上色，加上節點 I/O 和 iteration 選擇。
3. 執行紀錄：列表，可以唯讀開啟。

**MCP 工具，8 個**：

這一層包在現有 Fastify API 外面，大部分端點已經有了。

| 工具 | 回傳 | 現況 |
|---|---|---|
| `list_node_types()` | 名稱、一行說明、ports 摘要 | `/api/registry` 已有，要瘦身 |
| `get_node_type(name)` | ports、config_schema、合法連線範例 | 已有資料，要加範例 |
| `list_workflows()` / `get_workflow(id)` | — | 已有 |
| `validate_workflow(workflow)` | 結構化診斷：code、node 路徑、port、expected vs actual、**修正建議** | 已有，缺修正建議 |
| `save_workflow(id, workflow)` | 有錯誤就拒絕 | 這一輪剛加的 `PUT` |
| `run_workflow(id \| workflow, inputs, wait?)` | run_id，或等待後的結果摘要 | 已有 |
| `get_run(run_id, node?, iteration?)` | 狀態加每個節點的摘要，**不是** 200 筆事件 | 要新增摘要 |
| `cancel_run(run_id)` | — | 已有 |

延後：`patch_workflow`（`add_node` / `connect` 之類的局部編輯操作），以免 agent 每次重寫 13 KB 的 JSON。

**DSL 對 agent 的改善**：
- 連線改成精簡字串 `"planner.tasks -> loop.tasks"`；
- 不再寫 control edge；
- 每種節點的錯誤附修正建議，例如「loop 沒有 `success`，可用：completed、failed」。

## 遷移計畫（短）

1. **凍結現況**：在本機 tag `poc-full`，程式不刪。
2. **DSL v1**：
   - edge 改成精簡格式、拿掉 `kind`；
   - compiler 從 data 依賴推出執行順序；
   - condition 改成資料路由；
   - 寫 v0→v1 轉換器：把重複的 control edge 丟掉，把 join 換成隱含等待。用 `fix-until-tests-pass.json` 驗收。
3. **Registry 分級**：節點加上 `tier: v1 | advanced`，UI 和 MCP catalog 預設只列 v1；compiler 加 v1 規則（例如 `NESTED_LOOP_NOT_IN_V1`）。
4. **引擎**：GraphRun 和 scope 留在內部；loop 改用 carry 慣例；foreach / subflow / resume 放到 `advanced` 旗標後面。
5. **MCP server**：用官方 TypeScript SDK 做 stdio server，把上面 8 個工具包在現有路由外面；`get_run` 加摘要；診斷加修正建議。
6. **UI**：預設隱藏瀏覽器模式、resume、`output_overrides`、兩層以上的巢狀；工具列只留「執行 / 停止 / 存檔」。
7. **測試**：v1 範圍的測試改用新 DSL；進階功能的測試搬到 `test/advanced/` 繼續跑，確保延後的功能不會壞。
