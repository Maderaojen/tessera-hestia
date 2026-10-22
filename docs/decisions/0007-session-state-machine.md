# ADR 0007：Session 狀態機（CLI 生命週期 × 這一輪的階段）

- 狀態：已實作
- 更新：2026-10-15
- 英文版：[0007-session-state-machine.en.md](0007-session-state-machine.en.md)

使用者同意「待確認」四點全部照提案。三段都已實作：第 1 段（純函式）；第 2 段（資料結構拆分：`status` 只剩生命週期、新增 `turnPhase`、讀取時遷移、公開 API 相容欄位）；第 3 段（前端統一：燈號改看 `activity`、新增「可能卡住」燈號，停止鈕與恢復對話確認文字改看 `turnPhase`）。

## 背景

`status`（`idle` / `launching` / `ready` / `waiting` / `needs_interaction` / `dead`）同時裝了兩件事：

- **CLI 本身**：還沒啟動、啟動中、活著、已結束。由啟動、`/clear` 重啟、恢復 Claude、存活檢查、tmux 對帳決定。
- **這一輪的階段**：閒置、等回覆、等使用者確認。由送出訊息、輪詢觀察決定。

再加上 `pendingInteraction`、`lastError`（卡住提示）、`paneActivity`、`claudeClearPending` 各自獨立，造成：

1. **寫入分散**：`status` 在 `registry.ts`、`polling.ts`、`routes/messages.ts` 共 20 處被直接寫入，沒有一處說明「哪些狀態可以轉到哪些狀態」。
2. **畫面各看各的**：
   - 狀態燈號（Home、聊天標題列）看 `status`。
   - 終端機按鈕看衍生的 `activity`。
   - 停止鈕、「生成中」泡泡、恢復對話的確認文字看 `status`。

   例如 `waiting` 但畫面已閒置時，按鈕顯示閒置，燈號卻是「回覆中」，停止鈕也還在。
3. **一個欄位多種用途**：`lastUserMessageAt` 同時用在送達確認、卡住計時、判斷終端機新訊息，已經因此出過錯（按控制鍵造成誤判）。

## 決策

### 1. 拆成兩個維度

**CLI 生命週期 `runtime`**（沿用 `status` 欄位，但只保留生命週期的值）：

| 值 | 意義 | 由誰改 |
|---|---|---|
| `idle` | tmux 在，還沒啟動 CLI | 建立 session、CLI 結束後 |
| `launching` | 啟動／`/clear` 重啟／恢復中 | 啟動、clear、resume 流程 |
| `ready` | CLI 活著 | 啟動成功 |
| `dead` | tmux 已結束 | tmux 對帳、恢復失敗 |

**這一輪的階段 `turn.phase`**（新欄位，實作為 `ManagedSession.turnPhase`；只在 `runtime === 'ready'` 時有意義，其他生命週期一律視為「沒有這一輪」；每次進入 `ready` 都重設為 `idle`）：

| 值 | 意義 |
|---|---|
| `idle` | 沒有進行中的一輪，可以送出 |
| `replying` | 已送出（或偵測到終端機輸入），等 CLI 回覆完成 |
| `awaiting_approval` | CLI 停在權限提示，等使用者確認 |

「疑似卡住」不是階段，而是 `replying` 期間的提示旗標；「CLI 正在忙／畫面閒置」是觀察值（`paneActivity`），不是階段。

### 2. 階段轉換集中在一個純函式

每次輪詢先收集「觀察」，再交給純函式決定下一個階段與要做的事：

```
nextTurn(current, observation) → { phase, effects[] }
```

- 觀察：有沒有新的終端機使用者訊息、紀錄檔是否靜止、這一輪是否結束（`isTurnComplete`）、有沒有權限提示（紀錄檔＋畫面確認）、畫面忙碌／閒置、安靜了多久、有沒有可匯入的變更。
- 要做的事（effects）：匯入輪次、設定／清除待確認的工具、設定／清除卡住提示、更新 `paneActivity`。
- 路由（送出、停止、`/resume`）也走同一個函式，以「事件」的形式送進去，不再自己寫 `status`。

