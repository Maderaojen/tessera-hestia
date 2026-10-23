# API 契約 v1

- 更新：2026-10-19
- 英文版：[api-contract-v1.en.md](api-contract-v1.en.md)

## 目標

前後端對「API 長什麼樣子」只有一份定義，公開前端面對不同版本的後端時可以協商，錯誤與狀態不再用 zh-TW 字串表示。

## 契約放在哪裡

`api/src/contract/`，純 TypeScript，沒有任何執行期依賴，也不 import 這個目錄以外的東西（`api/test/contract.test.ts` 會檢查）。

可選模組（`api/modules/*`，見[架構](architecture.md)）有自己的契約，放在模組自己的資料夾裡，不在這份文件，也不在公開版。

| 檔案 | 內容 |
|---|---|
| `runtimes.ts` | `Provider`、`RuntimeId`、各 runtime 的顯示名稱表、runtime 能力名稱 |
| `sessions.ts` | 工作階段／對話／turn 的 DTO、`SessionListEvent`、舊版欄位（`LegacySessionDto`） |
| `projects.ts` | 收件匣的 id（名稱由 App 依 id 用自己的語言顯示）、project／note DTO、建立 note 的請求 |
| `attachments.ts` | 附件、上傳回應、訊息裡的附件範圍 |
| `errors.ts` | 錯誤碼與錯誤回應的形狀 |
| `meta.ts` | 契約版本、API 功能名稱、`GET /api/health` 與 `GET /api/meta` 的形狀、啟動選項 |
| `tags.ts` | 便箋 tag 的解析規則（原本前後端各一份） |
| `pairing.ts` | `hestia pair` 的配對連結格式（網頁連結與 App 深層連結）與解析 |
| `repo.ts` | 專案的檔案與 git（唯讀）：專案路徑的 git 狀態、未 commit 的檔案、未 push 的 commit、diff、commit 詳情、檔案樹與檔案內容、本機分支的歷史 |

**為什麼放在 `api/` 底下，而不是 repo 根目錄的 `contract/` 套件**：API 用 `tsc` 編譯，`rootDir` 是 `api/`，輸出的 `dist/src/main.js` 寫死在 systemd unit、installer 和 `bin/hestia` 裡。放在 `api/` 以外，編譯輸出的目錄結構就會改變；做成獨立套件，則每次部署都要先 build 套件再 `npm install`。放在 `api/src/contract/`，API 的 build 完全不變；前端直接引用同一份原始碼一起打包，不需要額外的建置步驟。

- API 端的 `toSessionDto`、`toPublicManagedSession`、`toPublicConversation` 都以契約的型別為回傳型別，欄位有出入時會直接編譯失敗。
- 前端 `api.ts` 的 `ManagedSession`、`Turn`、`NoteRecord` 等名稱沿用，但型別都來自契約。

## `GET /api/health`

不需要登入。回傳 `{ "ok": true, "name": "hestia" }`：`name` 是這套安裝的指令名稱（`install.sh --command-name`，例如正式版 `hestia`、dev `hestia-dev`），讓 App 在登入任何一套之前，就能列出一台 SSH 伺服器上有哪幾套 Hestia。指令名稱不是機密：打得到這個路徑的人本來就連得到後端。比這個欄位舊的後端只回 `{ "ok": true }`，App 以 port 稱呼它（「Hestia（port 4791）」）。

## `GET /api/meta`

需要登入（和其他 API 一樣）。回傳：

```json
{
  "apiVersion": "0.1.0",
  "contractVersion": 1,
  "capabilities": ["error_codes", "interrupted_flag", "session_list_stream", "attachments", "conversation_clear", "repo_view"],
  "modules": [],
  "runtimes": [{ "id": "claude-code", "provider": "claude", "label": "Claude Code", "capabilities": ["resume", "clear", "interrupt", "startup_prompt", "quota", "janus", "subagents"] }],
  "nativeLaunchOptions": [{ "id": "native:claude", "provider": "claude", "runtimeId": "claude-code", "label": "Claude (原生)", "source": "native" }]
}
```

- `runtimes` 由 runtime driver 產生：顯示名稱是 driver 的 `label`，能力由 driver 宣告的內容推導（`resume` 能力、驗證過的退出方式、中斷鍵、啟動提示辨識、額度、Janus、subagent）。
- `nativeLaunchOptions` 不含執行檔路徑與參數。
- `modules` 是這個後端啟動時載入的可選模組的 id（`api/modules/*`，沒有載入任何模組時是空陣列）。`capabilities` 是 Hestia 本身的功能（`API_CAPABILITIES`），加上已載入的模組各自宣告的 capability；模組的 capability 寫在它自己的契約裡。比 `modules` 舊的後端沒有這個欄位，當成沒有載入任何模組。
- `contractVersion` 只在不相容的改變時才加一；新增欄位、端點、錯誤碼或功能時不變，改由 `capabilities` 宣告。前端遇到不認得的 capability 一律當成沒有。

### 前端怎麼用

網頁前端依主機 id 把 meta 快取在記憶體中，登入確認後（`shell/authState.ts`、`LoginView`）載入一次，畫面渲染時只讀取、不發請求。

| 用途 | 有 meta | 沒有 meta（舊後端回 404，或還沒載入） |
|---|---|---|
| runtime 顯示名稱 | 後端的 `label` | 契約的名稱表，再不行就顯示 provider |
| 啟動面板的備用選項（catalog 載入失敗時） | `nativeLaunchOptions` | 不提供選項，錯誤訊息改成「無法載入啟動選項」 |
| subagent 泡泡 | 只問有 `subagents` 能力的 runtime | 一律詢問（後端對沒有 subagent 的 CLI 回空清單） |
| 首頁列表 | 有 `session_list_stream` 時改用串流 | 維持每 5 秒輪詢 |
| 對話標題選單的「建立新對話」 | 後端有 `conversation_clear`（`POST /sessions/:id/clear`；舊 CLI 逾時未退出時 `clearPending.phase` 為 `awaiting_force`，可 `POST …/clear/force` 或 `…/clear/cancel`）且該 runtime 有 `clear` 時才顯示 | 不顯示（仍可在輸入框送 `/clear`） |
| iOS／Android App 的通知 | 後端有 `native_push` 時可以開啟（見下方「App 的推播訂閱」） | 「設定 › 通知」說明主機版本太舊，開關停用 |
| 專案的「變更與 Git」 | 後端有 `repo_view` 時，對話標題列、專案的 ⋯ 選單與桌面版工具窗格才有入口（見下方「專案的檔案與 Git」） | 不顯示入口 |
| 刪除工作階段與「垃圾桶」 | 後端有 `session_trash` 時，刪除的確認文字說明會移到垃圾桶；側邊欄有所有專案的「垃圾桶」，專案的 ⋯ 選單有這個專案的（見下方「工作階段垃圾桶」） | 沿用「刪除後無法找回」的確認文字，不顯示垃圾桶 |
| 對話摘要 | 後端有 `recap` 時，「設定 › 主機與自動化」有「對話摘要」區塊，工作階段列的 ⋯ 選單有「查看摘要」，兩條工作階段串流的網址加 `include=recap`（見下方「對話摘要」） | 不顯示任何摘要入口與設定 |

原本寫死在前端的四筆備用啟動選項已刪除。

## 配對連結

`hestia pair` 印出（並放進 QR code）的連結，格式定義在 `contract/pairing.ts`：

| 種類 | 格式 | 誰打開 |
|---|---|---|
| `web` | `https://<網頁前端>/login?mode=add&url=<後端網址>#pair=<配對碼>` | 網頁前端的 `LoginView` |
| `app` | `hestia://pair?url=<後端網址>#code=<配對碼>` | native app（註冊 `hestia` scheme） |

- 後端網址在 query（`encodeURIComponent`），一次性配對碼在 `#` 後面：瀏覽器不會把 fragment 送給任何伺服器。
- 用配對碼換 token 的端點仍是 `POST /auth/pair`。body 可以多帶選用的 `device`（字串，最多 200 字，後端只留可列印字元的前 80 字），是這支手機的名稱，只用來讓 `hestia pair` 顯示誰用了配對碼；舊的後端會忽略它。
- 配對碼 3 分鐘內有效（2026-10-03 前是 10 分鐘）、只能用一次。
- `hestia pair` 印出 QR code 後會等配對碼被使用，靠兩個只給本機 CLI 的端點（和 `POST /auth/pairing-code` 一樣，要 local tool token、而且是本機直接連線）：
  - `POST /auth/pairing-code/status`，body `{ code }` → `{ status: 'pending', expiresInMs }`、`{ status: 'used', usedAt, device }`（`device` 可能是 `null`）或 `{ status: 'expired' }`（不認得的碼也回 `expired`）。
  - `POST /auth/pairing-code/revoke`，body `{ code }` → `{ ok: true, revoked }`：登出這組配對碼換到的那個登入（用過的碼記 1 小時）。
  - `POST /auth/pairing-code/cancel`，body `{ code }` → `{ ok: true, cancelled }`：讓一組還沒用過的配對碼立刻失效（`hestia connect` 在手機改走 SSH 或指令提前結束時用）；用過的碼不受影響。
- **打開連結不能直接配對**：先顯示後端的完整 origin，使用者按確認後才呼叫 `POST /auth/pair`，取消就丟掉配對碼（網頁版已經這樣做；App 必須保留同一個確認步驟）。任何人都能傳這種連結，自動配對等於讓對方把你加到他的後端。
- `parsePairingLink()` 兩種都認得，App 內建的掃描器兩種都接受：`hestia pair` 預設印的是網頁連結。App 在「新增主機」掃到的連結一樣先走確認畫面；在 SSH 主機的「登入 Hestia」掃到的只取配對碼、直接經 tunnel 配對（忽略連結裡的網址）。
- CLI 選哪一種：`hestia pair --link web|app|both`，預設看 `.env` 的 `HESTIA_PAIR_LINK`，再來是 `web`（`docs/guides/install.md`）。
- 這些都是新增的格式、端點與選用欄位，沒有改變既有的端點或欄位，所以 `contractVersion` 維持 1。格式本身之後只新增參數、不改名：舊的連結要一直能被新的前端或 App 讀懂。

## 錯誤碼

所有錯誤回應都經過 `api/src/routes/errors.ts` 的 `sendError`：

```json
{ "code": "session_dead", "message": "session is dead", "params": {}, "error": "session is dead" }
```

- `code` 定義在 `contract/errors.ts`，只會新增、不會改變意思。
- `message` 是後端自己的文字，用於紀錄，以及前端不認得這個 code 時的備援。只在 HTTP 回應出現的是英文；後端自己也會拿來當狀態或通知的（啟動、恢復、切換對話的失敗原因等）依請求的語言（見下方「回應的語言」）。
- `params` 帶文案需要的值（例如 `no_running_cli` 的 `status`、`resume_unsupported` 的 `provider`）。
- `error` 和 `message` 內容相同，**只為了快取裡的舊版 PWA**（它們直接顯示這個欄位）。
- 網頁前端以 `Record<ErrorCode, …>` 對應 zh-TW 文案，契約新增 code 卻沒有文案時會編譯失敗。原本已經是中文的訊息逐字保留；原本是英文的（例如 `session is dead`、`incorrect username or password`）改成中文。
- `ApiError` 帶有 `status`、`code`、`params`，呼叫端顯示 `err.message` 就是在地化後的文字。
- 對話不能繼續的原因（`ConversationSummary.resumeBlockedReason`）另外帶 `resumeBlocked: { code, params }`，前端同樣依 code 顯示。

`api/test/contract.test.ts` 會掃描 `api/src`，確保沒有路由再直接回 `{ error }`。

### 回應的語言

