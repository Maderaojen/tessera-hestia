# 多主機連線設計（開放平台）

- 更新：2026-10-21
- 英文版：[multi-host-design.en.md](multi-host-design.en.md)

## 目標與不變的部分

前端（Hestia App）讓每個使用者指向自己的後端：設定後端網址，登入後拿到 bearer token。網頁版用同一套 API，但不對外提供；App 經由 Tailscale 網址或 SSH tunnel 連到後端（見下面的「安全邊界：後端不公開到網際網路」）。

**前端不內建任何後端**（2026-09-28 起）：沒有「預設主機」，也不提供作者自己的後端。第一次打開時沒有主機，router 會把每個頁面都導到登入頁的新增主機表單；作者自己的後端也是用新增主機的方式連。

## 認證

| 用途 | 憑證 | 放在哪裡 | 有效期 | 範圍 |
|---|---|---|---|---|
| 一般 API | 登入 token | `Authorization: Bearer` | 最長 90 天；登出、撤銷、閒置 30 天或改密碼時提早失效（API 重啟不影響） | 全部 |
| 即時串流（`EventSource`） | stream ticket | `?ticket=` | 60 秒、用一次就失效 | 只有 `GET /sessions/:id/events`、`/sessions/:id/pane/stream` |
| 圖片（`<img>`） | media token | `?media=` | 30 分鐘、可重複使用 | 只有 `GET /sessions/:id/uploads/:file`、`/notes/uploads/:file` |
| 本機 CLI | local tool token | `X-Hestia-Token` | 到 API 重啟 | 全部，只限本機直連 |