轉換表：

| 目前 | 事件／觀察 | 下一個 | 要做的事 |
|---|---|---|---|
| 任何（見下方註） | App 送出訊息 | `replying` | 記錄送出時間與文字 |
| `idle` | 偵測到終端機新訊息且未完成 | `replying` | 同上（以紀錄檔時間） |
| `idle` | 有已完成但未匯入的輪次 | `idle` | 匯入 |
| `idle` | 紀錄檔結尾有一輪還開著、是人開的，而且 App 結束上一輪之後紀錄檔又寫入過（10 分鐘內） | `replying` | 那則訊息沒記錄過（終端機打的）就照終端機新訊息記錄；記一筆事件 |
| `idle` | 紀錄檔結尾有一輪還開著（CLI 自己開的），有新內容 | `idle` | 匯入目前內容，之後原地變長 |
| `replying` | 權限提示（紀錄檔＋畫面都確認） | `awaiting_approval` | 設定待確認工具 |
| `awaiting_approval` | 提示消失 | `replying` | 清除待確認工具 |
| `replying` | 靜止＋完成（或無法判斷）＋這次送出的訊息已出現在輪次裡 | `idle` | 匯入、清提示 |
| `replying` | 靜止＋未完成＋畫面連續閒置 5 秒＋紀錄檔安靜 15 秒 | `idle` | 匯入現有內容、清提示；記一筆事件 |
| `replying` | 靜止＋未完成＋已寫出部分內容 | `replying` | 先匯入目前內容，之後原地變長 |
| `replying` | 有內容更新，但這次送出的訊息還沒出現（例如前一輪還在寫） | `replying` | 匯入那些內容 |
| `replying` | 安靜 ≥30 秒且畫面不忙 | `replying` | 設卡住提示 |
| `replying` | 紀錄檔又有變動 | `replying` | 清卡住提示 |
| `replying` / `awaiting_approval` | 按停止 | `idle` | 送 Esc、背景匯入被中斷的一輪；記一筆事件（有沒有看到中斷標記） |
| `replying` / `awaiting_approval` | `/resume`（手動解鎖） | `idle` | 清待確認工具、清提示 |
| 任何 | `runtime` 離開 `ready` | `idle` | 清待確認工具、清提示、清觀察值 |

表裡沒有的組合一律不轉換，並在測試中逐一確認。

註（2026-10-15）：「這一輪開著沒」以主紀錄檔為準，畫面判讀與 App 自己的動作（停止）都只是提示。停止的 Esc 可能沒有中斷 CLI（例如被 CLI 當下開著的別的畫面吃掉），畫面也可能把別的畫面誤判成閒置；這時 App 雖然已經結束這一輪，紀錄檔一顯示那一輪還在寫，就由上表 `idle` 的兩列接回來。

註：「App 送出訊息」在每個階段都接受，不只 `idle`——輸入框刻意不依我們自己的就緒判斷上鎖（見 `routes/messages.ts`），因為偵測不到的情況（例如不寫入紀錄檔的 slash command）會讓輸入框永久無法使用。第 1 段即照此實作。

### 3. 單一寫入入口

`registry.applyTurnTransition(sessionId, conversationId, result)`：套用上面函式的結果、一次寫入、一次推送 SSE。其他地方不再直接寫 `turn.phase`、`pendingInteraction`、卡住提示。`runtime` 的寫入維持在既有的啟動／clear／resume／對帳函式中，但集中檢查允許的轉換。