- 請求的 `Accept-Language` 決定後端回應裡給人看的文字用哪種語言（`zh*` 為繁體中文、`en*` 為英文，其他或沒有時用主機的語言）。網頁前端每個請求都帶自己的介面語言；這是 CORS 不用另外允許的標頭，舊後端照常接受。
- 主機的語言：帶 `Authorization: Bearer` 的請求（App 自己的 API client）帶的語言，記在狀態目錄的 `interface-locale.json`，預設繁體中文。後端在沒有請求時寫的文字用它：推播、工作階段的 `lastError`、交接與指派的狀態和原因、帳號額度的錯誤。
- 寫給 LLM 或打進 CLI 的文字（交接檔、指派與支線的說明檔、摘要的提示、交接與指派打進 tmux 的那一行、指派的紀錄）不分語言，一律是中文。

## 字串狀態改成欄位

### 卡住提示：`stuckSince`

- 原本是把一段中文句子寫進 `lastError`，`deriveSessionActivity` 再逐字比對。現在是 `ManagedSession.stuckSince`，由 turn machine 的 `set_stuck_hint`／`clear_stuck_hint` 設定與清除；`clear_last_error` 仍然會一起清掉兩者（語意：清除畫面上顯示的所有提示）。
- 任何真正的 lifecycle 轉換都會清掉 `stuckSince`（回滾到同一個 CLI 的情況除外），和原本「寫入 `lastError` 就蓋掉提示」的效果一致。
- `lastError` 只留給真正的錯誤。
- registry schema **v2**：舊紀錄中 `lastError` 等於那段句子的，改成 `stuckSince`。

### 中斷的回覆：`assistant.interrupted`

- 原本 Claude parser 把 `（已中斷）` 寫進回覆文字，停止後的匯入再用 `endsWith` 判斷。現在 turn 帶 `assistant.interrupted: true`，文字只保留已經產生的部分。
- 「只有中斷標記變了、文字沒變」也算是 turn 有更新（`diffTurns`、`turnsFingerprint` 都會反映）。
- registry schema **v3**：已儲存的 turn（對話裡的與工作階段上的鏡像）去掉結尾的標記並加上旗標。
- dialogue archive 之後寫入的是乾淨的文字加旗標；已經寫出的舊紀錄不動。
- 前端 `lib/replyText.ts` 自行決定怎麼顯示（目前和原本完全相同：內容後面接 `（已中斷）`）。

## CLI 等待中的確認與提問：`PendingInteraction.screen`

- `pendingInteraction` 多了 `kind: 'question'`（AskUserQuestion），以及選填的 `screen: InteractionScreen`：從 CLI 畫面讀到的內容（`kind` 為 `permission`／`question`／`review`、標題、說明、選項、是否複選、題數進度）。目前只有 Claude Code 會帶；沒有 `screen` 時前端維持舊的卡片（方向鍵、看終端機）。
- 只從畫面讀到的提示（Claude Code 2.1.284 等待期間不寫 transcript），`toolUseId` 是 `pane:<雜湊>`、`input` 是 `null`。畫面換到下一題或勾選改變時，`toolUseId` 會跟著變。
- `POST /api/sessions/:id/interaction`，body `{ promptId, option, text? }`：`promptId` 是當時看到的 `toolUseId`，`option` 是選項編號或 `'next'`（複選題的「Next」），`text` 用於自由輸入欄或權限附註。成功回工作階段；錯誤碼 `no_interaction`、`interaction_changed`、`interaction_answer_invalid`、`interaction_unconfirmed`。
- 有提示在等待時，`POST /messages` 與 `/clear` 回 409 `interaction_pending`，不再把文字加 Enter 打進提示裡（權限提示的 Enter 會直接核准）。
- 相容性：舊前端收到 `interaction_pending` 會顯示後端的中文訊息；新前端遇到沒有 `screen` 的舊後端時，送出同樣會被擋下，改用方向鍵或終端機回應。

## DTO 瘦身與列表串流

- 新增 `SessionDto.lastActivityAt`（active 對話最後一則回覆或訊息的時間，否則最後一次送出，否則建立時間），列表依它排序。
- `toSessionDto` 是契約 v1 的工作階段 DTO，不含已棄用的欄位；`toPublicManagedSession` 是它加上舊欄位，舊有端點都繼續送這個版本。
- `GET /api/sessions/events`：連線後先送 `{ type: 'snapshot', sessions }`，之後每次變動送 `update`／`deleted`（有 `session_trash` 的後端還有 `restored`），內容是精簡版 DTO（沒有 turns）。先訂閱再讀清單，讀取期間收到的事件排在 snapshot 之後送出，所以不會漏掉。EventSource 重連時會重新拿到 snapshot。stream ticket 可以開這條串流。
- 前端列表在 meta 宣告 `session_list_stream` 時改用串流，`GET /sessions` 不再每 5 秒輪詢；projects 仍然每 5 秒重新讀取（資料量小），另外遇到未知 project 的工作階段時補讀一次。
- 前端完全不再讀 `status`、`claudeClearPending`、工作階段上的 `turns`，也改呼叫 `/recover`。

## 附件模型

- 上傳回傳 `{ attachment: { id, kind, url, promptText }, path }`。`id` 是 `<資料夾>/<檔名>`，`url` 是相對於 API 根目錄的路徑，`promptText` 是讓 CLI 讀圖的文字，由後端決定。其他檔案與貼上文字見下面「輸入框的附件」。
- `api/src/attachments.ts` 自己組出檔案路徑，拒絕任何可能跑出 `UPLOADS_DIR` 的 id，並保留唯一一份圖片類型表（原本 `config.ts` 與 `uploads.ts` 各有一份）。
- 送出的 turn，每則訊息都帶 `attachments: [{ id, kind, url, start, end }]`，`start`／`end` 是路徑在文字中的位置。在送出時辨識，不存進資料，所以舊訊息也有。
- 便箋改存 `attachmentId`；舊資料的 `imagePath` 在讀取時轉成附件 id（無法對應到上傳檔的路徑原樣保留，不丟棄）。建立便箋接受 `attachmentId`，也接受舊前端送來的 `imagePath`；兩者都必須指向這台後端自己的上傳檔，否則回 400。
- 網頁前端只有處理附件的一處還知道舊文案（`請看這張圖片：`）與舊資料夾結構的地方，只用在：舊後端，以及剛送出、後端還沒描述過的那則訊息。

## App 的推播訂閱：`native_push`

iOS／Android App 的 WebView 沒有 Web Push，改經 App 發布者經營的推播 relay（轉給 FCM，再由 FCM 轉給 Apple）。後端不知道 relay 在哪裡，也不需要任何設定：網址隨訂閱從 App 來。

- `POST /api/push/subscriptions` 多接受 `{ "relay": { "endpoint": "<https URL>", "credential": "<1–2048 字元>" }, "hostId"?: string }`。`endpoint` 必須是 `https:`；以 `credential` 去重。原本的 Web Push body 不變。
- `POST /api/push/subscriptions/remove` 多接受 `{ "credential": "<string>" }`；原本的 `{ "endpoint" }` 不變。
- 送通知時，後端對 `endpoint` 送 `POST { "credential", "message": { "title", "body", "url", "tag" } }`（`url` 和 Web Push 一樣帶 `?host=`），逾時 10 秒。回 `404`／`410` 時刪掉這個訂閱；逾時、`5xx` 或其他失敗只記 log，訂閱保留到下一則。
- `credential` 對後端來說是不透明的字串，不要解析它；它等同「送通知給這支手機」的權限，和 Web Push 的 `endpoint` 一樣，和其他訂閱一起存在只有這個使用者能讀的檔案裡。

## 專案的檔案與 Git（唯讀）：`repo_view`

看一個專案底下的檔案與 git：哪些還沒 commit、哪些還沒 push、檔案改了什麼、commit 的內容、資料夾裡有什麼、檔案的內容、本機分支的歷史。全部是 `GET`，不會寫入 repo、不會 fetch，也不會拿 git 的鎖。

| 端點 | query | 回傳（`contract/repo.ts`） |
|---|---|---|
| `GET /api/projects/:id/repos` | – | `RepoRootsResponse`：專案每個路徑的 git 狀態（不是 repo、資料夾已不存在都照列） |
| `GET /api/projects/:id/repo/status` | `root` | `RepoStatus`：分支與 upstream 的領先／落後、未 commit 的檔案、未 push 的 commit、上次 fetch 的時間 |
| `GET /api/projects/:id/repo/diff` | `root`、`path`、`orig?`、`mode=worktree｜staged｜unstaged｜commit`、`commit?` | `RepoDiff`：一個檔案的 diff，切好 hunk、兩邊都有行號 |
| `GET /api/projects/:id/repo/commit` | `root`、`sha` | `RepoCommitDetail`：完整訊息、作者、時間、和第一個 parent 比較的檔案清單 |
| `GET /api/projects/:id/repo/tree` | `root`、`dir=''`、`ignored=0｜1` | `RepoTreeListing`：一個資料夾的項目（資料夾在前），被 gitignore 的項目標 `ignored`，`ignored=0` 時不列 |
| `GET /api/projects/:id/repo/file` | `root`、`path`、`rev?` | `RepoFileContent`：一個檔案的文字；`rev`（`HEAD` 或 sha）時讀那個 commit 裡的版本，例如已刪除的檔案 |
| `GET /api/projects/:id/repo/log` | `root`、`cursor?`、`limit=200`（最多 500） | `RepoLogPage`：本機分支（與 detached HEAD）的 commit，topo 順序、新的在前，一次一頁；第一頁附上 `refs`（`RepoRefs`） |
| `GET /api/projects/:id/repo/worktrees` | `root` | `RepoWorktreesResponse`：`root` 所在 repo 的每一個 worktree（主要的在前）：資料夾、branch、HEAD、資料夾還在不在、沒 commit 的項目數、branch 是否已合併；指派或支線的 worktree 另附它是什麼、是否已結束、現在清理會不會被拒絕。只有中繼資料，不含檔案內容。有 `repo_worktrees` 能力的後端才有 |

- `root` 必須**完全等於**專案登記的其中一個路徑，或這個專案的指派、支線還存在的 worktree（`/repos` 列在專案路徑後面、帶 `spawn` 的那些）；其他路徑一律相對 `root`、用 `/` 分隔。`worktrees` 列出的其他 worktree 只有 `root` 不是 null 的才能當 `root` 讀。
- `tree` 與 `file`（不帶 `rev`）不需要 git：路徑不是 repo 也能用（`isRepo: false`，沒有 `ignored` 標記）。`.git` 不列出；有自己 `.git` 的資料夾是 `submodule`；symlink 的 `linkTarget` 是 `dir`／`file`（在 `root` 底下）、`outside`（指到外面）或 `broken`。被 gitignore 的檔案內容照樣讀得到。
- 路徑只能落在 `root` 底下：`..`、絕對路徑、任何一層 `.git`、往外指的 symlink 都回 `path_outside_project`；後端自己的狀態資料夾與 `.env`、`~/.ssh`、`~/.gnupg` 回 `path_forbidden`。已經不存在的路徑（刪掉的檔案、rename 的來源）以最近一層存在的上層資料夾檢查。
- `mode` 預設 `worktree`（HEAD 對工作目錄，等於 `commit -a` 會帶進去的內容）；未追蹤的檔案顯示成全部新增。`commit` 模式必須帶 `commit`（4–64 位 hex）。
- 「未 push」以上次 fetch 時的遠端狀態為準：有 upstream 就和 upstream 比，沒有就和所有 remote 比，沒有 remote 時 `unpushedBase` 是 `none`。
- `root` 是 repo 的子資料夾時，只看這個子資料夾；commit 詳情裡在它外面的檔案以 `../` 開頭、`outsideRoot: true`，不提供 diff。
- 上限：未 commit 的檔案 2000、未 push 的 commit 100、commit 的檔案 1000（超過時對應的 `…Truncated` 為 true）；diff 5000 行或 512 KiB（`truncated`）；資料夾每層 3000 項（`truncated`）；檔案 1 MiB，超過回 `tooLarge: true`、`text: null`。二進位檔（diff 回 `binary: true`、沒有 hunk；檔案前 8000 bytes 有 NUL 時回 `binary: true`、`text: null`）。每次 git 最多 10 秒，同時最多 4 個。
- `tree` 的 `dir` 不是資料夾時回 `path_not_a_directory`（400）；`file` 的 `path` 不是檔案時回 `invalid_request`；不存在時兩者都回 `path_not_found`（404）。`rev` 只接受 `HEAD` 或 4–64 位 hex，root 不是 repo 時回 `not_a_git_repo`。
- `log` 只有本機分支：`--branches`，HEAD 只在 detached 時加入（在分支上時不影響結果）；不列遠端分支、不含 tag。`refs` 有 HEAD、預設分支（依序：`origin/HEAD` 指的、`init.defaultBranch`、`main`／`master`／`trunk`，本機要有）、每個本機分支的 tip 與 upstream（upstream 的 tip、`ahead`／`behind`，遠端已刪除時 `upstreamGone: true`）、任何 remote 都沒有的 commit `unpushed`（上限 1000；沒有 remote 時 `unpushedBase` 是 `none`），以及分支的指紋 `fingerprint`。欄位怎麼排由前端決定。
- `nextCursor` 帶著分支的指紋：本機分支或 HEAD 移動後，舊的 cursor 回 `repo_changed`（409），請從第一頁重新讀；不是伺服器發的 cursor 回 `invalid_request`。
- 新的錯誤碼：`repo_root_unknown`（400，`root` 不是這個專案的路徑）、`path_outside_project`（403）、`not_a_git_repo`（409）、`commit_not_found`（404）、`git_failed`（502，`params.reason` 為 `timeout`／`unavailable`／`dubious_ownership`／`error`）、`repo_changed`（409，`log` 的 cursor 已過期）。沿用的：`project_not_found`、`folder_not_found`（路徑已不存在）、`path_forbidden`、`invalid_request`。
- 可能含有機密的檔案（規則見下一節「敏感檔案」）：`tree` 照樣列出，項目帶 `sensitive: true`，不含任何內容；`file`、`diff`（含 `orig`）與以它為 `dir` 的 `tree` 回 403 `path_sensitive`。有 `session_files` 能力的後端才這樣做。
- 這一節的端點只收使用者的登入 token；本機工具 token（`X-Hestia-Token`，也就是 tmux 裡的 LLM）回 403 `login_required`（`routes/login-guard.ts`，2026-10-13 起；tmux 裡的 LLM 有自己的 shell，不需要透過 App 讀檔）。