- `POST /auth/login` 與 `POST /auth/pair` 只在 body 回傳 token，不設 cookie；之後每個請求都用 `Authorization: Bearer` 帶上。後端**不接受 cookie**：瀏覽器會替任何網站發出的請求（例如別的網站送出的表單）附上 cookie，header 則只有拿到 token 的頁面才能設。
- **版本檢查**：新增主機（以及重新登入目前的主機）時，登入成功後先用拿到的 token 讀 `GET /meta`，`contractVersion` 和前端的 `CONTRACT_VERSION` 相同才儲存並使用；不同或沒有 `/meta`（舊後端）就登出這個 token、不儲存，並說明要更新後端或 App（`shell/hostSwitch.ts` 的 `ensureCompatible`）。`/meta` 在登入之後，所以檢查只能放在登入之後。
- `POST /auth/logout` 會撤銷請求帶的登入 token、由它發出的 media token 與未使用的 stream ticket，並關閉既有 SSE 串流。支援 `auth_sessions` 的後端可在設定的「登入裝置」查看登入時間、最後使用及到期時間，並個別撤銷；同樣立即切斷衍生憑證與串流。
- local-only 帳號（`AUTH_LOCAL_USERS`）的規則套用到每一種憑證：只要請求經過轉送（帶有轉送 header），就一律拒絕。
- **本機直連要用 loopback 的 Host**：被當成本機的請求（loopback 直連、沒有轉送 header）的 `Host` 必須是 `127.0.0.1`、`localhost` 或 `[::1]`（任何 port），否則回 403 `host_not_allowed`。這擋的是 DNS rebinding：別的網站把自己的網域指到 127.0.0.1，讓這台機器上的瀏覽器直連 API 時會被當成本機。經過 `tailscale serve` 等轉送的請求帶著公開網域和轉送 header，不受影響；開發用的 proxy 要把 Host 改成 127.0.0.1（例如 Vite 的 `changeOrigin`）。
- **掃碼配對要先確認**（網頁與 App 都一樣；連結格式見 `docs/reference/api-contract-v1.md` 的「配對連結」，App 用 `hestia://pair?url=…#code=…`）：打開帶 `#pair=` 的連結時，配對碼立刻從網址列拿掉、只留在記憶體，畫面先顯示要新增的主機完整 origin，按「新增並登入」才呼叫 `POST /auth/pair`；按「取消」會丟掉配對碼和網址。網址不是 `.ts.net` 時多一行警告。任何人都能傳這種連結，自動配對等於讓對方靜悄悄地加入並切換到他的後端。
- **登入鎖定的來源**：依序取 `X-Forwarded-For` 的**最後一段**（`tailscale serve` 會把自己看到的位址放在最後，前面幾段是客戶端自己寫的）、socket 位址。不採用 `CF-Connecting-IP` 與 `X-Real-IP`：`tailscale serve` 會原封不動轉送客戶端自己寫的值，採用的話每次猜測都能換一個來源。經 SSH tunnel 的請求沒有轉送 header，來源是 socket 位址（本機）。每個來源 5 次失敗鎖 15 分鐘；所有來源 15 分鐘內合計失敗 50 次（`AUTH_GLOBAL_MAX_LOGIN_FAILURES`）就全部暫停登入，直到舊的失敗過了 15 分鐘。密碼驗證用非同步 scrypt，每次嘗試都剛好跑一次（帳號不存在時對一個固定的假雜湊跑），從時間看不出帳號是否存在。
- token、ticket、media token 在伺服器端都用 SHA-256 當 key 儲存，查找時比對的是摘要，不會因為猜測的字首相同而洩漏時間差。
- 長效的登入 token **永遠不放進 URL**。URL 裡只會出現 ticket 和 media token，兩者都有路徑白名單（區分大小寫、不接受結尾斜線、只限 GET），超出白名單就回 401。
- **登入 token 撐過 API 重啟**：`POST /auth/login` 與 `POST /auth/pair` 發出的登入 token 會寫到 state dir 的 `session-tokens.json`（mode 0600，`auth.ts` 的 `loadSessionTokens`，啟動時在 listen 之前讀回）。檔案裡只有 token 的 SHA-256、帳號（`username`、`localOnly`）、密碼雜湊的指紋和時間戳，**沒有 token 本身**，所以讀到檔案也登入不了。stream ticket、media token、配對碼、local tool token 仍然只在記憶體（短效或每次啟動重發）。
  - **過期**：閒置超過 30 天（`SESSION_TOKEN_IDLE_TTL_MS`）或發出後滿 90 天（`SESSION_TOKEN_MAX_TTL_MS`）就失效；每天使用也不會延長最長期限。最後使用時間最多每小時寫一次檔（`SESSION_TOKEN_TOUCH_INTERVAL_MS`），不會每個請求都寫。
  - **改密碼等於全部登出**：每個 token 記著發出時那組密碼雜湊的指紋。重新執行安裝程式或 `npm run set-credentials` 會產生新的 `AUTH_PASSWORD_HASH`（即使密碼相同，salt 也不同），重啟後舊 token 全部作廢。local-only 帳號對照的是 `AUTH_LOCAL_USERS` 裡它自己的雜湊。
  - **帳號不見了**：`AUTH_USERNAME` 改名，或 local 帳號從 `AUTH_LOCAL_USERS` 移除，它的 token 在重啟時丟掉。local-only 的規則在重啟後照樣適用。
  - 檔案不存在、壞掉或格式不認得時，記一行 log、從沒有 token 開始（大家重新登入一次），不會讓 API 起不來。

### 為什麼串流用一次性 ticket，圖片用 media token

- `EventSource` 無法帶 header。串流一次只開一條，而且斷線後前端本來就要重連，所以每次連線前先 `POST /auth/stream-ticket` 換一張一次性 ticket（`api.ts` 的 `openEventStream`，斷線後 3 秒用新的 ticket 重連）。
- 圖片的情況不同：一個畫面有很多張，瀏覽器也可能隨時重新載入同一張。如果每張圖都用一次性 ticket，每個縮圖都要多一次請求，重新載入時也會失敗。所以改用可重複使用、但只能讀圖的 media token。前端把它存在 reactive ref 裡，並在畫面渲染時讀取；過了一半有效期就換新，換新時所有圖片網址會跟著重建。外洩的最壞情況是幾分鐘內可以讀到使用者自己上傳的圖片，不會變成登入的入口。
- 另一個選項是用 fetch 取 blob 再轉成 object URL。這會讓 `uploadedImageUrl()` 變成非同步，便箋元件都要跟著改（而那些元件正在由其他分支修改），所以沒有採用。

