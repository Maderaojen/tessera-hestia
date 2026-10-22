# 主機平台的例外狀況

- 更新：2026-10-22
- 相關：[安裝說明](../guides/install.md)、[CLI 版本對齊](cli-version-alignment.md)
- 英文版：[host-platform-caveats.en.md](host-platform-caveats.en.md)

這份清單記錄後端在不同作業系統（目前是 Linux、macOS）上遇到的例外狀況，以及 App 所在平台的（目前是 iOS 的 WebKit）：使用者會看到什麼、為什麼、程式能不能察覺、該怎麼處理。遇到新的就加一筆；修好了改「狀態」，不要刪掉，以後改程式時才不會又踩回去。

每一筆的 ID 會和程式的錯誤代碼、介面文字的 key、安裝前檢查的項目共用，文件和程式才找得到彼此。

**狀態**的意思：

- **已處理**：程式已經避開或修正，使用者不用做什麼。
- **有提示**：程式察覺得到，會告訴使用者該怎麼做。
- **只記錄**：程式還察覺不到，靠這份文件說明；後面寫打算怎麼做。

## 總表

| ID | 平台 | 狀態 | 一句話 |
|---|---|---|---|
| [`macos.launchd.no-locale`](#macoslaunchdno-locale) | macOS | 已處理 | 服務沒有語系，tmux 把 tab 印成 `_`，新對話一直停在「啟動中」 |
| [`macos.tcc.prompt-blocks`](#macostccprompt-blocks) | macOS | 只記錄 | 碰到「文件」等資料夾時 Mac 跳出詢問視窗，沒人按就一直卡住 |
| [`macos.tcc.denied-stays`](#macostccdenied-stays) | macOS | 只記錄 | 按過「不允許」之後不會再問，存取一直失敗 |
| [`macos.tcc.new-node-asks-again`](#macostccnew-node-asks-again) | macOS | 只記錄 | 換了一份 Node.js，隱私權要重新允許 |
| [`macos.service.needs-login`](#macosserviceneeds-login) | macOS | 有提示 | 後端只在有人登入 Mac 時執行；開了 FileVault 就不能自動登入 |
| [`macos.power.sleep`](#macospowersleep) | macOS | 有提示 | Mac 睡眠時連不上後端 |
| [`macos.xcode.no-accounts`](#macosxcodeno-accounts) | macOS | 只記錄 | 在工作階段裡匯出 iOS App 時 `xcodebuild` 說 `No Accounts` |
| [`macos.tailscale.app-only`](#macostailscaleapp-only) | macOS | 已處理 | Tailscale App 不能分享資料夾；另裝的 `tailscaled` 以 root 執行 |
| [`all.tailscale.port-taken`](#alltailscaleport-taken) | 全部 | 已處理 | tailnet 的 HTTPS 埠已經給別的服務用了 |
| [`web.chromium.local-network-access`](#webchromiumlocal-network-access) | 網頁版（Chromium 瀏覽器） | 只記錄 | 換一個前端網址後連不上後端：瀏覽器要重新允許「區域網路存取」 |
| [`macos.ps.bsd`](#macospsbsd) | macOS | 已處理 | BSD `ps` 的參數、欄位和時間格式和 Linux 不同 |
| [`macos.tmux.pane-command`](#macostmuxpane-command) | macOS | 已處理 | tmux 用執行檔檔名回報 pane 裡的程式，Claude Code 變成版本號 |
| [`macos.bash32.multibyte-var`](#macosbash32multibyte-var) | macOS | 已處理 | bash 3.2 把緊接在變數後面的中文字當成變數名稱 |
| [`macos.no-sha256sum`](#macosno-sha256sum) | macOS | 已處理 | 沒有 `sha256sum` |
| [`ios.webkit.no-snapshot-gesture-off`](#ioswebkitno-snapshot-gesture-off) | iOS App | 已處理 | 從設定頁左緣右滑返回，看到的是白頁，不是前一頁 |

## macOS

### `macos.launchd.no-locale`

- **平台**：macOS 26.7、tmux 3.8；首次遇到 2026-10-20
- **使用者看到什麼**：從 App 開新對話，tmux 裡的 Claude Code 已經在輸入框等著，App 卻一直顯示「啟動中」。
- **原因**：launchd 啟動的服務沒有語系（沒有 `LANG`）。tmux 在這種情況下會把 `display-message` 格式裡的 tab 印成 `_`，後端把「程式名稱 + tab + pid」切不開，認不出 pane 裡是 CLI，啟動永遠確認不了。從終端機測試不會重現，因為終端機有 `LANG`。
- **怎麼偵測**：用服務的環境（`env -i` 加上 LaunchAgent 的 `PATH`）重跑同一段程式。
- **怎麼處理**：已處理。後端改成請 tmux 印「pid、空格、程式名稱」，從第一個空格切開；安裝腳本也在 LaunchAgent 設 UTF-8 的 `LANG`（用安裝時 shell 的，否則 `en_US.UTF-8`）。
- **狀態**：已處理

### `macos.tcc.prompt-blocks`

- **平台**：macOS 26.7；首次遇到 2026-10-20
- **使用者看到什麼**：新增專案或瀏覽資料夾時，手機上的操作沒有反應、一直轉圈。Mac 螢幕上其實跳出了「node 想要取用『文件』資料夾中的檔案」。
- **原因**：macOS 保護「桌面」「文件」「下載項目」、iCloud Drive、外接與網路磁碟。後端（以及它啟動的 tmux 和 CLI）第一次碰到這些位置時，系統會詢問；沒人回答前，那個操作就停著。每一類資料夾分開問。
- **怎麼偵測**：程式目前察覺不到。
- **怎麼處理**：
  - 使用者：在 Mac 的「系統設定 → 隱私權與安全性 → 完整磁碟取用權限」加入服務用的 `node`（LaunchAgent 的 `ProgramArguments` 第一個，`launchctl print gui/$(id -u)/me.maderaojen.hestia-api` 看得到），就不會再問。
  - 打算做：後端在 macOS 上碰受保護的資料夾時計時，超過幾秒還沒完成就通知 App（含推播），說明要到 Mac 前按允許；安裝完成後讓服務自己讀一次這些資料夾，當場觸發詢問並回報結果。注意 Node 讀寫檔案的背景執行緒只有幾條，同時卡住幾個就會拖住整個後端。
- **狀態**：只記錄

### `macos.tcc.denied-stays`

- **平台**：macOS；首次遇到 2026-10-20
- **使用者看到什麼**：某個資料夾一直讀不到（`Operation not permitted`），也不再跳出詢問。
- **原因**：詢問時按了「不允許」，系統記住這個答案，不會再問。
- **怎麼偵測**：macOS 上，受保護資料夾底下的 `EPERM`。
- **怎麼處理**：使用者到「系統設定 → 隱私權與安全性 → 檔案與資料夾」把 `node` 打開，或用上一筆的完整磁碟取用權限。打算做：後端把這種錯誤回成明確的代碼，App 顯示該去哪裡改。
- **狀態**：只記錄

### `macos.tcc.new-node-asks-again`

- **平台**：macOS；首次遇到 2026-10-20
- **使用者看到什麼**：升級或重裝之後，又開始跳出資料夾的詢問。
- **原因**：隱私權是記在執行檔身上的。升級 Node.js、`nvm` 換版本或重裝，都會換成另一個 `node`，系統當成新程式重問。
- **怎麼偵測**：程式察覺不到。
- **怎麼處理**：用安裝腳本附的 Node.js（沒有合適的系統 Node 時會自動使用，或加 `--bundled-node`），只有主動升級它時才需要重新允許。
- **狀態**：只記錄

### `macos.service.needs-login`

- **平台**：macOS；首次遇到 2026-10-20
- **使用者看到什麼**：Mac 重新開機後，手機連不上這台主機，直到有人在 Mac 前登入。
- **原因**：後端是 launchd 的 LaunchAgent，只在使用者登入時執行。選 LaunchAgent 而不是開機就跑的 LaunchDaemon，是因為只有在登入的工作階段裡，工作階段中的 CLI 才拿得到鑰匙圈和 Xcode 帳號。開了 FileVault 的 Mac 不能自動登入。
- **怎麼偵測**：安裝腳本讀自動登入、FileVault 的設定。
- **怎麼處理**：安裝時說明。常開的 Mac 建議開自動登入；開著 FileVault 時，預計要重開機就用 `sudo fdesetup authrestart`，重開後會自動解鎖登入一次。
- **狀態**：有提示

### `macos.power.sleep`

- **平台**：macOS；首次遇到 2026-10-20
- **使用者看到什麼**：一段時間沒動之後，手機連不上這台主機。
- **原因**：Mac 預設會在閒置後睡眠。
- **怎麼偵測**：安裝腳本讀 `pmset -g` 的 `sleep`。
- **怎麼處理**：安裝時提醒；在「系統設定 → 能源」關掉自動睡眠，或接電源時防止睡眠。
- **狀態**：有提示

### `macos.xcode.no-accounts`

- **平台**：macOS 26.7、Xcode 27.1；首次遇到 2026-10-20
- **使用者看到什麼**：在工作階段裡建置 iOS App，archive 成功、匯出 IPA 時失敗：`error: exportArchive No Accounts`。
- **原因**：`xcodebuild` 讀不到 Xcode 登入的帳號，就無法自動建立 Ad Hoc profile。遇到過兩種情況：Xcode 的帳號狀態壞了（移除再重新加入就好），以及從 ssh 等桌面以外的工作階段執行（可能讀不到；沒有單獨驗證過）。
- **怎麼偵測**：建置的輸出。
- **怎麼處理**：在 Xcode → Settings → Accounts 移除再重新加入 Apple ID，結束 Xcode 再試。後端用 LaunchAgent 執行，工作階段就在登入的桌面工作階段裡，避開 ssh 的情況。App Store Connect 的 API 金鑰若角色是 App Manager，不能取代帳號（沒有雲端發佈憑證的權限）。
- **狀態**：只記錄

### `macos.tailscale.app-only`

- **平台**：macOS、Tailscale 1.104；首次遇到 2026-10-20
- **使用者看到什麼**：用 Homebrew 另裝的 `tailscaled`（以 root 執行）時，`tailscale serve` 要 root 或 operator 加 sudo，HTTPS 憑證也可能一直申請不到；換成 Tailscale App 後，分享資料夾會被拒絕（沙盒限制）。
- **原因**：macOS 上兩種 Tailscale 的權限模型不同。
- **怎麼偵測**：安裝腳本只找 Tailscale App 的 CLI。
- **怎麼處理**：已處理。Hestia 只用 `tailscale serve` 轉發到本機的埠（`http://127.0.0.1:…`），Tailscale App 不需要 root 就能做；安裝腳本在 macOS 上不另外安裝 `tailscaled`，找不到 App 就說明要安裝它。
- **狀態**：已處理

### `macos.ps.bsd`

- **平台**：macOS 26.7；首次遇到 2026-10-20
- **使用者看到什麼**：Codex、Agy 的對話對不上，或 CLI 是否還在判斷成「不知道」。
- **原因**：BSD `ps` 的 `-e` 是「顯示環境變數」，不是「所有行程」（要用 `-A`）；`comm` 是 argv[0]（可能是完整路徑），不在最後一欄時會被截成 16 個字；`lstart` 會跟著語系翻譯（例如「二 10月/20」）。macOS 也沒有 `/proc`。
- **怎麼偵測**：測試用 macOS 實際的 `ps` 輸出。
- **怎麼處理**：已處理。macOS 的實作用 `ps -A`、`comm` 放最後一欄再取檔名、`LC_ALL=C` 讀時間，用 `lsof` 取代 `/proc` 找打開的檔案。
- **狀態**：已處理

### `macos.tmux.pane-command`

- **平台**：macOS 26.7、tmux 3.8；首次遇到 2026-10-20
- **使用者看到什麼**：CLI 是否還在一直判斷成「不知道」。
- **原因**：macOS 的 tmux 用核心記的執行檔檔名回報 `#{pane_current_command}`，不是 argv[0]。Claude Code 的執行檔叫版本號（例如 `2.1.304`）。
- **怎麼偵測**：測試以 `exec -a claude /bin/sleep` 建 pane，比對 tmux 回報的名稱。
- **怎麼處理**：已處理。macOS 改看 pane 前景行程群組 leader 的 argv[0]，和 Linux 的 tmux 一致。
- **狀態**：已處理

### `macos.bash32.multibyte-var`

- **平台**：macOS 的 `/bin/bash`（3.2）；首次遇到 2026-10-20
- **使用者看到什麼**：安裝腳本印出的訊息少了一段，或在 `set -u` 下直接結束、說某個變數沒有定義。
- **原因**：bash 3.2 會把緊接在 `$VAR` 後面的多位元組字元（例如全形括號）當成變數名稱的一部分。
- **怎麼偵測**：在 macOS 的 `/bin/bash` 跑腳本。
- **怎麼處理**：已處理。中文旁邊的變數一律寫 `${VAR}`。
- **狀態**：已處理

### `macos.no-sha256sum`

- **平台**：macOS；首次遇到 2026-10-20
- **使用者看到什麼**：安裝腳本下載 Node.js 後驗證失敗。
- **原因**：macOS 沒有 `sha256sum`。
- **怎麼偵測**：—
- **怎麼處理**：已處理。macOS 改用系統內建的 `shasum -a 256`。
- **狀態**：已處理

## 全部平台

### `all.tailscale.port-taken`

- **平台**：全部；首次遇到 2026-10-20
- **使用者看到什麼**：裝完之後原本的另一個服務（例如另一個網站）連不上，或 Hestia 的網址開到別的東西。
- **原因**：tailnet 的 HTTPS 埠（預設 443）已經轉發給其他服務。
- **怎麼偵測**：安裝腳本在建置與更換服務之前，先讀 `tailscale serve status`。
- **怎麼處理**：已處理。埠被占用時，安裝在動到任何東西前就停下，請你用 `--tailscale-https-port` 換一個埠（例如 8443）。
- **狀態**：已處理

### `web.chromium.local-network-access`

- **平台**：Chrome 等 Chromium 瀏覽器的網頁版（實測 Chrome 155，macOS）；首次遇到 2026-10-22
- **使用者看到什麼**：打開一個新的前端網址（例如把開發版前端搬到另一個子網域）後，新增主機或登入一直失敗，像是連不上後端；同一個後端用舊網址開卻正常。
- **原因**：後端只在 Tailscale 裡（`100.x` 位址），Chromium 把它當成區域網路。公開網站要連區域網路位址，必須先由使用者允許「區域網路存取」，而這個權限是**每個網站各自記**的：舊網址允許過，新網址要重新允許。沒允許（或詢問被略過、按過封鎖）時，請求在送出前就被擋下，主控台寫 `Permission was denied for this request to access the 'local' address space`，網頁只拿到 `Failed to fetch`，和後端關機、CORS 不符看起來一樣。
- **怎麼偵測**：網頁察覺不到原因，只看得到請求失敗。從主機端看後端正常（`curl` 本機與 ts.net 網址都回 200、CORS 預檢正確）。
- **怎麼處理**：在那個網址允許區域網路存取後重新整理：點網址列左邊的圖示 →「網站設定」→「區域網路存取權」改成「允許」（或 Chrome 設定 →「隱私權和安全性」→「網站設定」→「其他權限」→「區域網路存取權」）。App 不受影響。之後打算在登入頁的連線失敗訊息裡提示這一步。
- **狀態**：只記錄

## iOS App

### `ios.webkit.no-snapshot-gesture-off`

- **平台**：iOS App 的 `WKWebView`（WebKit 的行為；iOS Safari 沒有這個問題）；首次遇到 2026-10-21
- **使用者看到什麼**：在 App 裡從首頁打開設定，從左緣往右滑返回時，手指拉開的地方是一整片白，看不到首頁；放手後才換回首頁。頁面上的返回按鈕正常。
- **原因**：左緣右滑時，WebKit 滑開的是前一頁的「快照」，快照在離開那一頁、歷史紀錄往前走的那一刻拍下，而且只在 `allowsBackForwardNavigationGestures` 開著時才拍。App 原本在首頁把這個手勢關掉（首頁沒有可以回去的頁面），所以離開首頁時沒有快照，滑回首頁就只能畫白的。Safari 一直開著手勢，所以有快照。
- **怎麼偵測**：程式察覺不到（拍不拍快照沒有任何訊號），只能實機看。
- **怎麼處理**：已處理（網頁端，沒有改原生程式）。首頁不再關掉手勢，而是和 iOS Safari 一樣在起點擋掉：左緣 24 px 內開始的觸控在 touchstart 就 `preventDefault()`，從按鈕等控制項開始的不擋（`web/src/shell/navigation/nativeBackGesture.ts`）。對話頁為了網頁自己的左緣返回仍然關著手勢（它的返回按鈕伸進左緣，擋在起點會吃掉點擊），改成離開對話頁的那一刻（換頁的 `beforeEach`）先打開，換頁結束再設回該頁要的狀態，讓 WebKit 拍得到對話頁的快照。待實機確認。
- **狀態**：已處理