## 額度用完時的自動接續：`continuity`

CLI 額度快用完或撞到上限時，後端可以等重置後自動送一段話讓它繼續，或交接給另一個啟動選項（帳號或 CLI）。撞上限只對 runtime capability 有 `limit_hit` 的 CLI 能判斷（目前是 Claude Code、Codex CLI）。型別在 `contract/continuity.ts`。

| 端點 | 本文 | 回傳 |
|---|---|---|
| `GET /api/continuity` | – | `ContinuityDefaultsResponse`：全域預設值 |
| `PUT /api/continuity` | `ContinuityDefaults` 的任意欄位 | 更新後的預設值 |
| `GET /api/sessions/:id/continuity` | – | `SessionContinuityResponse`：有效政策、這個工作階段的覆寫、待執行的自動繼續、進行中的交接、最近 20 筆紀錄 |
| `PUT /api/sessions/:id/continuity` | `ContinuityDefaults` 的任意欄位；值為 `null` 表示改回預設 | 同上 |
| `DELETE /api/sessions/:id/continuity/pending` | – | 同上（取消待執行的自動繼續） |
| `POST /api/sessions/:id/continuity/handoff` | `{ toProfileId?, interrupt?, briefBy?, afterReport? }`；沒帶 profile 就照 `chain` 挑；`interrupt: true` 表示不等這一輪結束，先中斷回覆；`briefBy`（`current`／`incoming`）與 `afterReport`（`wait`／`continue`）是這次交接自己的選擇，沒帶就照政策（capability `handoff_options`） | 同上（交接開始） |
| `POST /api/sessions/:id/continuity/handoff/interrupt` | – | 同上（交接還在等這一輪結束時，改為立即中斷） |
| `POST /api/sessions/:id/continuity/handoff/force-switch` | – | 同上（切換在等一輪沒辦法安全中斷的回覆結束時，重置原本 CLI 的 pane、立即切換；只在 `switching` 且 `switchBlocked` 時） |
| `POST /api/sessions/:id/continuity/handoff/skip-brief` | – | 同上（不等原本的 CLI 寫交接，改由後端整理；只在 `writing_brief`） |
| `POST /api/sessions/:id/continuity/handoff/confirm` | – | 同上（請接手的 CLI 開始；只在 `awaiting_confirmation`） |
| `POST /api/sessions/:id/continuity/handoff/dismiss` | – | 同上（接手的 CLI 已回報，不送任何話就結束交接，紀錄 `handoff_done`，detail 是接手的 profile 名稱；只在 `awaiting_confirmation`；capability `handoff_options`） |
| `DELETE /api/sessions/:id/continuity/handoff` | – | 同上（取消交接） |
| `POST /api/sessions/:id/continuity/handoff/relaunch` | `RelaunchHandoffRequest`：`{ briefFile, toProfileId?, permissionMode? }` | 同上（`failedHandoff` 那次交接重新開始：tmux 裡沒有 CLI 就直接啟動那個 profile〔或 `toProfileId`〕，還有 CLI 就照一般交接切換，再送同一份交接檔；`briefFile` 要是那次的交接檔；沒有 `failedHandoff` 回 409 `handoff_not_retryable`，交接檔不在了回 409 `handoff_brief_missing`；`permissionMode` 只收登入 token；capability `handoff_relaunch`，ADR 0030） |
| `DELETE /api/sessions/:id/continuity/handoff/failed` | – | 同上（清掉 `failedHandoff`；capability `handoff_relaunch`） |
| `GET /api/sessions/:id/continuity/handoffs/:handoffId/brief` | – | `HandoffBriefResponse`：這個工作階段某次交接的交接檔內容（capability `handoff_brief`；只收登入 token） |

- 誰可以改：兩個 `GET` 收登入 token 與本機工具 token（`X-Hestia-Token`）；兩個 `PUT`（全域預設與工作階段的覆寫）只收使用者的登入 token，工具 token（也就是 tmux 裡的 LLM）會得到 403 `login_required`，避免 LLM 改掉自己撞上限時的處理方式（`routes/login-guard.ts`，同指派）。交接、取消待執行的自動繼續等操作不是設定，兩種 token 都可以。`hestia` 指令不寫 continuity 設定。
- `mode`：`wait_resume`（重置後自動繼續）、`handoff`（也監控剩餘額度並交接）或 `off`（預設，只記錄；會自動執行的都等使用者自己打開）。之後新增的 mode 以新值加入；客戶端要把不認得的值當成 `off` 顯示。
- 欄位範圍：`resumeDelaySeconds` 0–3600、`maxAutoResumesPerDay` 0–50、`chain` 最多 20 個啟動選項 id（`GET /launch-profiles`）、`softRemainingPercent`／`hardRemainingPercent` 0–100 且 hard 不大於 soft、`handoffSource` 為 `self_then_mechanical`、`mechanical` 或 `incoming`（後者需要 `handoff_options`）、`handoffConfirm` 為 `ask` 或 `auto`、`selfBriefTimeoutSeconds` 30–1800。
- 撞上限由 CLI 自己的 transcript 判斷，整理成 `LimitHit`（`scope`、`limitType`、`model`、`resetsAt`、原文、`ruleId`）。
- 自動繼續的時間是 `resetsAt` 加 `resumeDelaySeconds`；送出前會重新確認同一段對話、CLI 在執行且閒置、最後的結果仍是那次撞上限。送出走和 `POST /sessions/:id/messages` 相同的檢查，CLI 在等確認或信任畫面時延後，不會打進提示裡。重置時間已過兩小時以上的撞上限不處理。
- 剩餘額度是帳號 5 小時、7 天兩個視窗中較少的那個。`handoff` 模式下，剩餘 ≤ `softRemainingPercent` 時在這一輪結束後交接，≤ `hardRemainingPercent` 時中斷回覆交接；只對最近 10 分鐘內有在工作的工作階段。
- 交接（`ContinuityHandoff.stage`）：`writing_brief`（預設等這一輪結束；`interrupt` 時先中斷。原本的 CLI 把交接內容寫到 `briefPath`，即工作目錄的 `.hestia/handoffs/` 裡；寫不出來時由後端整理，原因在 `briefNote`（交接檔裡的原文，中文）與 `briefNoteCode`（`limit_hit`、`mechanical_only`、`user_skipped`、`cli_gone`、`never_settled`、`send_failed`、`waiting_elsewhere`、`cut_short`、`never_arrived`、`limit_while_writing`、`timed_out`、`no_brief_written`；App 依它顯示自己語言的文字，舊的交接沒有這個欄位，顯示 `briefNote`）；後端的部分一律附在後面，只寫上游對話紀錄在哪裡（`hestia conversation show --session <id> --conversation <cid>`、歸檔與轉錄檔的路徑），不另存對話紀錄；以前寫的 `.conversation.md` 保留不動）→ `switching`（同一個 tmux 退出後啟動目標，開新的對話；兩段對話的 `startReason`／`endReason` 為 `provider_switch`）→ `briefing`（請新的 CLI 讀交接內容）→ `reporting`（新的 CLI 回報理解中）→ `awaiting_confirmation`（後兩步只在 `handoffConfirm: 'ask'` 時）。送給 CLI 的話會從它的對話紀錄讀回檢查，沒有完整收到不算數。`switching` 時原本的 CLI 正在回覆、又沒有驗證過的中斷方式，切換會等這一輪結束：`switchBlocked`（`reason`、`since`）記錄原因，history 記一筆 `handoff_waiting`；使用者可以用 `force-switch` 不等（history 記 `handoff_forced`）。結束後 `handoff` 為 null，結果在 `history`。
- `hardRemainingPercent` 預設 8。
- 手動交接時，若這段對話最後就是撞上限（且還沒重置），`trigger` 為 `limit_hit`，後端直接整理交接、不請原本的 CLI 寫。
- `session_timeline`：對話摘要（`ConversationSummary`、`ConversationDetail`）多 `userMessagesCount`：使用者發言數（含回覆途中的補充、不含交接自己送的訊息），也就是聊天畫面的「輪」；transcript 不是 `resolved` 時為 `null`。
- `handoff_brief`：對話摘要（`ConversationSummary`、`ConversationDetail`）多 `handoff`（`SegmentHandoff`：那段對話是哪次交接開始的、交接檔誰寫、選的寫法與接手之後；`briefAmended` 只在「接手的 LLM 自己整理」＋讀完待命時判斷，其他為 `null`；從舊交接訊息回填的 `derived: true` 只有交接 id 的前 8 碼），`ContinuityEvent` 多 `handoffId`。讀交接檔用 `GET …/handoffs/:handoffId/brief`：`handoffId` 是完整 UUID 或前 8 碼，必須是這個工作階段的交接（不是 → 404 `not_found`；前 8 碼對到兩次以上不同的交接 → 409 `handoff_brief_ambiguous`）；只讀工作目錄 `.hestia/handoffs/` 這一層的一般檔案（symlink、名稱不對 → 409 `handoff_brief_unsafe`；不見了 → 404 `handoff_brief_missing`），最多 512 KiB（`truncated`）；工具 token 得到 403 `login_required`。不收任何路徑。
- `permission_modes`：啟動權限模式（`contract/permissions.ts`）：`cli_default`（什麼都不帶，等於以前的行為）、`auto`、`yolo`。`GET/PUT /api/permission-modes` 是各 runtime 新啟動的全域預設（`defaults`，只能是 `cli_default`／`auto`，yolo 回 400；`null` 改回 `cli_default`）與 `supported`（各 runtime 支援的模式）；`GET/PUT /api/sessions/:id/permission-modes` 是這個 tmux 自己的（`override`，可以是 yolo；`null` 改回全域）與 `effective`。兩個 PUT 只收登入 token。`POST /sessions/:id/launch`、`POST /sessions/:id/continuity/handoff`、`POST /delegations`、`POST /forks` 多一個選填的 `permissionMode`：只收登入 token，工具 token 帶了就 403 `login_required`；不帶時用那個 tmux（指派、支線是發起的 tmux）的設定，再來是全域；LLM 自己發起的指派不會是 yolo（改成 `auto`，runtime 沒有 auto 時 `cli_default`）。runtime 不支援所選模式 → 400 `permission_mode_unsupported`；原生啟動選項自己的參數已經帶了權限旗標 → 409 `permission_mode_conflict`（只從設定繼承來的模式則改用 `cli_default`）。對話的 `launchProfile` 多 `permissionMode`（沒有時是 `cli_default`），`/clear` 與接回沿用；交接、指派、支線的紀錄多 `permissionMode`（使用者選的，或建立時決定的）。`RuntimeMeta.permissionModes` 是各 runtime 支援的模式，`permissionModesUnavailable` 與設定回應的 `unavailable` 是這台主機現在不能用的模式與原因（`sandbox_unavailable`：Codex 的沙箱起不來時 Codex 的 `auto`）；選了回 400 `permission_mode_unavailable`，已存的啟動時改用 `cli_default`，事件 detail 記 `permissionFallbackFrom`。改設定只影響之後的啟動。工作階段 DTO 多 `actualPermissionMode`（`{ mode: 'ask'|'auto'|'yolo'|'other', cli }`：CLI 自己的紀錄裡最新的模式，`cli` 是 CLI 的名稱；CLI 沒在跑、還沒有紀錄或 CLI 不記錄時 `null`）與 `permissionModeChangedInTerminal`（和啟動時的模式不同；CLI 預設啟動的和這段對話第一筆不同），對應規則見 ADR 0027 決策 5，只在改變時推播。
- `handoff_options`：`handoffSource: 'incoming'`（`briefBy: 'incoming'`）時不請原本的 CLI 寫，後端先寫好自己的部分（`briefSource: 'incoming'`），切換後請接手的 CLI 讀前面的對話紀錄，把自己的整理補在交接檔最後的「## 接手者的整理」再回報；回報後 `briefAmended` 表示有沒有補上。交接開始時決定的 `source`、`confirm` 存在 `ContinuityHandoff` 上，之後改設定不影響進行中的交接（沒有這兩個欄位的舊紀錄照政策）。`SessionContinuityResponse.selfBrief`（`available`、`reason`：`limit_hit`／`cli_not_running`）表示目前的 CLI 能不能自己寫交接。回報後的推播是「{to} 讀完交接檔並回報了」。「寫交接」請求 30 秒內沒出現在 CLI 的紀錄時，也改由後端整理。
- 交接送進 CLI 的話，文字與辨識方式在 `contract/continuity.ts` 的 `HANDOFF_MESSAGES`、`handoffMessageKind`；客戶端用它把這些訊息標成交接送出的，不當成使用者自己的訊息、也不提示未送達。
- 每個工作階段 24 小時內最多自動繼續 `maxAutoResumesPerDay` 次。排程與交接存在後端，重啟後照常執行。排程、送出、交接、放棄時會發推播。
- 新的錯誤碼：`handoff_in_progress`（409）、`no_handoff_target`（409）、`handoff_not_awaiting`（409）、`handoff_send_failed`（409，`params.reason`）、`handoff_force_failed`（409，`params.reason`）。沿用的：`not_found`、`invalid_request`、`no_running_cli`、`launch_profile_unavailable`。