## CORS

`CORS_ALLOWED_ORIGINS` 是以逗號分隔的前端 origin 清單。沒有設定或留白時，用 `api/src/config.ts` 的 `DEFAULT_CORS_ALLOWED_ORIGINS`：Hestia App WebView 的四個固定 origin：Capacitor iOS `capacitor://localhost`、Capacitor Android `https://localhost`、Tauri macOS `tauri://localhost`、Tauri Windows `http://tauri.localhost`（`APP_WEBVIEW_ORIGINS`）。網頁前端不在預設裡，要用的後端自己列出。前端網址只寫在這一個地方，安裝腳本也是向建置好的 `config.ts` 查詢（`scripts/install-config.ts`）。有設定時清單**取代**預設值，必須明確列出所有需要的 app/web origin；自訂清單漏列 app origin 時，安裝器會警告並列出補齊指令。`*` 會被忽略並印出警告：允許的前端一律明確列出。Preflight 允許 bearer `Authorization`。四個 App WebView origin 即使在自訂清單中也一律不回傳 `Access-Control-Allow-Credentials`；一般網頁 origin 保留既有行為。

預設允許 `https://localhost` 與 `http://tauri.localhost` 的代價：對應的本機 WebView origins 可跨來源呼叫 API。後端只接受 bearer token；四個 App WebView origins 一律**不送** `Access-Control-Allow-Credentials`。不需要 App 的人可以用 `--cors-origins` 只列自己的網頁前端。`hestia pair --link web` 會跳過四個固定 App origins（包括使用 HTTP scheme 的 `http://tauri.localhost`），只選一般網頁 origin；若沒有則回退官方網頁。

## 前端的主機儲存

