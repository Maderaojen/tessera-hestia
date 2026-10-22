# 帳號狀態（用量 / 5 小時 / 7 天額度）

- 更新：2026-10-19
- 英文版：[account-status.en.md](account-status.en.md)

實作在 `api/src/account-status/`。要實機檢查，可以跑 `cd api && npm run probe-account-status`：它會立刻重查一次、把結果寫進快照檔，並印出結果。

## 快照檔與更新時機
所有查詢結果都寫在同一個檔案 `STATE_DIR/account-status.json`（狀態資料夾見 `docs/guides/install.md`，預設 `~/.config/madera/hestia/account-status.json`）。
**讀取只讀這個檔，永遠不會等 CLI。**

| 觸發 | 時機 | 行為 |
|---|---|---|
| `schedule` | 每小時的 :00 / :15 / :30 / :45（API 程序內的 `setTimeout`，對齊整刻） | 重查全部帳號 |
| `startup` | API 啟動時，快照檔不存在或超過 15 分鐘 | 重查全部帳號 |
| `view` | 前端打開 sidebar（`POST /refresh {force:false}`） | 只有快照超過 5 分鐘才重查 |
| `manual` | 前端按 ↻（`POST /refresh`，預設 force） | 一律重查 |

- 同一時間只會跑一次 sweep，晚到的呼叫會共用正在跑的那次。帳號逐一查詢，不會同時開多個 CLI。
- 寫檔用 tmp + rename，讀的人不會讀到寫一半的內容。
- `POST /refresh` 不等 sweep 跑完：它會立刻回傳目前的快照，加上 `sweeping: true`，HTTP 狀態 202。前端之後照 `sweeping` 輪詢 `GET`：查詢中每 3 秒讀一次，平常每 30 秒讀一次（只在 sidebar 開著時）。所以排程跑完的結果也會自己出現在畫面上。
- **單一帳號暫時失敗**（`error`）時，保留上次成功的數字，並設 `stale: true`，同時記下 `error` 和 `lastSuccessAt`。畫面上顯示「N 分鐘前的資料」。
- **明確的結果**（未登入、未安裝、不支援）則直接取代舊資料。
- 成本：每次 sweep，每個 Claude 帳號都會真的啟動一次 CLI（約 3–5 秒，不花額度），並在各帳號的 `history.jsonl` 記一筆 `/usage`。這筆歸在 probe 目錄的 project 底下，不會出現在其他專案按 ↑ 叫出的歷史裡。

## 帳號來源
`janus list --json`：Janus 帳號用 `janus run <name>` 啟動（跟開工作階段一樣），
`source: native` 的預設帳號直接跑 CLI。找不到 Janus 時退回 claude/codex/gemini 原生預設。
原生帳號會清掉繼承來的 `CLAUDE_CONFIG_DIR`，避免父行程的設定把查詢導到別的帳號。

## 各 provider 方案（原則：官方 API > 官方 CLI；不讀 token、不打非公開端點；唯一例外見「登入到期與重新登入」）

| Provider | 方法 | 取得資料 | 驗證狀態（2026-09-24） |
|---|---|---|---|
| Codex | 官方 `codex app-server` JSON-RPC：`account/read`、`account/rateLimits/read` | 方案、5h/7d used%、重置時間、credits | ✅ codex-cli 0.156.1，3 個帳號（含未登入）實測 |
| Claude | 官方 CLI：在獨立 tmux socket（`hestia-usage-probe`）啟動 `claude --safe-mode`，送 `/usage`，解析畫面 | 5h/7d（及分模型週額度）used%、重置時間；方案/Email 讀 `.claude.json` 的 `oauthAccount` | ✅ Claude Code 2.1.281，3 個帳號實測 |
| Gemini | 未實作 | — | 本機沒裝 `gemini` CLI，回報 `not_installed` |
| Copilot | 未實作 | — | 回報 `unsupported` |

### Claude 細節
- Anthropic 沒有公開的訂閱用量 API。`api.anthropic.com/api/oauth/usage` 是非公開端點（需 OAuth token，且有嚴格 rate limit），**刻意不用**。
- 官方文件的 statusLine JSON 也有 `rate_limits`，但只在工作階段進行中才被動提供，而且要改每個帳號的 settings，所以沒採用。
- probe 在 `STATE_DIR/usage-probe`（空目錄）執行。每個帳號第一次查詢時會出現「信任此資料夾」，會自動選 Yes。
- 用 `--safe-mode` 啟動，帳號設定的 hooks、plugins、MCP、CLAUDE.md 都不載入；否則每次查詢結束都會觸發使用者的 `SessionEnd` hook。
- `/usage` 是本地指令，不會發出模型請求（面板顯示 `Total cost: $0`）。每次約 3–5 秒。
- API 以 systemd user service 執行時，PATH 只有系統預設值。probe 會自己補上 `~/.local/bin` 和 service 所用 node 的 bin 目錄。環境變數透過 `env(1)` 傳進 pane，因為 tmux 3.4 會忽略 `new-session -e PATH=…`。
- 重置時間是面板上的文字（例如 `Resets Sep 25, 12am (Asia/Taipei)`），依照其中的時區換算成 ISO；看不懂的格式則回傳 `resetsAt: null`，原文保留在 `resetsText`。
- 風險：CLI 改版時如果面板文字變了，解析會失效。fixtures 放的是真實擷取的畫面（`api/test/account-status/fixtures/`），改版時可以直接更新。