## 指派給另一個 LLM：`delegation`

把一件工作交給另一個啟動選項（profile）：後端開一個新的 git worktree 與 branch、一個新的 tmux，在裡面啟動那個 CLI，請它讀交接檔後開始；被指派的 CLI 做完用 `hestia delegate done` 交付，使用者在 App 驗收，結果也送回發起的對話。使用者從 App 發起（登入 token），對話裡的 LLM 用 `hestia delegate start` 發起（本機工具 token），依設定直接開始或等使用者核准；設定 `parentReview` 開著時，交付先給發起的 LLM 審（`hestia delegate review`），通過或退回次數用完才給使用者驗收。型別在 `contract/delegation.ts`。目前是第 1–3 段。

| 端點 | 本文 | 回傳 | 本機工具 token |
|---|---|---|---|
| `GET /api/delegation` | – | `DelegationSettingsResponse`：`{ preferences, limits }` | 可以 |
| `PUT /api/delegation` | `DelegationSettingsPatch`：`{ preferences?, limits? }`，逐欄部分更新 | 同上 | 不行（`login_required`） |
| `GET /api/sessions/:id/delegation` | – | `SessionDelegationResponse`：`{ effective, override, limits }` | 可以 |
| `PUT /api/sessions/:id/delegation` | `SessionDelegationPatch`：`{ preferences?, limits? }`，`null` 改回沿用全域；上限只能更嚴 | 同上 | 不行 |
| `GET /api/delegations` | 查詢參數 `session`（發起或被指派的工作階段；不帶就是整台主機的全部指派）、`active=1`（只列還沒結束的） | `DelegationListResponse`，新的在前 | 可以 |
| `GET /api/delegations/:id` | – | `DelegationDetailResponse`：`DelegationResponse`（含所有報告）加 `deliveryMergedInto`——repo 目前 checkout 的 branch（detached 時 `HEAD`）已經有交付時的 commit（`headAtDelivery`，且不等於 `baseCommit`）時是那個 branch 名稱，否則 `null`；每次讀取時問 git，不存檔 | 可以 |
| `POST /api/delegations` | `StartDelegationRequest`：`{ parentSessionId, task, profileId?, title?, isolation?, confirmLowQuota? }` | 201，`DelegationResponse`（`starting` 或 `proposed`） | 可以（`initiator: 'llm'`；登入 token 是 `'user'`） |
| `POST /api/delegations/:id/approve` | – | 同上（`starting`） | 不行 |
| `POST /api/delegations/:id/decline` | – | 同上（`stopped`，原因 `declined`） | 不行 |
| `POST /api/delegations/:id/deliver` | `{ fromSessionId, report, blocked? }` | `DelegationResponse` | 可以 |
| `POST /api/delegations/:id/review` | `ReviewDelegationRequest`：`{ fromSessionId?, verdict: 'pass' \| 'send_back', feedback? }`；`send_back` 要有 `feedback` | 同上（`delivered` 或 `working`） | 只限發起的工作階段（要帶 `fromSessionId`）；登入 token 只能 `send_back` |
| `POST /api/delegations/:id/accept` | – | 同上（`accepted`） | 不行 |
| `POST /api/delegations/:id/reject` | – | 同上（`rejected`） | 不行 |
| `POST /api/delegations/:id/stop` | 登入 token：–；工具 token：`{ fromSessionId }` | 同上（`stopped`，原因 `user`／`parent`） | 只限發起的工作階段 |
| `POST /api/delegations/:id/relaunch` | – | 同上（被指派者的 CLI 已結束：`starting`，從頭重走一次，同一個 profile、再送交接檔；CLI 還在跑回 409 `cli_already_running`；只限 `starting`／`working`／`needs_attention`；capability `handoff_relaunch`） | 不行 |
| `POST /api/delegations/:id/cleanup` | `CleanupDelegationRequest`：`{ deleteBranch? }` | 同上（`workspace.removedAt`、`workspace.branchDeletedAt`） | 不行 |