- `lib/hosts.ts` 透過同步 `HostStorage.load()`／`save()` 讀寫 `{ id, name, baseUrl, token, connection? }`。網頁的 `localStorage`（`hestia:hosts`）只保留主機資料，token 固定為 `null`；含 token 的快照存在該分頁的 `sessionStorage`，同分頁重新載入或切換主機仍保有登入。關閉分頁後不保證保留登入，瀏覽器還原分頁也可能還原 sessionStorage。舊版持久 token 首次讀取時先從 localStorage 清除，再遷移至目前分頁；已登出的分頁不會被舊 token 覆蓋。Native app 使用平台安全儲存（見下一段）。
- `HostStorage` 的選用 `flush()` 等待排隊寫入並回報失敗；網頁版也實作它以回報瀏覽器儲存錯誤。替換分頁快照前先移除舊快照，避免替換失敗後重新載入又拿到舊 token。
- 整頁載入經 `afterHostWrites()`，一般登出與移除則等待 `flushHostWrites()`；儲存失敗會顯示錯誤並停止成功導頁。原生寫入失敗不會被吞掉；無法刪除損毀的儲存資料時停止初始化。
- `baseUrl` 只接受 HTTPS 或 loopback HTTP，網址不能含帳密、query 或 fragment。舊設定中的 `http://[::1]` 會保留，但目前 API client 明確拒絕直連，因 Chromium 不接受 IPv6 literal 的 CSP 來源；畫面提示改用 HTTPS，或以 localhost 網址重新新增並登入。不會把原 token 自動改送 localhost，因它可能連到不同的 IPv4 服務。開發與 SSH tunnel 請使用明確允許的 `localhost`／`127.0.0.1`。
- 新增主機的表單可以省略 `https://`：輸入 `機器名稱.tailnet.ts.net` 就當成 `https://機器名稱.tailnet.ts.net`（`http` 仍然要寫出來，也仍然只限 loopback）。不會自動補 `.ts.net`：tailnet 的名稱猜不到，只有機器名稱（例如 `my-pc`）時 TLS 會失敗，所以表單改成提示輸入完整的 Tailscale 網址。存下來的主機和配對連結裡的網址仍然要完整的 `https://`。
- `connection`：沒有這個欄位就是**網址**主機（直連 `baseUrl`，網頁版只有這種）。App 的 **SSH** 主機帶 `connection`：SSH 伺服器（主機、埠、使用者）、從 SSH 伺服器看出去的 Hestia API（預設 `127.0.0.1:4791`）、認證的參照（金鑰 id 或密碼 id，機密本身不在這裡）、使用者確認過的 host key，以及手機上 listener 的 `localPort`。舊資料沒有這個欄位，原封不動讀進來，不需要遷移。
- SSH 主機的 `baseUrl` 一律是 `http://127.0.0.1:<localPort>`（不能用 `localhost`：App 自己的頁面在 `https://localhost`，Capacitor 會攔截所有 `localhost` 的請求）。`localPort` 在新增時隨機挑一個（30000–59999）並固定下來，所以所有同步讀 `baseUrl` 的地方（API client 的快取、圖片網址）都不用改。那個 port 剛好被別的 App 佔用時，tunnel 改綁另一個 port，App 更新這台主機的 `localPort` 與 `baseUrl`；若它是目前主機就重新載入頁面。
- 判斷「是不是已經有的主機」：網址主機比 `baseUrl`；SSH 主機比 SSH 伺服器、使用者與遠端 API（不比手機上的 port）。同一個後端用兩種方式連，會是兩筆各自登入的主機。
- `api.ts` 每次呼叫時才解析目前的主機，不在 build 時寫死。
- 新增主機就是登入：登入成功後才會存起來。如果主機已經在清單裡，只更新那台主機的 token（SSH 主機的 host key 必須和存的相同，不同就要先在那台主機的詳細資料確認新的金鑰）。
- 切換主機會重新載入頁面：工作階段、projects、額度、串流都分散在模組層級的 store 與已掛載的 view 裡，重新載入比逐一重設可靠。
- 重新載入用遮罩蓋住（交接紀錄與狀態在 `shell/hosts/hostSwitchMask.ts`，蓋上在 `hostSwitchCover.ts`，接手與淡出在 `hostSwitchResume.ts`）：遮罩從點的卡片或側邊欄那一列長出來（手勢則淡入），蓋滿後把 `{ hostId, hostName, startedAt, fromId, look }` 寫進分頁的 sessionStorage（`hestia:host-switch`）再重新載入。新的頁面先由 `public/host-switch-boot.js` 在第一個畫面畫同樣的遮罩，紀錄在 10 秒內、而且是同一台主機時，App 接手，清單第一次畫出來才淡出；SSH 主機還要等通道建好，失敗或 20 秒沒好時顯示原因、重試與回到上一台主機。紀錄只有主機的 id、名稱與外觀，不含 token。

### Native app 的主機儲存

- 主機清單（含 token）存在平台的安全儲存：iOS Keychain、Android 以 Keystore 金鑰加密的 SharedPreferences（`@aparajita/capacitor-secure-storage`），一個 key `hosts`，前綴 `hestia.`，不寫進 WebView 的 `localStorage`。
- iOS：不同步到 iCloud，存取等級 `whenUnlockedThisDeviceOnly`（解鎖時才能讀、不隨備份移到別台裝置）。Android：`allowBackup="false"`；Keystore 金鑰本來就不會被備份。
- **啟動順序**：先從安全儲存讀一次放進記憶體，`setHostStorage()` 換上 native 的實作，**然後**才掛載 app（router 的第一個 guard 就會讀目前主機）。之後 `load()` 回傳記憶體裡的快照；`save()` 先更新記憶體，再把寫入排進一條依序執行的佇列（最後一次寫入一定最後完成）；`flush()` 等佇列清空。
- **iOS 重裝**：iOS 解除安裝 App 不會刪 Keychain。App 用一般的 app preferences（解除安裝會一起刪）記一個「這次安裝已初始化」的標記，沒有標記時先清掉 `hestia.` 前綴下的所有項目，所以重裝後不會出現上次的主機與 token。
- **讀取失敗**（資料損毀、金鑰失效）：成功刪除該筆資料後，提示使用者重新新增並進入新增主機畫面；刪除失敗則停止初始化，避免下次啟動又恢復舊憑證。