### Gemini（之後要做時的候選方案）
參考 CodexBar 的作法：`cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`，但這也是非公開端點。
依照「官方 CLI 優先」的原則，應該先評估 Gemini CLI 內建的 `/stats`。

## 登入到期與重新登入（Claude，capability `account_login`）

### 讀登入到期時間：「不碰 token」唯一的例外
Claude CLI 只在剩不到 3 天時才在對話畫面提醒「Your login expires in N day(s) · run /login to renew」，沒有官方方式提早查詢。所以 Hestia 讀每個 Claude 帳號設定目錄下 `.credentials.json` 裡**唯一一個欄位** `claudeAiOauth.refreshTokenExpiresAt`（毫秒時間戳），決策見 ADR 0028。

- 設定目錄就是帳號的 `home`（`janus list --json` 給的；原生預設是 `~/.claude`，Janus 帳號是 `~/.claude-<name>`），不另外寫死路徑。
- 規則（`account-status/login-expiry.ts`）：讀檔、解析 JSON、只取出這個數字；其他欄位（token、權限範圍、方案）不保留、不記錄、不回傳、不寫進快照。讀不到檔案或欄位（例如 macOS 存在 Keychain）、內容壞掉，一律回「未知」，不記錯誤訊息（JSON 解析錯誤的訊息會引用檔案內容）。
- 換發 access token 不會延長它，只有重新登入會（Claude Code 2.1.296）。過期後，CLI 會在下一次 access token（約 8 小時）用完時要求登入；Hestia 不讀 access token 的到期時間，過了就直接報「已過期」。
- 每次 sweep 都會讀（就算 CLI 沒裝或查詢失敗），快照存 `login: { expiresAt, state }`。`state` 在每次讀取時依現在時間重算：`ok`、`expiring`（3 天內，和 CLI 一樣）、`expired`、`unknown`。不支援的 provider 是 `login: null`。查詢暫時失敗而沿用舊數字時，`login` 仍用這次讀到的。

### 前端
- 側邊欄「額度」：帳號名稱下面一行「登入 N 天後到期」（不到一天時寫小時）或「登入已過期」，旁邊有「重新登入」；CLI 要求登入（未登入）的帳號也有這個按鈕。
- 對話頁的工作階段額度：圓球右上與桌機摘要的標題前有提示點（將到期黃、已過期或未登入紅），展開後多一行說明，卡片旁有「重新登入」。
- 原生預設帳號和某個 Janus 帳號是同一個人時原本會隱藏；但兩者的登入各自到期，所以這個預設帳號的登入需要處理時仍然顯示。

### 從 App 重新登入
後端用帳號平常的啟動方式執行 CLI 自己的登入指令：Janus 是 `janus run <name> auth login --claudeai [--email <已知 email>]`，原生是 `claude auth login --claudeai [--email …]` 並清掉 `CLAUDE_CONFIG_DIR`。用 pipe（自己的 process group、`BROWSER=true` 不開瀏覽器），讀出 CLI 印的登入網址給 App，使用者在任何裝置打開、登入後把頁面上的驗證碼貼回 App，後端寫進 CLI 的 stdin。交換與儲存憑證都是 CLI 自己做的，Hestia 看不到 token。網址是官方的手動驗證碼頁（`redirect_uri` 為 `platform.claude.com/oauth/code/callback`，不是 localhost），所以可以在手機上完成。

| 方法 | 路徑 | 回應 |
|---|---|---|
| POST | `/account-status/:accountId/login` | 201 `{ loginId, url, state: 'awaiting_code', expectedEmail }`；同一帳號已在登入中 409 `login_in_progress`；provider 不支援 400 `login_unsupported`；CLI 30 秒內沒給網址 502 `login_start_failed` |
| POST | `/account-status/logins/:loginId/code` `{ code }` | `{ state: 'succeeded' \| 'invalid_code' \| 'failed', email, emailMatches }`；`invalid_code` 時可以再送；正在確認上一個時 409 |
| DELETE | `/account-status/logins/:loginId` | 204；取消並結束 CLI |