- 只收登入 token 的端點用 `routes/login-guard.ts` 的 route guard：本機工具 token（`X-Hestia-Token`，也就是 tmux 裡的 LLM）打這些端點會得到 403 `login_required`。LLM 不能改自己的指派設定、不能核准自己的提案、不能驗收、不能清理 worktree。continuity 的兩個設定端點也用同一個 guard（見上一節）；其他 API 的驗證方式不變。這是防止好意的 LLM 放寬自己限制的護欄，不是安全邊界。
- 設定：`DelegationPreferences`（`targets`、`llmInitiated`：`allow`／`ask`／`off`，預設 `ask`、`isolation`、`parentReview`、`notify`：`key`／`all`、`idleAttentionMinutes`）與 `DelegationLimits`（`maxConcurrent` 3、`maxDepth` 1、`maxReviewRounds` 3、`minRemainingPercent` 20）。全域 → 這個 tmux 的覆寫 → 這一次指派的參數。tmux 的偏好可以往任何方向改；上限只能更嚴（`minRemainingPercent` 更高、其他更低），寫了較鬆的值回 400 `invalid_request`（`params.field`）。`effective` 是套上覆寫的偏好，`limits` 是逐欄取較嚴的上限。`parentReview`（預設關）決定交付後是否先給發起的 LLM 審；`maxReviewRounds` 是發起的 LLM 能退回的次數（使用者自己退回不算、也不受限制），`0` 等於不審。
- 發起時的檢查（核准時重新檢查上限與額度）：LLM 發起時 `llmInitiated: 'off'` 回 `delegation_disabled`；LLM 只能挑 `targets` 裡的 profile（不指定就是第一個；清單是空的或挑了清單外的回 `profile_not_allowed`），使用者可以挑任何可用的 profile（不指定時用第一個 target）；LLM 的 `isolation` 只能從 `shared` 改成 `worktree`（反過來回 `invalid_request`）；深度＝發起者本身是被指派者時它的深度 + 1，超過 `maxDepth` 回 `limit_reached`（`params.limit: 'depth'`）；整台主機還沒結束的指派（含提案）數量到全域 `maxConcurrent`，或這個 tmux 發起的數量到它自己覆寫的 `maxConcurrent`，回 `limit_reached`（`params.limit: 'concurrent'`、`params.max`）；目標帳號剩餘額度（5 小時／7 天較小者）低於 `minRemainingPercent`，或 continuity 記錄它撞上限且還沒重置：LLM 發起（和核准 LLM 的提案）回 `quota_too_low`（`params.remaining`、`params.min`，撞上限時另有 `params.until`）；使用者發起回 409 `quota_low_confirm`（同樣的 `params`），App 顯示警告，使用者確認後帶 `confirmLowQuota: true` 再送一次就照常開始，並在紀錄寫一筆 `decision` 報告（工具 token 帶這個欄位沒有作用）。之後被指派的 tmux 撞上限由它自己的 continuity 處理，continuity 等重置或交接期間指派不會轉 `needs_attention`。額度讀不到時照常發起，`quotaAtStart` 為 `null`。發起的工作階段不是 App 管理的：工具 token 回 `not_in_managed_tmux`，登入 token 回 `not_found`。
- 狀態（`DelegationStatus`）：LLM 發起且 `llmInitiated: 'ask'` 時是 `proposed`（不建 worktree、不開 tmux），使用者核准 → `starting`、拒絕 → `stopped`（`declined`）、24 小時沒回應 → `stopped`（`expired`）。之後 `starting` → `working` →（`needs_attention`）→（`reviewing`）→ `delivered` → `accepted`／`rejected`；`reviewing`／`delivered` 被退回時回到 `working`（`round + 1`）；任何還沒結束、不是提案的狀態都可以 `stopped`。`reviewing` 也可以直接接受或拒絕。客戶端要把不認得的狀態或原因照原文顯示。
- `stateReason`：`needs_attention` 為 `idle`（閒置超過 `idleAttentionMinutes` 還沒交付）、`cli_exited`、`blocked`（被指派者 `--blocked`，`stateDetail` 是問題的第一行）、`workspace_trust`、`startup_prompt`、`brief_not_delivered`；`stopped` 為 `user`、`parent`（發起的 LLM `hestia delegate stop`）、`declined`、`expired`、`launch_failed`（`stateDetail` 是原因）、`child_gone`（被指派的工作階段被刪除）；`delivered` 為 `null`（沒有 LLM 審查）、`passed`（發起的 LLM 審過）、`review_rounds`（LLM 退回次數已用完）、`parent_gone`（發起的工作階段不在了）、`parent_switched`（發起的工作階段換了對話；continuity 交接接下去的對話不算）。
- 新欄位：`approvedAt`（使用者核准提案的時間，其他為 `null`）；`outbox`（等對方 CLI 閒置才送的訊息，`{ to, event, round?, text, createdAt, attempts, sentAt }`：`to: 'parent'` 的 `event` 為 `delivered`、`review`、`blocked`、`accepted`、`rejected`、`declined`、`expired`；`to: 'child'` 的 `event` 為 `feedback`，`round` 是退回後的輪次）；`workspace.removedAt`、`workspace.branchDeletedAt`（清理的時間，舊紀錄沒有這兩欄）；`parentTurnsAtStart`（第一次寫交接檔時發起對話的輪數，`hestia conversation show --upstream` 印到這裡；之前為 `null`，舊紀錄讀進來也是 `null`）。
- 工作區（`workspace`）：發起的工作階段在 git repo 裡時，預設開 `<repo 名>-delegate-<id>` worktree，放在 repo 旁邊的 `<repo 名>-worktrees/` 裡（`HESTIA_WORKTREES_DIR` 可以指定別的地方；上層不能寫入時放 `${XDG_DATA_HOME:-~/.local/share}/madera/hestia/worktrees/`，不放狀態目錄），branch `delegate/<id>-<標題的英數字>`，從發起時的 `HEAD`（`baseCommit`；提案在核准時才決定）開出；被指派者的 cwd 是對應的子目錄。不是 git repo（或 `isolation: 'shared'`）時共用發起者的目錄。後端不合併、不 push；只有使用者用 `cleanup` 時才移除 worktree、刪除已合併的 branch。
- `starting` 的每一步都可重複執行，後端重啟後接著做：建 worktree → 建 tmux（同一個專案，tmux 帶環境變數 `HESTIA_DELEGATION_ID`；被指派的 tmux 死掉後用「恢復」重開也會再帶上）→ 啟動 profile → 送一行指示請 CLI 讀交接檔（`DELEGATION_MESSAGES.brief`），讀回驗證送達後轉 `working`。CLI 問要不要信任新的資料夾時，使用者發起或核准過的指派由後端代為選「信任」並記一筆 `decision` 報告；LLM 發起且 `allow`（沒有人參與）的轉 `needs_attention`（`workspace_trust`）；其他啟動畫面轉 `needs_attention`，使用者處理後回到 `starting`。
- 交接檔在被指派者 cwd 的 `.hestia/delegations/<id>/brief.md`（`.hestia/.gitignore` 為 `*`）。交接檔只寫發起對話在哪裡（`hestia conversation show --upstream`、明確的 `--session`／`--conversation`／`--turns` 寫法、歸檔與轉錄檔的路徑），不另存對話紀錄；以前寫的 `parent-conversation.md` 保留不動。
- `deliver`：只接受該指派自己的工作階段（`fromSessionId`；不是 App 管理的工作階段回 `not_in_managed_tmux`，是別的工作階段回 `invalid_request`）。worktree 有沒 commit 的改動時回 409 `workspace_dirty`；成功時記下 `headAtDelivery`；`parentReview` 開、發起的工作階段還在、發起的 LLM 還能退回（它退回的次數 < `maxReviewRounds`）→ `reviewing`（`outbox` 排一則 `review` 給發起者，報告檔寫了 `hestia delegate review` 的用法），否則 → `delivered`（附原因）。`blocked: true` 不檢查工作區，直接轉 `needs_attention`。
- `review`：工具 token 是發起的 LLM（`hestia delegate review`），只在 `reviewing`，`fromSessionId` 必須是發起的工作階段（沒帶回 403 `login_required`）。`pass` → `delivered`（`passed`，推播「LLM 審過，待你驗收」）；`send_back` → `working`、`round + 1`、記一筆 `review` 報告、`outbox` 排一則 `feedback` 給被指派者；這時退回次數已用完（例如上限剛被調低）→ `delivered`（`review_rounds`）。登入 token 是使用者，只在 `reviewing`／`delivered`，只能 `send_back`（`pass` 回 400 `invalid_request`，驗收請用 `accept`），不受 `maxReviewRounds` 限制。`reviewing` 時發起的工作階段不在或換了對話 → `delivered`（`parent_gone`／`parent_switched`），還沒送出的審查請求一併取消。發起的對話在 `reviewing` 時撞上限、continuity 在等重置，推播一次（每次審查最多一次，記在 `parentHeldNoticeAt`），不自動轉給使用者。
- `cleanup`：只收登入 token，只在 `accepted`／`rejected`／`stopped`、而且是自己的 worktree（共用目錄回 `invalid_request`）。要移除 worktree 時，先關閉被指派的 tmux（同 `POST /sessions/:id/close`：請 CLI 退出後結束 tmux，工作階段標成已結束）；CLI 不退出回 409 `delegate_still_running`（`params.reason`：`cli_busy`、`exit_unverified`、`in_transition`），什麼都不動。下面兩種拒絕在關閉 tmux 之前就檢查。移除 worktree（`git worktree remove`，不加 `--force`；有沒 commit 或未追蹤的檔案回 409 `workspace_dirty`；資料夾已經不在就只 `git worktree prune`）；`deleteBranch: true` 時也刪 branch，但只刪已合併進 repo 目前 `HEAD` 的（`git branch -d`），沒合併回 409 `branch_not_merged`，而且是先檢查再動手，什麼都不會刪。worktree 已移除後可以再呼叫一次只刪 branch；都清完了再呼叫回 `invalid_request`。
- 送回發起的對話：交付（要審查時是 `review`）、`--blocked`、使用者接受／拒絕、提案被拒絕或過期時，在 `outbox` 排一則通知；後端只在發起的 CLI 在執行、`idle`、沒有待確認畫面、沒有在切換或交接，而且最後一輪結束（或最後一次送出）已超過 30 秒時才送，一次一則。送的是一行 `DELEGATION_MESSAGES.parent`，指向發起者 cwd 的 `.hestia/delegations/<id>/report.md`（送出時寫入；共用目錄時改名 `report-for-parent.md`，避免蓋掉被指派者自己的報告），送出後讀回驗證，被截斷或沒出現就重送一次，再不行就放棄並記一筆 `decision` 報告。發起的工作階段已不存在也記一筆後放棄。`outbox` 存在狀態檔，重啟後照樣等。
- 退回的意見送給被指派者的方式相同：送出時把意見寫到被指派者 cwd 的 `.hestia/delegations/<id>/feedback-<round>.md`，送一行 `DELEGATION_MESSAGES.feedback`，等它閒置、讀回驗證；指派已經結束就不送了（記一筆 `decision`）。
- 送進對話的訊息（給被指派者的交接檔指示與退回意見、給發起者的通知）用 `delegationMessageKind` 辨識（`brief`、`feedback`、`parent`）；客戶端和交接訊息一樣標示出來，不當成使用者自己的訊息、也不提示未送達。
- `stop` 用工具 token 時要帶 `fromSessionId`，而且必須是那個指派的發起工作階段（沒帶回 403 `login_required`，別的工作階段回 `invalid_request`，不是 App 管理的回 `not_in_managed_tmux`）。
- 被指派的工作階段 DTO 有 `delegation`（見「被指派的工作階段記得指派：`delegation_origin`」）。
- 工作階段 DTO 的選填欄位 `closable`（2026-10-12）：支線或被指派的工作階段看起來做完了、可以收掉時是 `{ reason, into }`——自己的 worktree 沒移除、沒有沒 commit 的東西、CLI 不在工作，而且 `reason: 'merged'`（HEAD 已在發起的 repo 目前 checkout 的 branch 裡，`into` 是那個 branch，分離 HEAD 時是 `'HEAD'`）或 `reason: 'unchanged'`（完全沒有新 commit，`into` 為 `null`）；支線還要開著、啟動完、沒失敗，指派只有 `accepted`／`rejected`／`stopped`。其他是 `null`。每個工作階段最多每 30 秒重新檢查一次，可能比實際晚一點。只是提示：收掉仍走 `POST /forks/:id/close`／`POST /delegations/:id/cleanup` 和它們自己的檢查。沒有這個欄位的舊後端就是不提示。
- 工作階段 DTO 的選填欄位 `spawnClosedAt`（2026-10-13）：支線或被指派的工作階段已收掉（支線的 fork 已關閉、指派的 worktree 已移除）的時間，其他是 `null`。已收掉的資料夾已不存在，所以 `recoverable` 一律是 `false`、不能接回，只能查看紀錄。收掉或清理成功後會立刻更新。沒有這個欄位的舊後端就當作沒收掉。
- 推播：`notify: 'key'` 為提案、交付、轉 `needs_attention`、`stopped`（`launch_failed`）；`notify: 'all'` 另加開始工作、回報理解、交付後送去 LLM 審、每次 LLM 退回。發起的 LLM 審過（`passed`）、退回次數用完、審查因發起者不在而跳過，都算交付，`key` 也會推播。連結是 `/session/<發起的 session>?delegation=<id>`（照例加上 `host=`），App 打開就是那一筆的細節（提案在那裡核准或拒絕）。
- 新的錯誤碼：`login_required`（403）、`delegation_state`（409，`params.state`）、`workspace_dirty`（409）、`not_in_managed_tmux`（400）、`delegation_disabled`（409）、`profile_not_allowed`（409，`params.profile`）、`limit_reached`（409，`params.limit`、`params.max`）、`quota_too_low`、`quota_low_confirm`（409，`params.remaining`、`params.min`、`params.until`）、`branch_not_merged`（409）、`delegate_still_running`（409，`params.reason`）。沿用的：`not_found`、`invalid_request`、`launch_profile_unavailable`。

## 工作階段垃圾桶：`session_trash`

刪除一個工作階段不再直接刪掉它的紀錄，而是移到所屬專案的垃圾桶，可以還原或永久刪除。

| 端點 | 本文／query | 回傳 |
|---|---|---|
| `DELETE /api/sessions/:id` | – | 204：結束它的 tmux，再把紀錄移到垃圾桶。不認得的 id、已經在垃圾桶裡的也回 204 |
| `GET /api/sessions/trash` | `projectId`（選填） | `TrashedSessionList`：`{ sessions: TrashedSessionDto[] }`，依刪除時間新的在前。沒帶 `projectId` 時是所有專案的，包括已刪除或不存在的專案 |
| `POST /api/sessions/:id/restore` | – | 200 與工作階段（和 `GET /sessions/:id` 相同的形狀）；還原後狀態是 `dead`，不會自動恢復 CLI |
| `POST /api/sessions/:id/purge` | – | 204：從垃圾桶永久刪除，只刪 registry 紀錄；dialogue archive 與 CLI 的 transcript 檔不動 |

- `TrashedSessionDto` 是 `SessionDto` 加上 `deletedAt` 與 `lastMessage: { role: 'user' | 'assistant', text, at } | null`：active 對話的最後一個 turn，沒有的話取最後一個有 turn 的對話；有回覆時取回覆，否則取訊息；`text` 最多 200 個字元（`TRASH_LAST_MESSAGE_CHARS`）。和其他工作階段 DTO 一樣不含任何本機路徑。
- 在垃圾桶裡的工作階段對其他所有端點都等同不存在：`GET /sessions`、`GET /sessions/:id`、搜尋、列表串流、每個工作階段的端點都看不到它（回 404）。移入垃圾桶時，列表串流送 `deleted`，`GET /sessions/:id/events` 送 `deleted` 後結束；之後任何對它的寫入也只會送 `deleted`。
- 還原時送新的事件類型 `restored`：列表串流 `{ type: 'restored', session: SessionDto }`，`GET /sessions/:id/events` `{ type: 'restored', session }`（和 `update` 同樣帶舊欄位）。之後的變動照常是 `update`。和 `update` 不同的是，客戶端看過這個工作階段的 `deleted` 之後，應該忽略晚到的 `update`，但要接受 `restored`：先解除刪除，再加回列表。客戶端遇到不認得的事件類型一律忽略；較舊的網頁前端在列表串流上會把它當成刪除一個不存在的 id（沒有任何效果），在單一工作階段串流上當成 `update`。
- 垃圾桶裡的工作階段一律是 `dead`，沒有進行中的啟動、恢復、清除或切換；這些操作也不會在它身上開始。
- 新的錯誤碼：`session_not_trashed`（409，還原或永久刪除一個不在垃圾桶裡的工作階段）。沿用的：`not_found`（404）、`invalid_request`（400，`projectId` 是空字串）。
- 同一批新增的錯誤碼 `recovery_cwd_missing`（409）：`POST /sessions/:id/recover`，以及需要重建 tmux 的 `POST /sessions/:id/conversations/:conversationId/resume`，在工作階段的工作資料夾已不存在時回這個，不建立 tmux。
- 只有 live 工作階段會擋住刪除專案（`project_has_sessions`）；垃圾桶裡的不算，專案刪除後仍可從不帶 `projectId` 的垃圾桶找到並還原。