### 前端開發伺服器

Vite 預設只監聽 `127.0.0.1:3000`，主機名稱採明確白名單。需要從受信任的反向代理或其他開發裝置連線時，在 `web/` 明確指定監聽位址及逗號分隔的主機名稱：

```sh
VITE_DEV_HOST=0.0.0.0 VITE_DEV_ALLOWED_HOSTS=dev.example.test npm run dev
```

只填自己控制的開發網域，不要改成允許所有主機；對應的防火牆與代理也應限於開發用途。`VITE_DEV_BASE` 控制開發路徑，預設 `/dev/23000/`。這些設定只影響前端開發伺服器，不會放寬後端的 loopback 限制。

### 安全邊界：後端不公開到網際網路

Hestia 後端等同那台機器的完整操作權限：登入後能以使用者的身分執行任何指令。所以後端**只聽 loopback**（`HOST` 只能是 `127.0.0.1`、`::1` 或 `localhost`，其他位址會拒絕啟動），其他裝置只透過兩種方式連到它：

- **Tailscale**：`tailscale serve` 在那台機器上把 tailnet 的 HTTPS 轉到 loopback，只有使用者自己 tailnet 裡的裝置連得到（安裝腳本的 `--tailscale`）。
- **SSH（App）**：App 經使用者自己的 sshd 開 port forward 到 loopback（見下面的「SSH 連線（App）」）。這條路的安全就是 sshd 的安全，sshd 應該只允許金鑰登入。

不支援、也不要用反向代理、tunnel 服務、路由器埠轉發或改監聽位址等任何方式把後端公開到網際網路——那樣唯一的保護只剩帳號密碼。後端照樣把任何帶轉送 header（`X-Forwarded-For`、`X-Real-IP`、`Forwarded`、`CF-Connecting-IP`）的請求當成經過轉送、不是本機，所以就算有人在前面另外架了轉送，local-only 帳號與本機工具 token 也不會因此對外開放；但這只是多一層保險，不是支援那種架法。

### 安全邊界：所有主機共用同一個 origin

網頁的主機 token 共用前端 origin 的分頁 sessionStorage 與執行環境，localStorage 只留主機資料。後端內容經 DOMPurify 或跳脫後顯示，但前端 XSS 仍可能讀到目前分頁所有已登入主機的 token，因此只新增可信任的後端。Native 安全儲存保護落地資料，無法阻止已在 App 中執行的惡意 JavaScript。CSP 限制程式來源與嵌入；為支援使用者自行指定主機，HTTPS API 目的地仍較廣，不能把 CSP 當成完整的資料外洩防線。

## localStorage 分區

`lib/storageKeys.ts` 統一管理所有 key：

- **device 範圍**：設定、版面、側邊欄、便箋篩選、主機資料；localStorage 不含登入憑證。
- **host 範圍**：`sessions-snapshot`、`sessions-cached-at`（清單快取的時間，給主機總覽的卡片）、`projects-snapshot`、`account-status`、`chat-scroll`。每台主機都用 `hestia:host:<id>:<name>`。
- 「設定 › 關於與維護」的「清除本機快取」（會先確認）清掉所有主機的快取；移除一台主機時，只清掉那台主機自己的資料。

## 推播

**模型：網頁版一個瀏覽器一次只接收一台主機的通知；iOS／Android App 每台主機各自開關，可以同時接收多台。**