- 只收使用者自己的登入（`requireLogin`）：本機工具 token（任何 tmux 裡的 LLM 都拿得到）一律 403 `login_required`，LLM 不能換掉帳號的憑證。
- 每個帳號同時只有一個；10 分鐘沒完成、取消、失敗或成功都會結束整個 process group。登入流程只在記憶體裡。
- 驗證碼先檢查形狀（`code#state`），不對就直接回 `invalid_code`，不送給 CLI。
- 成功後用同樣的啟動方式跑 `auth status --json` 只取 `email`，和登入前已知的 email 比對（`emailMatches`；不一致時 App 提醒），然後在背景重查額度（等正在跑的 sweep 結束後再開一次）。
- 安全規則：CLI 的輸出只拿來比對關鍵字、取網址；驗證碼寫進 stdin 就丟掉。記錄只寫帳號 id 與結果（started、succeeded、failed、cancelled、timed out），錯誤訊息是固定文字，不帶 CLI 的輸出或使用者輸入。
- 還沒驗證：完整登入沒有對真實帳號跑過（會換掉憑證，只用假 CLI 測過協定）；手機上完成登入頁的流程；已經在執行的 CLI 會不會自己讀到新的憑證（App 目前只提示「如果還是要求登入，請重新啟動它的 CLI」）。

## 前端顯示

- **側邊欄「額度」區**：列出所有可讀取額度的帳號。
- **對話頁的工作階段額度**：只在 CLI 執行中顯示，內容是這個工作階段用的帳號與 provider、5h／7d 用量與重置時間。設定裡可關閉（「設定 › 一般 › 額度顯示 › 在對話頁顯示額度」，預設開啟；只影響這台裝置）；手機版的標題列沒有額度開關，改由圓球的長按選單隱藏、從設定重新開啟。
  - **手機版**：header 下方右側一顆 48px 毛玻璃小圓球（`QuotaOrb.vue`）：外圈是 7 天已用、內圈是 5 小時已用，中間兩排是離重置還多久（`formatUntilReset`：5h 用一位小數的小時、不到 1 小時用分鐘；7d 用整天、不到 1 天用小時、不到 1 小時用分鐘，一律無條件進位）。點一下由圓形以尺寸與圓角動畫變成詳細的毛玻璃卡片（完整重置時間、方案、資料新舊），再點一下、點其他地方或 Esc 縮回。圓球可以拖曳：手指一移動就跟著走，放開後貼到最近的左或右邊緣，只在 header 那一排的底緣到輸入區頂端之間移動（不含 header 底下展開的終端機與 Git 面板，打開它們時圓球不會跟著移動），並且疊在它們上面；位置記在這台裝置（`hestia:quota-orb`，存邊緣與高度比例），卡片朝畫面中央展開（在左邊往右、在下半部往上）。按住不動約半秒會跳出選單：隱藏額度、回到預設位置（右上）。對話區不再為圓球預留高度，擋到內容時拖開即可。
  - **毛玻璃注意事項**：圓球必須放在 header **外面**（`ChatView` 的 `.chat-quota-anchor`，貼齊量測到的 header 底緣）。header 自己就是 `backdrop-filter`，放在裡面時它會成為 backdrop root，圓球只能模糊 header。Headless Chromium 在這個頁面上仍會略過卡片的模糊（WebKit 正常），所以卡片底色提高到 78% 不透明，任何引擎下文字都清楚。
  - **桌機版**：header 終端機按鈕左邊三排淡色小字，點一下疊出清楚的卡片，不推動版面。
  - 三種版面共用 `SessionQuotaContent.vue`（標題、5h／7d 各排、詳細說明）。
- **帳號對應**：後端公開欄位 `quotaAccountId` 由工作階段的啟動設定推出，只給 id、不含路徑：Janus 啟動是 `janus:<provider>:<profileName>`，原生啟動是 `native:<provider>:default`。Agy 與舊 Gemini CLI 目前沒有額度來源，回傳 null，卡片顯示「暫不支援額度查詢」。
- **更新**：側邊欄或任何一張工作階段卡片在畫面上時，前端每 30 秒讀一次快照（`quotaState.ts` 的多觀看者輪詢）；每個新出現的觀看者只會要求一次 `refresh {force:false}`，真正去查 CLI 仍受 5 分鐘下限約束，不會因為這個顯示多耗額度。
- **額度條的「port」**：`QuotaMeterProps = { percent: number | null; tone }` 是所有樣式都要實作的介面；`QUOTA_METERS` 把設定裡的樣式對應到元件和它要保留的寬度。目前有 `bar`（長條，預設）與 `ring`（圓圈）。新增樣式只要寫一個符合這組 props 的元件並登記，`quotaMeter.spec.ts` 會自動用同一份合約檢查它。側邊欄與工作階段卡片都只透過 `QuotaMeter` 使用，切換設定兩處一起換。