## 對話摘要：`recap`

每段對話（`ConversationSegment`）有一份精簡清單：使用者在這段對話裡提過的要求或問題，每項標示做到哪裡。後端用使用者選的帳號（Codex CLI 或 Claude Code）在背景跑一次性的 CLI 整理，每次送「上一版清單＋還沒整理的輪次」接續；使用者改過的狀態不會被之後的整理改掉。預設關閉。型別在 `contract/recap.ts`。

| 端點 | 本文／query | 回傳 |
|---|---|---|
| `GET /api/recap/settings` | – | `ConversationRecapSettingsResponse`：設定、`enabledAt`、`pause`、`queue` |
| `PUT /api/recap/settings` | `ConversationRecapSettings` 的任意欄位 | 同上 |
| `GET /api/recap/profiles` | – | `{ profiles: LaunchOption[] }`：可以用來整理的帳號，只有 runtime 為 `codex-cli`、`claude-code` 的啟動選項 |
| `GET /api/recap/models` | `profileId`（必填）、`refresh=1`（選填，不用快取） | `ConversationRecapModelCatalog`：和 `GET /sessions/:id/models` 相同但沒有 `current`，兩者共用同一份快取 |
| `GET /api/sessions/:id/recaps` | – | `SessionRecapsResponse`：`{ enabled, conversations: ConversationRecapView[] }`，依 `sequence` 新的在前 |
| `POST /api/sessions/:id/conversations/:conversationId/recap/refresh` | – | 202 與這段對話的 `ConversationRecapView`：以最高優先度排入，不等對話停下來，也不等失敗後的退避。沒有摘要時就是「建立摘要」，從第一輪整理 |
| `PATCH /api/sessions/:id/conversations/:conversationId/recap/items/:itemId` | `{ status }` | 200 與這段對話的 `ConversationRecapView`。功能關閉時也可以改 |

- 設定：`enabled` 預設 false；開啟時 `profileId`、`model` 必填。`profileId` 要在 `GET /recap/profiles` 裡；帳號自己列 model 時（`source: 'account'`，Codex）`model` 要在清單裡、`effort` 要是 null 或該 model 的 `efforts` 之一；固定清單時（`builtin`，Claude Code）只檢查 `model`，`effort` 要是 null。後端不替使用者挑 model。`enabledAt` 由後端在每次從關閉改成開啟時寫入。換帳號或 model 會解除 `profile_unavailable`、`model_rejected` 的暫停，換帳號也解除 `account_limited`。
- 哪些對話會自動整理：已經有摘要、又有新的已完成輪次的對話；沒有摘要的對話，只有在某一輪的使用者訊息晚於 `enabledAt` 時才會（從第一輪整段整理）。其他沒有摘要的對話是 `not_created`，等使用者 refresh；`backfillOld: true` 時改以最低優先度在背景整理。對話要停下來 3 分鐘才整理；正在回覆的那一輪還不算完成。同時只跑一個，每批最多 20 輪，順序是使用者要求的 ＞ 有新輪次的 ＞ 背景補齊。
- `ConversationRecapItem`：`id`（後端產生）、`title`（一句話，純文字，最多 40 個字元）、`status`（`implemented`、`accepted`、`planned`、`not_implemented`、`uncertain`）、`statusSource`（`user` 表示使用者改過：之後的整理不會改它的狀態，也不會把它併入別項或刪掉；標題仍可能改寫）、`turns: { from, to }`（`Turn.index`，含頭含尾）、`createdAt`、`updatedAt`、`statusChangedAt`。
- `ConversationRecapView`：`totalTurns` 是已完成的輪數、`coveredTurns` 是已整理的輪數（從第一輪起算）、`pendingTurns` 是兩者的差。`state` 為 `disabled`（功能關閉，已有的項目照常回傳）、`unavailable`（沒有 provider 的對話，`available: false`）、`empty`、`not_created`、`waiting`（等對話停下來）、`queued`、`running`、`up_to_date`、`behind`（整理了一部分，中斷或等著重試）、`failed`（還沒整理到任何一輪就失敗，等著重試）、`paused`。
- `error`：`{ code, params?, retryAt }`，`code` 是 `RecapErrorCode`：`invalid_output`、`run_failed`、`run_timeout`、`account_limited`、`model_rejected`、`profile_unavailable`、`runner_unavailable`。只有代碼，客戶端自己組文字；CLI 的原始輸出只寫進後端的 log。連續失敗依序等 1、5、30 分鐘，之後每次 2 小時。
- `pause`（設定與每段的 view 都有）：`{ code: 'profile_unavailable' | 'model_rejected' | 'account_limited', until, at }`，所有整理都停下。`account_limited` 到 `until` 自動解除（沒有 `until` 時每 15 分鐘重新檢查帳號）；另外兩種要在設定換帳號或 model。後端不會自己換帳號。
- `generator` 只有 `profileLabel`、`runtimeId`、`model`、`effort`，不含任何本機路徑。
- 摘要存在後端的對話歸檔旁（`<conversationId>.recap.json`），不在 registry 裡。垃圾桶裡的工作階段對這些端點一律是 404，摘要檔保留。
- SSE：新的事件類型 `recap`（`ConversationRecapEvent`：`{ type: 'recap', sessionId, conversationId, state, coveredTurns, totalTurns, updatedAt }`，不帶項目），在 `GET /sessions/events` 與 `GET /sessions/:id/events` 上，**只送給串流網址帶 `include=recap` 的連線**（多個值用逗號分開）。排入、開始、每批寫入、失敗、暫停與解除時送；客戶端看到 `state` 或 `updatedAt` 改變再重新 `GET /sessions/:id/recaps`。要明確要求才送，是因為垃圾桶功能之前的網頁前端在列表串流上會把不認得的事件當成刪除 `sessionId`。
- 新的錯誤碼：`recap_disabled`（409，功能關閉時 refresh）、`recap_unavailable`（409，沒有 provider 的對話）、`recap_item_not_found`（404）。沿用的：`not_found`（404，工作階段或對話不存在、在垃圾桶）、`invalid_request`（400）、`launch_profile_unavailable`（400）、`model_unknown`（400，`params.model`）、`model_list_failed`（502，`params.cli`、`params.reason`）。

## CLI 使用分析

後端以 `usage_analytics` capability 宣告本機 CLI 使用歷史。純型別在 `contract/usage-analytics.ts`；以下端點全部需要登入。

| 端點 | 行為 |
|---|---|
| `GET /usage-analytics/facets` | 帳號來源、provider、可可靠歸屬的專案與 tmux、能力與索引狀態 |
| `GET /usage-analytics/summary` | `from`（含）、`to`（不含）的本地曆日與 IANA `timezone`；最多 400 天；回傳摘要、每天的數字、模型／帳號分布與 coverage |
| `GET /usage-analytics/days/:date` | 同一時區及篩選的單日明細，最多 100 個 CLI 對話，`sessionsTruncated` 表示截斷 |
| `POST /usage-analytics/refresh` | 合併背景索引工作，202 回傳 `UsageScanStatus`；GET 只讀已保存資料 |

摘要與單日支援 `accountId`、`provider`、`projectId`、`tmuxId`，以 AND 組合；省略代表全部。非法日期、時區、範圍、未知篩選值回 400 `invalid_request`。

`inputTokens` 不含 cache read/write；`totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`。`reasoningTokens` 是 output 子集，不重加；`requestCount` 是去重後模型請求，不是使用者訊息數；`sessionCount` 在整個查詢範圍去重，不相加每天的工作階段數。

`costUsd` 是 API 等值估算，任何一筆未估價時為 null（空範圍為 0），另有 `unpricedRequests`。帳號是 CLI 設定檔／紀錄來源，不是已驗證的歷史登入身分。coverage 是本機留存資料的觀測範圍，沒有事件不代表其他裝置沒有使用。回應不包含來源檔案路徑、對話內容或登入憑證。

## 便箋垃圾桶：`note_trash`

刪除便箋不再直接刪掉，而是移到所屬專案（或收件匣）的垃圾桶，可以還原。不提供永久刪除，也不會自動清除。

| 端點 | 本文 | 回傳 |
|---|---|---|
| `DELETE /api/projects/:id/notes/:noteId` | – | 204：移到垃圾桶。不認得的、已經在垃圾桶裡的回 404 |
| `GET /api/projects/:id/notes/trash` | – | `{ notes: TrashedNoteDto[] }`，依刪除時間新的在前 |
| `POST /api/projects/:id/notes/:noteId/restore` | – | 200 與 `NoteDto`，跟刪除前一樣 |

- `TrashedNoteDto` 是 `NoteDto` 加上 `deletedAt`（`contract/projects.ts`）。
- 在垃圾桶裡的便箋對其他端點都等同不存在：`GET …/notes` 不列、改文字回 404、標記已用／完成與搬到別的專案會略過它；它的標籤也從專案的標籤清單拿掉，還原時再加回來。
- 新的錯誤碼：`note_not_trashed`（409，還原一則不在垃圾桶裡的便箋）。沿用 `not_found`（404）。
- 前端：有這個 capability 時，刪除便箋的確認文字說明會移到垃圾桶，側邊欄的垃圾桶多一個「便箋」分頁；沒有時沿用「刪除後無法復原」，不顯示這個分頁。

## 支線：`fork`

從一個對話（主線）另外開一條線：後端開新的 git worktree 與 branch、新的 tmux，在裡面啟動 CLI，帶著主線的記憶，兩邊同時工作。支線不回報、不交付，沒有流程狀態；後端只記錄它從哪個對話、第幾輪、哪個 commit 分出來。只有使用者能開、能收掉。型別在 `contract/fork.ts`。

| 端點 | 本文 | 回傳 | 本機工具 token |
|---|---|---|---|
| `GET /api/forks` | 查詢參數 `session`（主線或支線的 session）、`open=1`（只列還沒收掉的） | `ForkListResponse`，新的在前 | 可以 |
| `GET /api/forks/:id` | – | `ForkResponse` | 可以 |
| `GET /api/forks/preview` | 查詢參數 `parentSessionId`、`profileId?` | `ForkPreview`：`{ memory, memoryReason, profileId, workspace, parentDirtyFiles, turnsAtFork }`，不寫入任何東西 | 可以 |
| `POST /api/forks` | `StartForkRequest`：`{ parentSessionId, profileId?, title?, instruction?, confirmLowQuota? }` | 201，`ForkResponse` | 不行（`login_required`） |
| `POST /api/forks/:id/close` | `CloseForkRequest`：`{ force? }` | `CloseForkResponse`：`{ fork, outcome: { tmuxClosed, workspace: 'removed' \| 'kept' \| 'shared', keptReason? } }` | 不行 |
| `POST /api/forks/:id/relaunch` | – | `ForkResponse`（CLI 不在了〔啟動失敗、接手前退出〕：清掉 `failedAt`／`issue`，從頭重走一次並再送說明；CLI 還在跑回 409 `cli_already_running`；capability `handoff_relaunch`） | 不行 |