- 一個瀏覽器只有一個 push subscription，綁定一把 `applicationServerKey`；而每個後端都用自己的 VAPID key 簽章，所以同時接收兩台主機的通知在技術上做不到。
- 「設定 › 通知」的開關指的是**目前的主機**。狀態有 `on`、`off`、`elsewhere`（由另一台主機持有，提示文字會寫出是哪一台）。開啟時會把 subscription 移到這台主機，並用舊主機自己的 token 通知舊主機解除註冊。切換主機後，看到的是那台主機的狀態。
- 訂閱時前端會送出自己替這台主機取的 id（`hostId`，只允許 URL 安全字元）。後端把它存進 subscription，每則通知的連結都會加上 `?host=<id>`。點開通知時，router 會先切換到那台主機，再打開對話。
- 已移除的預設主機建立的 subscription，擁有者在這個瀏覽器已經找不到，狀態顯示為 `elsewhere`；在目前的主機開啟通知時，會直接換掉它（沒有主機可以通知取消，後端之後送推播時會收到失效回應並自行清掉）。
- `push-handler.js` 判斷「這個對話是否正在畫面上」時，只比對路徑、不比對 `?host=`：工作階段 id 是隨機 UUID，一個路徑只會對應到一台主機上的一個對話。
- 移除持有 subscription 的主機之前，會先關閉通知。
- 網頁版沒有做的部分：中央 relay，或由前端提供同一把 VAPID key 讓多台主機同時推播。等到真的需要在瀏覽器同時接收多台主機的通知時再評估。
- **App**：WebView 沒有 Web Push，改經 App 發布者的推播 relay 送到 FCM（見 [API 契約](api-contract-v1.md)的「App 的推播訂閱」）。同一支手機的訂閱憑證可以交給任意多台主機，所以每台主機各自開關、沒有 `elsewhere` 狀態；後端版本太舊（沒有 `native_push`）時顯示 `outdated`。通知的連結同樣帶 `?host=`，點開時先切換主機。App 在前景時不跳系統通知，改在 App 內顯示提示，正在看的對話不提示。

## Native app 要接的地方

- **儲存**：見上面的「Native app 的主機儲存」。
- **配對連結**：App 註冊 `hestia://` scheme，接收 `hestia pair --link app` 的連結（冷啟動與 App 已開啟兩種情況），和網頁版的 `#pair=` 走同一個確認畫面，確認後才呼叫 `POST /auth/pair`。配對碼只放在記憶體，不進網址或 history。
- **推播**：見上面的「推播」（App 經推播 relay 與 FCM／APNs，每台主機各自開關）。
- **API 客戶端**：`apiClient.ts` 的 `createApiClient(host)` 是每台主機一個實例（請求、上傳、media token、串流都綁在那台主機上），`clientFor(host)` 依主機 id 快取，網址或 token 改變時換一個新的。`api.ts` 的函式在每次呼叫時才取目前主機的 client，所以切換主機的行為不變。
- **SSH**：見下一節。

## SSH 連線（App）

App（iOS、Android）可以把一台主機設成經由 SSH 連線；網頁版與 PWA 沒有這個選項。