實作（第 2 段）：寫入入口是 `sync/turnEffects.ts` 的 `applyTurnEffects`（`turnPhase` 只由 `enter_phase` 改變）；`status` 的每次寫入都經過 `registry.ts` 的 `lifecycleTransition`，對照 `LIFECYCLE_TRANSITIONS` 檢查，非預期的轉換只記警告、照樣套用。`runtime_left_ready` 由 `applyRuntimeLeftReady` 在 CLI 結束、對帳發現 tmux 消失、開始 `/clear` 或切換對話時送出。

### 4. 拆開 `lastUserMessageAt` 的用途

| 用途 | 改用 |
|---|---|
| 送達確認、判斷終端機訊息是否比最後送出的新 | 沿用 `lastUserMessageAt` / `lastUserMessageText`（見下方註） |
| 卡住計時 | 記憶體中的紀錄檔最後變動時間、最後按鍵時間（已在 `sync/tracker.ts`） |

註（第 2 段）：自從 `/respond` 按控制鍵不再寫 `lastUserMessageAt`（改記在 `sync/tracker.ts` 的 `lastControlKeyAt`），這兩個欄位只會在「App 送出」或「偵測到終端機訊息」時寫入（`record_sent` effect），本身就已經是「送出時間／送出文字」，所以不改名、也不另開 `turn.sentAt` / `turn.sentText`。

### 5. 前端只看一個狀態

後端繼續輸出單一的 `activity`（`ended` / `starting` / `not_started` / `awaiting_approval` / `stalled` / `busy` / `idle`），前端所有指示都改看它：

- 狀態燈號（Home、聊天標題列、燈號說明）：`SESSION_STATUS_META` 改以 `activity` 為 key，新增「可能卡住」燈號。
- 終端機按鈕：維持現狀（已經看 `activity`）。
- 停止鈕、「生成中」泡泡、恢復對話確認文字：改看 `activity`（或 `turn.phase`），不再看 `status`。

### 6. 相容與遷移

- **既有資料**：讀取 registry 時，`status: 'waiting'` 轉成 `status: 'ready'` + `turnPhase: 'replying'`，`needs_interaction` 轉成 `ready` + `awaiting_approval`，沒有 `turnPhase` 的紀錄補 `idle`；進行中的啟動／clear／切換嘗試裡的 `previousStatus` 也照同樣規則拆成 `previousStatus` + `previousTurnPhase`。可重複執行，不需要手動遷移。（`lastUserMessageAt` 不搬，見 §4 註。）
- **舊版前端**（PWA 快取可能還在跑舊版）：公開 API 保留一個衍生的舊 `status`（由 `runtime` + `turn.phase` 算回原本的六個值），至少保留一個版本，避免舊前端壞掉。

## 實作分三段（每段都可單獨合併、部署）

1. **純函式與觀察值**：新增 `nextTurn` 與轉換表測試；`polling.ts` 改成「收集觀察 → 呼叫 `nextTurn` → 套用結果」，但仍寫回現有欄位。行為不變，現有測試全部照過。
2. **資料結構拆分**：`turn.phase` / `turn.sentAt`、單一寫入入口、讀取時遷移、公開 API 相容欄位。
3. **前端統一**：燈號、停止鈕、泡泡改看 `activity`。

## 測試

- `nextTurn` 以轉換表為準的表格測試：每個「目前 × 事件」組合，包含表中沒有、應該不轉換的組合。
- 既有的 polling / routes 測試在第 1 段完全不改，作為行為不變的證明。
- 遷移：舊格式 registry 讀入後的欄位對應。
- 相容：公開 API 的舊 `status` 由新欄位算回來，與舊行為一致。
- 前端：每個 `activity` 對應的燈號、按鈕、停止鈕、泡泡文字一致。

## 已確認（2026-09-24）

1. `status` 沿用為 CLI 生命週期欄位（`idle` / `launching` / `ready` / `dead`），不改名。
2. 「疑似卡住」是 `replying` 期間的提示旗標，不是階段。
3. 狀態燈號改看 `activity`，新增「可能卡住」燈號。
4. 公開 API 保留衍生的舊 `status` 一個版本後再移除。