- 記憶（`memory`）：選的 profile 和主線目前的相同、CLI 支援原生 fork、主線的對話有 CLI 的 id 與已確認的對話紀錄時是 `native`（Claude Code `--resume <id> --fork-session --session-id <新 id>`、Codex `codex fork`，實測版本見 [CLI 版本對齊](cli-version-alignment.md)）；其他是 `brief`，`memoryReason` 為 `other_profile`、`runtime_unsupported`、`conversation_unforkable`。`profileId` 不帶就用主線目前的。
- 兩種都寫一份說明檔 `<支線 cwd>/.hestia/forks/<id>/brief.md`（`.hestia/.gitignore` 為 `*`）：這是支線、主線是誰、分出時共幾輪、工作區（原生 fork 的記憶裡是主線的路徑，說明檔要它改用 worktree）、主線還沒 commit 的檔案（不會帶過來）、規則、使用者的第一個指示。`brief` 模式另外有主線最後一則要求（截到約 1000 字）、對話摘要的位置與上游對話紀錄的位置；**不複製對話紀錄**。CLI 準備好後送一行 `FORK_MESSAGES.brief`，讀回驗證，沒送進去重送一次；`forkMessageKind` 認得這一行，客戶端可以標示成「支線：說明」。
- 工作區：照指派的放法開 `<repo 名>-fork-<id>` worktree 與 `fork/<id>-<標題的英數字>` branch，從主線當下的 `HEAD`（`origin.commit`）開出；不是 git repo 時共用主線的資料夾（`workspace.isolation: 'shared'`）。preview 的 `workspace.path`、`branch` 用 `…` 代表還沒決定的 id；`parentDirtyFiles` 是整個 repo 的未 commit 檔案（相對 repo 根目錄），不是 git repo 時為 `null`。
- 狀態由欄位推出（`forkStatus`）：`closedAt` → `closed`、`failedAt` → `failed`、`startup` 不是 null → `starting`、其他 → `open`。`issue` 是啟動途中要人處理的事（`workspace_trust`、`startup_prompt`、`cli_exited`、`brief_not_delivered`；失敗時是 `launch_failed`），同一個原因只推播一次。`startup` 的四步（工作區 → tmux → 啟動 → 送說明）和指派共用，重啟後接著做；信任提示由後端代答。支線的 session 被刪除 → `closedAt`、`closedReason: 'session_removed'`，worktree 留著。
- `childSessionId` 在回應之前就決定並存檔。支線的 session DTO 多 `fork: { forkId, fromSessionId, fromConversationId, sharedFolder }`（其他 session 是 `null`）；tmux 帶環境變數 `HESTIA_FORK_ID`（恢復重開時也帶），continuity 交接支線的 tmux 時，交接檔附一段「這是支線」。
- 對話多一個開始原因 `startReason: 'fork'`：支線的第一段對話。它的輪次只有分出之後的：Claude 的 fork 會把主線的紀錄（時間戳不變）複製到自己的轉錄檔開頭，後端在綁定時記下「早於支線開始時間的輪數」當 offset，不匯入那些；Codex 的 fork 不複製，offset 是 0。不認得這個值的客戶端當成一般的開始即可。
- `close`：先關閉支線的 tmux（同 `POST /sessions/:id/close`；`force: true` 不等 CLI 退出直接結束；CLI 不退出回 409 `fork_still_running`，`params.reason`：`cli_busy`、`exit_unverified`、`in_transition`）。再看 worktree：branch 已合併進 repo 主 checkout 目前的 `HEAD`、而且沒有未 commit 的改動時，移除 worktree 並 `git branch -d`（完全沒有 commit 的支線 branch 也算已合併）；否則都留著，回 `workspace: 'kept'` 與 `keptReason`（`branch_not_merged`、`workspace_dirty`），這是正常結果。共用資料夾回 `shared`。後端不 merge、不 push、不 `-D`。可以重複呼叫：已收掉的再呼叫一次會重新檢查 worktree。
- 額度：目標帳號剩餘額度低於 20%，或 continuity 記錄它撞上限還沒重置時回 409 `quota_low_confirm`（`params.remaining`、`params.min`、`params.until`），帶 `confirmLowQuota: true` 再送一次就開。
- 推播：啟動失敗、啟動途中要人處理時；連結是 `/session/<主線>?fork=<id>`。
- `hestia conversation show [--upstream | --session <id> [--conversation <cid>]] [--last N | --turns a..b]`：用既有的 `GET /sessions/:id` 與 `GET /sessions/:id/conversations/:conversationId` 讀一段對話，在本機印成 markdown 到 stdout，不寫檔。`--upstream` 先讀 `HESTIA_FORK_ID` → `GET /forks/:id`，只印到分出時的第 N 輪；沒有就讀 `HESTIA_DELEGATION_ID` → `GET /delegations/:id`，印發起的那段對話到 `parentTurnsAtStart` 輪（`null` 時整段）；兩個都沒有就用這個 tmux 的 session 查 `GET /forks?session=`、再查 `GET /delegations?session=`，找 `childSessionId` 是自己的那一筆。`--turns` 比的是 `Turn.index`。`hestia` 指令沒有開支線的子指令。
- 新的錯誤碼：`nothing_to_fork`（409，主線沒有對話或還沒有任何一輪）、`fork_still_running`（409，`params.reason`）。沿用的：`invalid_request`、`not_found`、`launch_profile_unavailable`、`quota_low_confirm`、`login_required`。

## 啟動前的 CLI 檢查與取消啟動：`launch_cancel`

- `POST /sessions/:id/launch` 送出指令前，先用這個 tmux 的 `default-shell` 以登入、互動模式在 session 的資料夾裡找啟動方式的執行檔（有路徑的直接看檔案能不能執行）。**確定找不到**時回 409 `launch_cli_not_found`，`params.command` 是執行檔名稱，不進入啟動中；查不出結果（逾時、讀不到 shell）時照舊啟動。continuity 把工作階段交接到另一個啟動方式時，在要求原本的 CLI 退出之前做同樣的檢查；`/clear` 重開的是同一個 CLI，不檢查。
- 裸命令探測合併 tmux server 與 session 的環境，移除 API 登入秘密；自訂 shell/pane 命令或無法辨識 context 時照舊啟動。它不反映既有 shell 後續改動的 export/functions。
- 工作階段 DTO 新增選填欄位 `launchStartedAt`：等待確認中的啟動是什麼時候送出的，沒有時為 `null`。比它舊的後端沒有這個欄位。
- `POST /sessions/:id/launch/cancel`（無本文）：放棄一個還在等待確認的啟動。後端重置 tmux 畫面（結束指令可能已經開起來的程式），工作階段回到啟動前的狀態，不留錯誤；回 200 與工作階段。沒有等待中的啟動，或啟動要求本身還在送出中時，回 409 `no_launch_to_cancel`；畫面重置失敗時回 503 `pane_reset_failed`，啟動維持等待中。
- 確認、送出與取消共用同一啟動 attempt 的原子所有權；另一個操作已取得所有權時也回 409，不重置 pane。
- 前端：啟動中的面板顯示已等待秒數（依 `launchStartedAt`，沒有時從畫面看到的時候起算）與終端機最後幾行；後端有 `launch_cancel` 時才顯示「取消啟動」。

## 被指派的工作階段記得指派：`delegation_origin`

- 工作階段 DTO 新增選填欄位 `delegation`：被指派的工作階段是 `{ delegationId, fromSessionId, fromConversationId }`（做的是哪一件指派、從哪個工作階段與對話發起；發起端已經不知道時為 `null`），其他工作階段是 `null`。比 `delegation_origin` 舊的後端沒有這個欄位。
- 指派建立被指派的工作階段時寫入，之後不變。後端啟動時，把在這之前建立、還沒有這個欄位的被指派工作階段從指派紀錄補上（只補欄位、不刪任何東西，可以重複執行）。
- 客戶端用它畫出工作階段之間的關係（側邊欄、被指派那一側的來源提示）。沒有這個 capability 的後端，改用 `GET /delegations?session=` 裡 `childSessionId` 是自己的那一筆。

## 一輪的過程：`turn_process`

一輪的文字分成回覆與過程中的話，加上工具、思考與細節，都是**請求時從 CLI 自己的紀錄讀**，不存進 Hestia 的對話備份（`contract/process.ts`）。

- `GET /sessions/:id/conversations/:cid` 的 `turns` 是 `PublicTurn`（`Turn` 加選填的 `process`）。只有最近 50 輪帶 `process`：
  - `{ status: 'available', open, parts, counts }`：`parts` 是 `{ kind: 'reply' | 'progress', text, at }`，依序以空行串起來**等於**這輪的 `assistant.text`（去掉舊的中斷標記）；`open` 表示這輪還在進行。`counts` 是 `read`／`edit`（檔案數）、`run`／`search`／`web`／`agent`／`other`（次數）、`failed`、`runFailed`、`thinking`。
  - `{ status: 'transcript_missing' }`：CLI 的紀錄已經不在（Claude 預設保留 30 天）；`'unmatched'`：存檔的這一輪在紀錄裡找不到；`'unavailable'`：存檔的文字和紀錄不同，或這段對話沒有綁定的紀錄；`'unsupported'`：這個 CLI 的紀錄不這樣讀（Agy）。都照原本整段顯示。
  - 沒有這個欄位（舊後端，或較早的輪）就照原本整段顯示。
- `GET /sessions/:id/conversations/:cid/turns/:index/process` → `{ provider, process, items }`：`items` 是 `{ id, kind, label, at, status: 'ok' | 'error' | 'running', hasDetail, afterPart }`。`:index` 可以是 `open`：最新一則使用者訊息起（還沒成為一輪也算），這時 `parts` 一律是空的。
- `GET …/turns/:index/process/items/:itemId` → `{ input?, output?, diff?, thinking?: string | null, exitCode?, truncated, originalBytes? }`；每個欄位最多 256 KiB。`itemId` 只和這一輪的項目比對。
- `GET …/turns/:index/git` → `{ since, until, repos: [{ root, projectRoot, commits: [{ sha, subject, committedAt, files: [{ path, status }] }], truncated, uncommitted }] }`：這一輪起訖時間內的 commit（最多 50 個），範圍內其他工作階段的 commit 也會列入。
- Subagent：`GET /sessions/:id/subagents/:agentId` 多回 `turns`（同上的形狀），另有 `…/subagents/:agentId/turns/:index/process` 與 `…/items/:itemId`。
- 清單、細節、git 都只收登入 token；工具 token 回 403 `login_required`（輸出與 diff 可能含金鑰）。對話詳情裡的 brief 兩種 token 都可以。
- 新的錯誤碼：`turn_not_found`（404）、`transcript_missing`（410）、`process_unsupported`（409）、`process_item_not_found`（404）。

### 過程細節的圖片：`process_images`