- **SSH 只當傳輸通道**：App 在手機上開一個 SSH local port forward，`127.0.0.1:<localPort>` → 從 SSH 伺服器看出去的 Hestia API。之後完全走一般的 HTTP API（login → bearer → stream ticket／media token、SSE、上傳），畫面與行為和網址主機相同。遠端仍然要裝 Hestia 後端。
- **連線閘門**：`apiClient.ts` 有一個選用的 `setConnectionGate`，只有 App 設定。每個請求、上傳與串流的 ticket 在發出前，先等那個 `baseUrl` 的 tunnel 就緒（最多 20 秒）；逾時和網路不通一樣處理（重試、「連不上」、串流的重新連線）。指紋不符、認證失敗這類要使用者處理的錯誤立即失敗。網址主機的請求直接通過，網頁版的請求路徑完全不變。
- **tunnel 的生命週期**：tunnel 在原生那一側，切換主機（整頁重新載入）不會中斷它。目前主機的 tunnel 在 App 位於前景時一直維持；其他 SSH 主機只有需要時（例如移除主機時先登出）才臨時開啟，沒有連線 60 秒後自動關閉。App 進背景 30 秒後關閉 SSH 連線，回到前景時自動重連；斷線時依退避重連，網路切換時立刻重連。側邊欄的「主機」區塊不會為了檢查狀態去連每一台 SSH 主機，沒開著 tunnel 的顯示「SSH・切換時連線」。
- **狀態顯示**：目前主機是 SSH 主機時，連線超過 1 秒、重新連線中或失敗時，頁面最上方出現一條橫幅（重試，或到主機的詳細資料處理）。
- **推播不依賴 tunnel**：通知的路徑是「後端 → 推播 relay → FCM／APNs → 手機」，後端只需要能連外網。只有在那台主機開關通知、或推播 token 更新而要重新訂閱時，才需要經 tunnel 呼叫 API。
- **SSH 機密在原生儲存，不回到 JS**：SSH 私鑰與密碼由 App 的原生程式碼存在 iOS Keychain／Android Keystore 保護的儲存裡，JS 只拿到 id、公鑰與指紋；連線時的簽章與認證都在原生端。沒有匯出私鑰的功能。用「貼上」匯入私鑰時，內容會經過 App 的畫面一次（送出後立即清除），所以畫面優先引導從檔案匯入。iOS 重裝時連同 SSH 機密一起清除。
- **主機指紋（TOFU）**：第一次連線時顯示 SSH 伺服器的 host key 指紋（`SHA256:…`，和 `ssh-keygen -lf` 相同）讓使用者核對，信任後才連線。之後以完整公鑰比對；不同就停止連線，**不送出任何認證**，要使用者在主機的詳細資料核對新的指紋並再次確認，沒有「這次先略過」。
- **經 tunnel 的請求對後端是本機請求**：遠端 API 位址是 loopback（預設）時，sshd 從本機連到後端、沒有轉送 header，後端把它當成本機請求，**local-only 帳號可以登入**。但本機請求仍然要認證（帳號密碼，或只有那台主機讀得到的本機工具 token）。
- **手機上的其他 App 也連得到 tunnel 的本機 port**：它們拿不到 Hestia 的 token，要登入仍需要帳號密碼並受登入失敗鎖定限制；但對後端來說它們也是「本機」，local-only 帳號的「只限本機」在這支手機上等於「這支手機上的任何 App」，而且它們的登入失敗會和這台主機上的本機工具算在同一個來源（可能暫時鎖住本機登入）。listener 只綁 `127.0.0.1`、port 隨機、只在 App 位於前景時開著。

## 待辦與已知限制

- 已經開啟的 SSE 串流在登出後不會被中斷（只是不會再重連）。
- push subscription 沒有綁定帳號。
- 帶有 `?ticket=`／`?media=` 的 URL 可能留在瀏覽器紀錄或轉送層的紀錄裡。兩者都是短效而且範圍很窄。
- SSH（App）：
  - 支援 ed25519 與 RSA（2048 位元以上）的 OpenSSH 格式私鑰；ECDSA 私鑰、舊的 PEM 格式、FIDO／security key、SSH 憑證、跳板主機（ProxyJump）、SSH agent、多步驟的 keyboard-interactive 認證都不支援。App 產生的金鑰是 ed25519。
  - iOS 版：SSH 伺服器要有 ed25519 或 ECDSA 的 host key，只有 RSA host key 的伺服器連不上（一般 Linux、macOS 的 sshd 預設就有 ed25519 host key）。Android 版也接受 RSA host key（`rsa-sha2-256/512`）。
  - iOS 版：有密碼的私鑰只讀得了以 aes128／192／256-ctr 加密的（`ssh-keygen` 的預設）；其他加密方式的私鑰匯入時顯示不支援。
  - 不支援硬體保護的金鑰（Secure Enclave／StrongBox）。
  - 不會透過 SSH 在遠端執行指令；配對碼要自己在主機上執行 `hestia pair` 再貼到 App。
  - SSH 主機的名稱、SSH 位址、遠端 API 位址建立後不能修改（移除後重新新增）；認證方式可以在主機的詳細資料更換。
  - 沒有背景常駐的 tunnel：App 在背景 30 秒後斷開，回到前景時重連（推播不受影響）。
  - iOS 版需要 iOS 18 以上（暫定）。
  - `http://` 沒有 HTTP/2，同一台 SSH 主機同時最多 6 條連線；App 最多同時開 3 條串流。