- 細節多一個選填的 `images: { index, source: 'result' | 'file', name: string | null }[]`：這個項目讓 CLI 看到的圖片。`result` 是工具結果本身帶的圖（Claude 的 `tool_result` 裡的 base64 圖片，例如用 Read 讀圖），`file` 是工具看的檔案（Codex 的 `view_image`），`name` 是檔名。沒有圖片就沒有這個欄位。
- `GET …/turns/:index/process/items/:itemId/images/:image`（`:image` 是 `index`）回圖片本身，subagent 也有對應的 `…/subagents/:agentId/turns/:index/process/items/:itemId/images/:image`。只收登入 token，用 blob 讀，不要放進網址。回應帶 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cache-Control: private, no-store`。
- 只看檔案內容判斷格式：只送 PNG、JPEG、GIF、WebP（SVG 不送），最大 15 MB。`file` 是原始紀錄寫的位置，可以在專案外，但絕不接受請求指定的路徑；敏感檔案（`.ssh`、金鑰、`.env` 等）與後端自己的資料夾一律拒絕；只讀一般檔案（資料夾、裝置檔回 404），打開後確認還是同一個檔案。
- 錯誤：`process_image_not_found`（404：沒有這張、檔案已不存在、不是一般檔案）、`path_sensitive`（403）、`unsupported_media`（415 不是可顯示的圖片；413 太大）。

## 原始紀錄保留天數：`transcript_retention`

- `GET /transcript-retention` → `{ defaultDays: 30, minDays: 1, maxDays: 3650, accounts: [{ id, name, source, file, state: 'ok' | 'unreadable', days }] }`：各 Claude 帳號（原生與 Janus）設定檔 `settings.json` 的 `cleanupPeriodDays`（`days: null` 是沒設定，套用 Claude Code 的預設）。
- `PUT /transcript-retention/claude/:accountId { days, expectedDays }`：寫入那個帳號的設定檔。`days` 是 1–3650 的整數（0 會讓 Claude Code 驗證失敗，不收）；`expectedDays` 是使用者看到的值，和目前不同 → 409 `retention_changed`；設定檔不是 JSON 物件 → 409 `retention_file_unreadable`。只改這一個鍵，其他設定、檔案權限、縮排與結尾換行照舊；寫暫存檔再 rename，rename 前原檔變了就放棄（`retention_changed`）。
- 兩個端點都只收登入 token。客戶端只在使用者確認後送 `PUT`。

## 對話裡的檔案連結：`session_files`

回覆裡提到的本機檔案路徑，在 App 裡變成可以開啟的唯讀檢視（`contract/session-files.ts`）。只在顯示時判斷，不改存下來的對話。三個端點都只收登入 token；工具 token 回 403 `login_required`。工作階段不存在回 404 `not_found`。

| 端點 | 輸入 | 回傳 |
|---|---|---|
| `POST /api/sessions/:id/file-refs` | `{ paths: string[] }`，最多 50 個、每個最多 1024 字元（超過回 400 `invalid_request`） | `FileRefsResponse`：`{ refs: [{ input, status, root?, path?, relative?, line?, col?, size?, kind?, repoRoot? }] }`，每個不同的 `input` 一筆。只 stat，**不含任何內容** |
| `GET /api/sessions/:id/files` | `path` | `SessionFileContent`：`RepoFileContent`（同 `repo/file` 的 1 MiB 與二進位判斷）加 `root`、`relative`、`absolute`、`repoRoot` |
| `GET /api/sessions/:id/files/raw` | `path` | 圖片本身（png、jpeg、gif、webp、avif、bmp、ico），最多 10 MB |

- 允許的資料夾（allowed roots）：工作階段的 `cwd`、專案的每個路徑、專案的指派與支線還存在的 worktree（`/repos` 帶 `spawn` 的那些），以及這個工作階段自己是指派或支線時它 worktree 的最上層。都取 realpath、去掉重複；後端自己的狀態資料夾與被拒絕的路徑不算。專案路徑與指派／支線的 worktree 是 `repoRoot: true`（Git 檢視能開，客戶端可以用 `root` 與 `relative` 交給 `repo/*`）。
- 輸入：可以帶 `:12`、`:12:3`、`#L12`、`#L12-L20`（回在 `line`／`col`），`file://` URL 會解碼成路徑；`~/` 開頭與其他 URL 一律 `outside`。絕對路徑歸給包含它的最深一個 root；相對路徑依序試 `cwd`、主要路徑、其他 root，第一個存在的為準。
- 每個路徑都經過 `repo/*` 同一道檢查（realpath、往外的 symlink、`..`、`.git`、後端狀態資料夾）再加上敏感檔案規則。
- `status`：`file`（root 底下的一般檔案，客戶端只把這種做成連結）、`outside`（不在任何允許的資料夾裡，或經由 symlink 往外）、`missing`、`not_file`（資料夾等）、`blocked`（敏感檔案或後端狀態資料夾，**在看磁碟之前**就決定，不回 `root`／`path`）。`kind`：`image`（`files/raw` 能給的圖片）、`binary_or_large`（已知的二進位副檔名或超過 1 MiB）、`text`（其他；讀了才知道是不是二進位）。
- `files` 與 `files/raw` 在讀的當下重新檢查一次：開檔後再比對 realpath、敏感規則與 inode，避免檢查與讀取之間被換成 symlink。
- `files/raw` 只給圖片：SVG、HTML 與文字回 415 `unsupported_media`；超過 10 MB 回 413 `unsupported_media`。回應帶 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Content-Disposition: inline`、`Cache-Control: private, no-store`。客戶端以登入 token 取回成 blob、用 object URL 顯示，不把 token 放進網址。
- 錯誤碼：`path_outside_project`（403，不在允許的資料夾裡）、`path_sensitive`（403，新）、`path_not_found`（404，不存在或不是檔案）、`unsupported_media`（415／413，新）、`login_required`、`invalid_request`。

### 敏感檔案

可能含有機密的檔案（共用套件 `@maderaojen/fs-guard` 的 `isSensitivePath`，不分大小寫）：檔名 `.env`、`.env.*`（`.env.example`／`.sample`／`.template`／`.dist` 除外）、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.p8`、`*.jks`、`*.keystore`、`*.ppk`、`*.kdbx`、`id_rsa*`、`id_dsa*`、`id_ecdsa*`、`id_ed25519*`、`credentials`、`credentials.*`、`.credentials.json`、`*.credentials.json`、`service-account*.json`、`.netrc`、`.git-credentials`、`.npmrc`、`.pypirc`、`.htpasswd`、`secrets.*`、`*.secret`、`*.secrets`；路徑中有 `.git`、`.ssh`、`.gnupg`、`.aws`、`.kube`、`.docker`、`.codex/auth.json`、`.config/gh` 的任何一段。寫出來的路徑與它的 realpath 都檢查。對話的檔案連結回 `blocked`／`path_sensitive`，`repo/*` 見上面「專案的檔案與 Git」。這是第二道防線，資料夾的範圍才是主要的界線。

## 輸入框的附件：`composer_attachments`

輸入框可以附加任何檔案與長的貼上文字（`contract/attachments.ts`、`contract/sessions.ts` 的 `UserMessage`）。沒有這個能力的後端只收圖片、`promptText` 是舊文案，客戶端照舊處理。

- `POST /api/sessions/:id/uploads` 收任何檔案，最大 `UPLOAD_MAX_BYTES`（90 MB，留在 Cloudflare tunnel 的 100 MB 請求上限之內）；超過回 400 `upload_too_large`。圖片（png、jpeg、webp、heic、heif）和以前一樣是 `kind: 'image'`、id `<工作階段>/<uuid><副檔名>`。其他檔案是 `kind: 'file'`，id `<工作階段>/<uuid>/<檔名>`，帶 `name`：原檔名只留各種文字的字母與數字、`.`、`-`、`_`，其他字元換成 `_`，不以 `.` 開頭，最多 120 字（保留副檔名）。便箋的上傳（`POST /api/notes/uploads`）仍然只收圖片、10 MB。
- `GET /api/sessions/:id/uploads/:folder/:name` 一律以下載提供檔案：`Content-Type: application/octet-stream`、`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`，不論內容是什麼都不在瀏覽器裡直接打開。和圖片一樣接受 `?media=`。
- `promptText` 只有檔案在主機上的路徑，不再加「請看這張圖片：」。CLI 自己會讀那個路徑。
- 訊息裡的附件從文字辨識，兩種都認：`UPLOADS_DIR` 底下的路徑（圖片與檔案），以及舊文案後面的圖片路徑（不管 `UPLOADS_DIR` 當時在哪裡）。檔案的附件也帶 `name`。不認得的 `kind` 由客戶端當成檔案顯示。
- `POST /api/sessions/:id/messages` 可以帶 `pastes: [{ start, end }]`（最多 100 個），說明 `text` 裡哪幾段是貼上的整段文字。對話記住每段的開頭 32 字、長度與雜湊（不存文字本身），最近 200 段。送出的 turn，訊息裡找得到這些段落時帶 `pastes: [{ start, end }]`，客戶端可以把每段顯示成一張卡片。CLI 記下來的文字和送出的不同時找不到，照一般文字顯示。

## 相容性與棄用

`contractVersion` 維持 1 的期間，後端為較舊的客戶端保留下面這些欄位與端點。新的客戶端不要依賴它們：之後的版本會移除，移除時會寫在版本說明裡。

| 保留給舊客戶端 | 新客戶端請讀 |
|---|---|
| 錯誤回應的 `error`（和 `message` 相同） | `code`、`message`、`params` |
| 工作階段的 `status`、`claudeClearPending`、`turns`（舊有端點照送，`GET /sessions/events` 不送） | `activity` 與 `turnPhase`、`clearPending`、`GET /sessions/:id/conversations/:conversationId` |
| 卡住時 `lastError` 裡的句子 | `stuckSince` |
| 回覆文字結尾的 `（已中斷）` | `assistant.interrupted` |
| 上傳回應的 `path`、便箋的 `imagePath` | `attachment` |
| `POST /sessions/:id/recover-claude` | `POST /sessions/:id/recover` |
| `GET /sessions/:id/messages` | `GET /sessions/:id/conversations/:conversationId` |
| `GET /sessions/:id/pane` | `GET /sessions/:id/pane/stream` |
| `POST /sessions/:id/resume`（只把回覆狀態改回可輸入，名稱容易和 `/conversations/:id/resume` 搞混） | 不需要替代 |

客戶端面對較舊的後端時，以「有沒有 `GET /meta`、meta 宣告了哪些 `capabilities`」判斷，逐項降級：沒有的功能就不提供，不要假設它存在。

## 對話搜尋範圍

`GET /sessions/search?q=...&limit=20&cursor=...` 支援可選的 `sessionId`（1–256 字元）。提供時只搜尋該 tmux 工作階段的歷史對話，先篩選工作階段再分頁；不提供時搜尋所有未刪除工作階段。回傳格式與既有 cursor 不變。

## 路徑選取與搜尋

DTO 正本是 `contract/fs.ts`。兩個端點都只收使用者的登入 token（工具 token 回 403 `login_required`，2026-10-13 起），只回傳資料夾。

- `GET /api/fs?path=...&base=...`：回傳 `DirListing`。省略 path 使用主機 HOME；絕對路徑、`~/` 與相對於 base 的路徑均可，canonical path 驗證為可讀資料夾。省略 base 預設 `/`。
- `GET /api/fs/search?path=...&query=...`：query 為非空、最多 1024 字元，path 最多 4096 字元，不接受 NUL。大小寫不敏感的連續子字串匹配 descendant 的相對路徑，可跨 `/`。回傳 `DirSearch`，entries 的 relativePath 是顯示與命中依據。
- 搜尋最多 2000 目錄、20000 entries、100 結果、1500ms；客戶端中止連線會取消遍歷。沒有隱藏的名稱排除。Directory symlink 本身可匹配但不遞迴。`incompleteReasons`：`timeout`、`limit`、`unreadable`、`symlink`。
- `complete=false` 只能手動接受候選，不能因只回傳一筆就判定唯一。即使 complete=true，前端仍需根據操作意圖決定是否補完。

相容性：後端在 `/meta` 宣告 `filesystem_search`；前端只有該 capability 時呼叫搜尋。舊主機退回當層子字串篩選，顯示限制，不自動補完。`~/`、`../` 由純 domain 模組根據開啟時 HOME 與目前 canonical base 解析為絕對路徑，舊主機也可使用。

## 登入裝置管理（`auth_sessions`）

- `GET /api/auth/sessions` → `LoginSessionsResponse`：`{ sessions: [{ id, createdAt, lastUsedAt, expiresAt, current }] }`。時間皆為 Unix 毫秒；`expiresAt` 為閒置期限與最長期限的較早者。只列出登入者同帳號、同 local-only 身分的有效登入；不含 token 或儲存的 token digest，回應 `Cache-Control: no-store`。
- `DELETE /api/auth/sessions/:id` → `{ ok: true, revoked: boolean }`，只能撤銷同帳號的登入。兩個端點皆要求使用者登入；匿名及本機工具 token 回 403 `login_required`。`id` 是獨立雜湊產生的公開識別碼，不能用來驗證 API。
- 登入最久 90 天，連續 30 天未使用也會失效；重啟仍套用相同規則。撤銷會立即關閉該登入的 SSE，廢除尚未使用的 stream ticket 及 media token，其他登入不受影響。每次 SSE 事件與 heartbeat 也會檢查父登入是否過期。
- 登出、配對撤銷、個別登入撤銷成功回覆前，必須完成登入狀態寫入；寫入失敗回 500 `internal_error`，記憶體內仍維持撤銷，可重試。匿名或隨機 token 登出不會觸發寫入。
