# 安裝 Hestia 後端

- 更新：2026-10-22
- 英文版：[install.en.md](install.en.md)

前端是 Hestia App（iOS／Android），它本身不碰你的電腦，也**不內建任何後端**；每個人在自己的機器上跑一個後端，再在前端「新增主機」指向它。這份文件說明怎麼安裝那個後端。整個過程不需要 root，連 Tailscale 也不需要。

> **後端不能公開到網際網路。** Hestia 後端等同這台機器的完整操作權限：登入後能以你的身分執行任何指令。後端只聽本機（`127.0.0.1`），其他裝置只透過兩種方式連到它：**Tailscale**（`--tailscale`，見「用 Tailscale 連回來」）或 **Hestia App 的 SSH 連線**（見「用 SSH 連」）。不要用反向代理、tunnel 服務、路由器埠轉發或改監聽位址等任何方式把後端公開到網際網路——那樣唯一的保護只剩帳號密碼。

## 需要什麼

- Linux（systemd 使用者服務；沒有 systemd 也能前景執行），或 macOS（launchd 的 LaunchAgent，在你登入 Mac 桌面時執行，見「macOS」）。Windows 請在 WSL 裡安裝（WSL 就是 Linux，見「Windows」）
- Node.js：**不必自己裝**。系統的 node 符合 `api/package.json` 的 `engines`（目前 22.12 以上）就用它；沒有、太舊（例如 v20）或沒有附 npm 時，腳本會從 nodejs.org 下載同一個主版本的最新官方版，驗證 SHA-256 後放在 `~/.local/share/hestia/node/`，只給你這個使用者用，不動系統的 node
- tmux（macOS：`brew install tmux`）
- 至少一個 AI CLI：`claude`、`codex`、`gemini` 或 `agy`（沒有也能裝，但開不了對話）
- 建議：一個 [Tailscale](https://tailscale.com/) 帳號（個人使用免費），手機安裝 Tailscale App 並登入。Linux 上這台機器的 Tailscale 由安裝腳本處理，不用自己裝；macOS 請先安裝並登入 Tailscale App

## 安裝

### 一行安裝（已簽章的版本）

```bash
curl -fsSL https://github.com/maderaojen/tessera-hestia/releases/latest/download/install.sh | sh -s -- --tailscale
```

`sh -s --` 後面的參數會原封不動交給安裝腳本（見下方的參數表）。這一行會：

1. 從 [GitHub Releases](https://github.com/maderaojen/tessera-hestia/releases) 下載最新的版本包 `hestia-vX.Y.Z.tar.gz`、`SHA256SUMS` 與 `SHA256SUMS.sig`，先用發布公鑰驗證簽章，再驗證 SHA-256，並確認版本包裡沒有跑出 `hestia-vX.Y.Z/` 的路徑或連結。發布公鑰寫在 `install.sh` 裡；第一次安裝時存成 `~/.local/share/hestia/release-public.pem`，之後的升級都用這個檔案驗證。
2. 解壓到暫存的 `~/.local/share/hestia/app.new/`，帶上現有安裝的 `.env`，執行 `npm ci --omit=dev`（版本包已經建置好，不需要 build）。這一步失敗時，原本的安裝完全不動。
3. 換成 `~/.local/share/hestia/app/`，接著執行版本包裡的 `scripts/install.sh`（帳號密碼、使用者服務（Linux 是 systemd，macOS 是 launchd）、Tailscale、配對 QR code）。問題會問在終端機上。

可以用環境變數調整：`HESTIA_VERSION=vX.Y.Z`（裝指定版本，預設最新）、`HESTIA_HOME`（預設 `~/.local/share/hestia`）、`HESTIA_RELEASE_PUBLIC_KEY`（改用你自己放的公鑰檔）。環境變數要給 `sh`，例如 `curl -fsSL … | HESTIA_VERSION=vX.Y.Z sh -s -- --tailscale`。

想先看過安裝器再執行：下載下來，核對其中公鑰的指紋（[發布簽章](release-signing.md)「一行安裝信任的是什麼」），再執行它：

```bash
curl -fsSLO https://github.com/maderaojen/tessera-hestia/releases/latest/download/install.sh
less install.sh
sh install.sh --tailscale
```

**重跑就是升級**：設定與資料都在狀態資料夾 `~/.config/madera/hestia/`（設定是裡面的 `.env`），都會保留，服務重新啟動，tmux 裡的對話不受影響。

### 從原始碼安裝

```bash
git clone https://github.com/maderaojen/tessera-hestia.git
tessera-hestia/api/scripts/install.sh --tailscale
```

會在本機 `npm ci` 並建置。升級：`git pull` 後重跑同一個腳本。

### 安裝腳本的參數

下文的 `api/` 指程式資料夾：一行安裝是 `~/.local/share/hestia/app/`，從原始碼安裝是 repo 裡的 `api/`。

腳本會問帳號、密碼（輸入時不顯示）與埠號，其餘用預設值。不想被問，可以全部用參數給：

```bash
printf '%s\n' "$PASSWORD" | api/scripts/install.sh --yes --username me --password-stdin --tailscale
# 一行安裝也可以用環境變數：
curl -fsSL https://github.com/maderaojen/tessera-hestia/releases/latest/download/install.sh | HESTIA_PASSWORD="$PASSWORD" sh -s -- --yes --username me --tailscale
```

| 參數 | 用途 |
| --- | --- |
| `--yes` / `--non-interactive` | 不詢問；沒給的值沿用上次設定或預設值 |
| `--username NAME` | 登入帳號 |
| `--password-stdin` | 從 stdin 讀密碼；也可用環境變數 `HESTIA_PASSWORD`。已有密碼時不給就沿用 |
| `--port PORT` | API 埠號，預設 4791 |
| `--cors-origins LIST` | 允許的前端來源，逗號分隔，**取代**預設值；給 `default` 改回預設。預設只有 Hestia App WebView 的四個來源：`capacitor://localhost`、`https://localhost`、`tauri://localhost`、`http://tauri.localhost`（見「連上前端」）。配對的網頁連結（`hestia pair --link web`）會跳過這四個 App 來源 |
| `--state-dir DIR` | 狀態資料夾，預設 `${MADERA_HOME:-${XDG_CONFIG_HOME:-~/.config}/madera}/hestia`（`~/.config/madera/` 是 Tessera 家族工具共用的位置，見「路徑與名稱」）；相對路徑會轉成絕對路徑再寫入 |
| `--session-prefix P` | 這個後端建立的 tmux 工作階段名稱字首，預設 `hestia-`；只能用英數字、`-`、`_` |
| `--tailscale` | 用 Tailscale 讓你的裝置以 HTTPS 連到 API，見「用 Tailscale 連回來」 |
| `--tailscale-https-port PORT` | tailnet 上的 HTTPS 埠號，預設 443；已被別的服務占用時換一個（例如 8443）。占用的話腳本在建置、改動服務之前就會停下來說明 |
| `--service-name NAME` | 使用者服務名稱，預設 `hestia-api`（macOS 上是 LaunchAgent `me.maderaojen.hestia-api`）；同一台機器跑兩個後端時各給不同名稱 |
| `--command-name NAME` | 放進 `~/.local/bin` 的指令名稱，預設 `hestia`；只能用小寫英數字與 `-`。同一台機器跑兩個後端時各給不同名稱，這個後端交給 LLM 的指令（例如指派完成時回報）也用這個名稱。重跑沒給時沿用上次的名稱，`--uninstall` 只移除這個名稱的連結 |
| `--no-service` | 不裝使用者服務（systemd／launchd），只建置與設定 |
| `--no-linger` | Linux：不開啟 linger（見下方）；預設會問，`--yes` 時直接開啟。macOS 沒有 linger，這個參數沒有作用（見「macOS」） |
| `--bundled-node` | 即使系統的 node 夠新，也用自己下載的那份 |
| `--skip-build` | 跳過 `npm ci` / `npm run build`（一行安裝已經先裝好相依套件，會自動加上） |
| `--deps-only` | 只選好 Node.js 並安裝相依套件（原始碼會建置），不寫設定、不裝服務；一行安裝用它在暫存資料夾準備新版本 |
| `--status` | 只顯示目前安裝的狀況（服務、API、帳號、Tailscale 網址）與配對連結，不做任何變更 |
| `--uninstall [--purge]` | 移除，見下方 |

腳本和 `hestia` 指令的訊息是繁體中文或英文：先看 `HESTIA_LOCALE`，再看 `LC_ALL`、`LC_MESSAGES`、`LANG`（`C`／`POSIX` 不算），都沒有就是繁體中文。例如 `HESTIA_LOCALE=en api/scripts/install.sh --status`。

密碼不會出現在指令列或檔案裡——寫進去的只有 scrypt 雜湊（與 `npm run set-credentials` 相同）。之後要改密碼，重跑安裝腳本（會重啟服務）；也可以在程式資料夾執行 `npm run set-credentials`（一行安裝是 `cd ~/.local/share/hestia/app && npm run set-credentials`），再自行重啟服務。登入帳號不能包含 `#`（`.env` 會把它後面當成註解）。

## 裝了什麼、在哪裡

| 位置 | 內容 |
| --- | --- |
| `api/node_modules`、`api/dist` | 相依套件與建置結果（一行安裝：版本包附的 `dist/`，`node_modules` 只有執行所需的套件） |
| `api/.hestia-release` | 只在版本包裡：它的版本號。安裝腳本看到它就只裝相依套件、不建置 |
| `~/.config/madera/hestia/.env`（權限 600；`api/.env` 是連到它的連結，讀寫都經過這個連結） | `AUTH_USERNAME`、`AUTH_PASSWORD_HASH`、`PORT`、`HOST`（一律是 `127.0.0.1`，見「安全須知」）、`CORS_ALLOWED_ORIGINS`（沒給 `--cors-origins` 時留白，代表用後端的預設值）、`HESTIA_STATE_DIR`、`HESTIA_SESSION_PREFIX`、`HESTIA_ENV_VERSION`（寫這份 `.env` 的安裝腳本版本，升級時判斷要不要搬移舊設定）、`HESTIA_NODE_BIN`（這次選用的 node 路徑，讓 `hestia` 指令和服務跑同一個 node；舊版另存在 `api/.node-bin`，重跑安裝時會移除）。服務用 `--env-file` 載入它，設定不見時服務會啟動失敗，不會以沒有帳號的狀態跑起來 |
| `~/.config/systemd/user/hestia-api.service` | Linux 的使用者服務：`Restart=on-failure`，`KillMode=process`（重啟 API 不會關掉 tmux 裡的對話） |
| `~/Library/LaunchAgents/me.maderaojen.hestia-api.plist`、`~/Library/Logs/Hestia/hestia-api.log` | macOS 的使用者服務（LaunchAgent）與它的紀錄：`RunAtLoad`、失敗時重啟（`KeepAlive`）、`AbandonProcessGroup`（停掉或重啟 API 不會關掉 tmux 裡的對話） |
| `~/.local/share/hestia/node/`（設了 `HESTIA_HOME` 時是它底下的 `node/`） | 只在系統 node 不夠新、沒有 npm（或 `--bundled-node`）時：下載的 Node.js，`current` 指向使用中的版本 |
| `api/.env` 的 `HESTIA_PUBLIC_URL` | 用 `--tailscale` 時：這個後端在 tailnet 上的網址，`hestia pair` 用它產生配對連結 |
| `~/.local/bin/hestia` | 指向 `api/bin/hestia` 的連結，在終端機開一個手機也看得到的 tmux。已經指向另一份安裝時會先問，`--yes` 時保留原本的 |
| `~/.local/bin/tailscale`、`tailscaled`、`~/.config/systemd/user/tailscaled.service`、`~/.local/share/tailscale/` | 只在 Linux、`--tailscale` 且機器上沒有可用的 Tailscale 時：官方執行檔、以使用者身分執行的服務、它的狀態（macOS 不會裝這些，用 Tailscale App） |
| `~/.config/madera/hestia/`（權限 700；見下方「路徑與名稱」） | 狀態：工作階段清單、專案、便箋、上傳的圖片、對話紀錄備份（`dialogue/`） |

### 路徑與名稱

後端用到的主機路徑與名稱都由 `api/src/config.ts` 決定，每一項都能在 `api/.env` 用環境變數覆寫（留白等於沒設）：

| 變數 | 預設值 |
| --- | --- |
| `HESTIA_STATE_DIR` | `${MADERA_HOME:-${XDG_CONFIG_HOME:-~/.config}/madera}/hestia` |
| `HESTIA_SESSION_PREFIX` | `hestia-` |
| `HESTIA_TMUX_SOCKET` | 字首去掉結尾的 `-`（`hestia`）：Hestia 自己的 tmux server，`tmux -L hestia attach` 連上 |
| `HESTIA_DIALOGUE_ROOT` | `<狀態資料夾>/dialogue` |
| `HESTIA_USER_BIN_DIR` | `~/.local/bin`（找 `janus`、`claude` 用） |
| `HESTIA_WORKTREES_DIR` | 不設：指派與支線新開的 worktree 放在 repo 旁邊的 `<repo 名>-worktrees/`；上層不能寫入時放 `${XDG_DATA_HOME:-~/.local/share}/madera/hestia/worktrees`。設了（絕對路徑）就全部放這裡 |

- 設定檔 `.env` 放在狀態資料夾裡，程式資料夾的 `api/.env` 只是連結，所以整個程式資料夾換掉也不會遺失設定。舊版把 `.env` 直接放在 `api/`；重跑安裝時會自動搬到狀態資料夾並換成連結。`--state-dir` 改到別的資料夾時，設定會複製過去，舊的那份保留。
- 安裝腳本會把實際決定的狀態資料夾與 tmux 字首寫進 `.env`，讓服務與 `hestia` 指令（兩者的環境變數不一定相同，例如 `MADERA_HOME`、`XDG_CONFIG_HOME`）永遠一致，之後重跑也不會改名。
- 後端啟動時會在紀錄（Linux：`journalctl --user -u hestia-api.service`；macOS：`~/Library/Logs/Hestia/hestia-api.log`）各印一行，說明用了哪個狀態資料夾、字首、tmux server 與對話紀錄位置，以及是否來自 `.env`。
- 字首之後改掉只影響新開的工作階段；registry 已記錄的工作階段不論字首都照常對得上 tmux。同一台機器跑兩個後端時，請給不同的狀態資料夾與字首，彼此就不會把對方的工作階段當成自己的；也給不同的服務名稱、埠號與指令名稱（`--service-name`、`--port`、`--command-name`），兩個指令就各自連自己的後端。
- Janus 與 Mnemosyne 是同一家族（Tessera）的**選用**工具，沒有也能完整使用 Hestia，目前也還沒公開：Janus 讓同一台電腦用多組 Claude Code／Codex 帳號，裝了它，Hestia 會把它的帳號列進啟動選項與額度查詢；Mnemosyne 匯出 CLI 的對話紀錄。
- `MADERA_HOME` 是 Tessera 家族共用的資料根目錄（預設 `~/.config/madera`），Janus、Mnemosyne 也用它；Hestia 放在它底下的 `hestia/`。只認絕對路徑。安裝時有設就會跟著，並固定寫進 `.env`；已經安裝好之後才設，不會搬動現有的狀態資料夾（要搬就用 `--state-dir`）。
- 要把對話紀錄匯出到 Mnemosyne，設定 `HESTIA_DIALOGUE_ROOT=~/.config/madera/mnemosyne/dialogue`（寫絕對路徑）。
- AI CLI 的原生資料夾：Codex 依 `CODEX_HOME`、Gemini CLI 依 `GEMINI_CLI_HOME`（`.gemini` 的上層）；沒設就是 `~/.codex`、`~/.gemini`。Claude Code 的原生帳號固定是 `~/.claude`，刻意不跟著繼承來的 `CLAUDE_CONFIG_DIR`（見 `docs/reference/account-status.md`）。

服務檔（`~/.config/systemd/user/hestia-api.service`，macOS 是 `~/Library/LaunchAgents/me.maderaojen.hestia-api.plist`）若已存在、但不是這個腳本寫的（例如手動建立的），腳本會停下來不覆蓋；確認內容後自行移走再重跑，或加 `--no-service`。

服務寫死了安裝當下的 node 路徑與 `PATH`（使用者服務看不到 nvm 或 CLI 的安裝位置）。換了 Node 版本或 CLI 裝到新地方，重跑安裝腳本即可。

使用者服務預設只在你登入時執行，登出（例如關掉 SSH）後手機就連不到了。安裝時腳本會問要不要開啟 linger（預設是），讓後端和 Tailscale 在登出、重開機後也繼續執行；多數系統允許使用者替自己開啟，需要管理員權限時腳本會印出要執行的 `sudo loginctl enable-linger $USER`。

沒有 systemd 的機器：加 `--no-service`，再到一個 tmux 視窗裡執行 `cd api && node --env-file=.env dist/src/main.js`。注意 `--env-file` 不會覆蓋環境裡已經有的變數：shell 裡若已 export 了 `PORT`、`HOST` 或 `AUTH_*`，以 shell 的為準。

### macOS

在 Mac 上（Apple Silicon 或 Intel，bash 用系統內建的就好），後端裝成 launchd 的 **LaunchAgent**（`~/Library/LaunchAgents/me.maderaojen.hestia-api.plist`），每次重跑安裝都用 `launchctl bootout`／`bootstrap gui/<uid>` 重新載入。需要先 `brew install tmux`；Node.js 和 Linux 一樣，不夠新時腳本會下載 macOS 版並用 `shasum -a 256` 驗證。

- **為什麼是 LaunchAgent**：它跑在你登入的桌面工作階段裡，後端開的 tmux 和裡面的 CLI 都拿得到登入鑰匙圈與 Xcode 的帳號（例如在這台 Mac 上讓 Claude 建置 iOS App）。開機就跑、不需要登入的 LaunchDaemon 在這個工作階段之外，`xcodebuild` 會說找不到帳號，鑰匙圈也打不開。
- **代價：要登入 Mac 桌面**。沒有 linger 這回事：你登入 Mac 時它就啟動，關掉終端機或 ssh 登出都不會停；登出桌面或重新開機後，要等下次登入才會再跑。要讓 Mac 一直提供服務，開啟自動登入（系統設定 → 使用者與群組 → 自動以此身分登入）。開著 FileVault 時無法自動登入，重新開機後要有人在 Mac 本機登入（預先安排的重開機可用 `sudo fdesetup authrestart` 自動解鎖一次）。睡眠時也連不上，建議在「系統設定 → 能源」防止自動睡眠。安裝腳本會檢查這幾項並說明。
- 只用 ssh 連進一台**沒有人登入桌面**的 Mac 時，沒有可以裝服務的工作階段，腳本會說明並印出前景執行的指令；先在 Mac 本機登入再重跑。
- 停掉或重啟後端不會關掉 tmux：LaunchAgent 設了 `AbandonProcessGroup`，和 Linux 的 `KillMode=process` 一樣只停 node。
- **「文件」「桌面」「下載項目」等資料夾**：後端第一次碰到時，Mac 螢幕上會跳出「node 想要取用…」，沒人按之前那個操作會一直卡住，手機上只看到沒反應。建議裝完就在「系統設定 → 隱私權與安全性 → 完整磁碟取用權限」加入服務用的 `node`（`launchctl print gui/$(id -u)/me.maderaojen.hestia-api` 的 `program`）。
- 其他 macOS 上的例外狀況（服務沒有語系、睡眠、Xcode 帳號等）見[主機平台的例外狀況](../reference/host-platform-caveats.md)。
- 常用指令：`launchctl print gui/$(id -u)/me.maderaojen.hestia-api`（狀態）、`launchctl kickstart -k gui/$(id -u)/me.maderaojen.hestia-api`（重啟）、`tail -f ~/Library/Logs/Hestia/hestia-api.log`（紀錄）。紀錄檔不會自動輪替，太大時直接清空即可。

### Windows

不支援直接在 Windows 上安裝（後端需要 tmux）。請用 WSL 2：在 PowerShell 執行 `wsl --install`，打開它的 Ubuntu 終端機，照 Linux 的方式安裝。WSL 裡要有 systemd 才能裝成使用者服務（新版 WSL 的 Ubuntu 預設已開啟；沒有的話在 `/etc/wsl.conf` 加上 `[boot]` 與 `systemd=true`，再 `wsl --shutdown`），否則用 `--no-service` 前景執行。Windows 關機或 `wsl --shutdown` 時後端也會停止。

## 連上前端

1. **掃碼登入（建議）**：用 `--tailscale` 安裝時，腳本最後會印出一個 **QR code**。手機裝好 Tailscale App 並登入同一個帳號後，在 Hestia App 的「新增主機」按「掃描 QR code」（或用手機相機掃描，會直接交給 App 打開），會先顯示這台主機的完整網址，問「要新增並登入這台主機嗎？」，確認是自己的主機後按「新增並登入」即可，不用輸入帳號密碼（不認得的網址就按「取消」）。QR code 裡是一組**一次性配對碼**：3 分鐘內有效、只能用一次，放在網址的 `#` 後面（瀏覽器不會把它送給任何伺服器）。之後要加新手機或配對碼過期，在這台主機執行 `hestia pair` 產生新的。

   `hestia pair` 印出 QR code 後會停著倒數，等配對碼被用掉就顯示是哪台裝置、幾點用的。如果不是你自己掃的，照提示輸入 `r` 就會撤銷那次登入。不想等就加 `--no-wait`（安裝腳本最後印 QR code 時就是這樣）。

   用 SSH 新增主機時，連上之後的「登入 Hestia」也一樣按「掃描 QR code 登入」，掃 `hestia pair` 的 QR code 就好；App 只取裡面的配對碼，經 SSH 連線登入，不用帳號密碼。

   `hestia pair` 可以印兩種連結，用 `--link` 選（沒給時看 `api/.env` 的 `HESTIA_PAIR_LINK`，都沒有就是 `app`）：

   | `--link` | 印出 | QR code 裡 |
   | --- | --- | --- |
   | `app`（預設） | Hestia App 的深層連結 `hestia://pair?url=<後端網址>#code=<配對碼>` | 這個連結（相機會直接交給 App 打開） |
   | `web` | 網頁前端的連結 `https://<網頁前端>/login?mode=add&url=<後端網址>#pair=<配對碼>`（自己架網頁前端時用） | 這個連結 |
   | `both` | 兩種都印，同一組配對碼，先用掉的那個有效 | 網頁連結 |

   網頁連結開的是 `CORS_ALLOWED_ORIGINS` 裡第一個網頁來源（跳過 App 的來源）。App 自己的掃描器兩種連結都接受（格式見 `docs/reference/api-contract-v1.md` 的「配對連結」）。不論哪一種，App 和網頁一樣**先顯示後端網址、使用者確認後才配對**。
2. **手動**：打開 Hestia App，第一次會直接看到「新增主機」；已經有主機時，從登入頁的主機選單或側邊欄「主機」區塊選「新增主機」，填入後端網址（`hestia pair` 或 `--status` 會顯示，例如 `機器名稱.tailnet.ts.net`；`https://` 可以省略，但 `.ts.net` 之前的部分要完整），再用安裝時設的帳號密碼登入。
3. 前端會先確認後端的 API 版本相容，不相容會說明要更新哪一邊。
4. 之後在側邊欄的「主機」區塊切換主機，也可以在那裡重新命名、登出或移除任何一台。設計細節見 `docs/reference/multi-host-design.md`。

後端只接受 `CORS_ALLOWED_ORIGINS` 列出的前端來源。留白（預設）時允許 Hestia App WebView 的四個固定來源：iOS `capacitor://localhost`、Android `https://localhost`、macOS `tauri://localhost`、Windows `http://tauri.localhost`；官方網頁前端不在預設裡。自己架網頁前端的話，用 `--cors-origins` 明確列出要允許的全部來源，**清單會取代預設值**；要讓各 App 也能連，就把相應來源一併列進去（例如 `--cors-origins "https://my-frontend.example,capacitor://localhost,https://localhost,tauri://localhost,http://tauri.localhost"`）。`*` 會被忽略，不能用萬用來源。App WebView 使用 bearer token，不會收到 `Access-Control-Allow-Credentials`。配對網頁連結會跳過四個固定 App 來源，只選清單中第一個一般網頁來源，找不到時回退官方網頁。


### 用 SSH 連（Hestia App）

Hestia App（iOS、Android）也可以經由 SSH 連到後端：App 在手機上開一條 SSH 轉送，接到這台機器的 `127.0.0.1:4791`。後端維持只聽 `127.0.0.1`，不需要 `tailscale serve`，也不需要 HTTPS 網址。網頁版沒有這個方式。

需要：

- 這台機器有在跑 sshd，而且手機連得到它（例如 Tailscale 的 `100.x` 位址或區域網路）。這條路靠的是你自己的 sshd，它的安全就是後端的安全：sshd 應該**只允許金鑰登入**（`/etc/ssh/sshd_config` 設 `PasswordAuthentication no`、`KbdInteractiveAuthentication no`），能從網際網路連到的 sshd 更是如此。
- sshd 允許 TCP 轉送：`/etc/ssh/sshd_config` 的 `AllowTcpForwarding` 不是 `no`（預設是 `yes`），也沒有 `DisableForwarding yes`。被擋的話 App 會顯示「這台主機不允許 SSH 轉送」。
- 後端維持預設，只聽 `127.0.0.1`（照上面安裝的就是）。後端改過埠的話，在 App 新增主機時的「進階」改遠端 API 的埠。
- iOS 版的限制：sshd 要有 ed25519 或 ECDSA 的主機金鑰，只有 RSA 主機金鑰的伺服器連不上（一般 Linux、macOS 的 sshd 預設就有 ed25519）；匯入有密碼的私鑰時，只讀得了以 aes128／192／256-ctr 加密的（`ssh-keygen` 的預設），其他加密方式會顯示不支援。

步驟：

1. 在 App 的「設定 › 帳號與安全 › SSH 金鑰」按「產生金鑰」（ed25519；私鑰只存在手機的安全儲存，不會離開手機），按「複製限制版（建議）」，把那一行加進這台機器的 `~/.ssh/authorized_keys`：

   ```
   restrict,port-forwarding,permitopen="127.0.0.1:4791" ssh-ed25519 AAAA… hestia-…
   ```

   限制版的意思：這把金鑰只能轉送到 Hestia 的 API（`127.0.0.1:4791`），不能開 shell、不能執行指令，也不能轉送到其他埠；手機遺失時，它最多只能拿來連 Hestia，而 Hestia 仍然要帳號密碼。也可以匯入電腦上既有的私鑰（OpenSSH 格式的 ed25519 或 2048 位元以上的 RSA；舊的 PEM 格式先用 `ssh-keygen -p -f <私鑰檔>` 轉換）。App 也能用 SSH 密碼登入，但那要 sshd 允許密碼登入，不建議。
2. App 的「新增主機」選「SSH」，填 SSH 主機（主機名稱或 IP）、埠、使用者名稱與金鑰，按「連線」。
3. 第一次連線時，App 會顯示這台機器的主機金鑰指紋。在這台機器上核對：

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

   （App 會依金鑰類型顯示對應的檔名，例如 `ssh_host_ecdsa_key.pub`。）相同才按「信任並連線」。之後指紋改變時，App 會停止連線、不送出任何認證，要你重新核對並確認。
4. 用安裝時設的帳號密碼登入 Hestia；或按「改用配對碼」，貼上在這台機器執行 `hestia pair` 印出的連結或配對碼（App 只取配對碼，不管連結裡的網址）。

經 SSH 的請求，對後端來說是從這台機器本機發出的，所以**限定本機使用的帳號（local-only）也能登入**。App 只在前景時維持 SSH 連線，進背景 30 秒後斷開、回到 App 時自動重連；通知不需要這條連線。

## 用 Tailscale 連回來（建議）

後端預設只聽 `127.0.0.1`，網路上的任何人都連不到它。Tailscale 把你自己的裝置放進同一個私人網路（tailnet），手機不用這台機器對外開任何埠就能連回來。`--tailscale` 會：

1. **找 Tailscale**：機器上已有、而且這個使用者叫得動的系統 Tailscale 就用它。macOS 只用 Tailscale App（`tailscale` 指令，或 App 裡的 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`）：沒有安裝或沒有回應時，腳本會說明要先安裝、打開並登入 App，然後停下來。Linux 上找不到時**只替你自己裝一份**：從 `pkgs.tailscale.com` 下載官方執行檔並驗證 SHA-256，放進 `~/.local/bin`，以使用者服務 `tailscaled.service` 的使用者空間網路模式執行（沒有 TUN 裝置，所以不需要 root；`tailscale serve` 照樣可用）。
2. **登入**：這台機器還沒加入 tailnet 時，印出登入網址和 QR code（可以用手機掃了登入），等你登入（最多 15 分鐘）。
3. **開放 API**：`tailscale serve --bg --https=<埠> http://127.0.0.1:<API 埠>`。tailnet 第一次使用 serve 時，Tailscale 會要你允許一次；腳本會把那個網址（和 QR code）顯示出來，允許後自動繼續。
4. 把 `https://<機器名稱>.<tailnet>.ts.net` 寫進 `api/.env` 的 `HESTIA_PUBLIC_URL`，再執行 `hestia pair` 印出配對 QR code。

`tailscale serve` 只對你 tailnet 裡的裝置開放，並自動申請 Let's Encrypt 憑證。後端網址必須是 HTTPS：前端是 HTTPS 頁面，瀏覽器不讓它呼叫 http 的位址；IP 又拿不到瀏覽器信任的憑證，所以用 Tailscale 給的 `ts.net` 名稱。

- 系統的 Tailscale 以一般使用者執行 `tailscale serve` 被拒絕時，先授權一次：`sudo tailscale set --operator=$USER`。
- 腳本不會蓋掉 tailnet 上已經轉給別的服務（HTTPS 代理或 TCP 轉送）的埠；Tailscale 已經在跑時，會在建置、改動服務之前就停下來說明，請用 `--tailscale-https-port` 換一個（例如 `--tailscale-https-port 8443`）。
- Linux：Tailscale 也是使用者服務，和後端一樣靠 linger 在登出、重開機後繼續執行（見上方）。
- macOS：Tailscale App 不需要 sudo 就能用 `tailscale serve` 代理到後端；要先在 tailnet 開啟 HTTPS 憑證（Tailscale 管理後台的 DNS 頁）。

## 安全須知

- 這個後端能開 tmux、瀏覽檔案、啟動 AI CLI——**拿到帳密就等於拿到這台機器你這個使用者的 shell**。請用夠長、沒在別處用過的密碼。
- **不要把後端公開到網際網路**：只透過 Tailscale 或 Hestia App 的 SSH 連線使用。不要用反向代理、tunnel 服務、路由器埠轉發或改監聽位址等任何方式把後端公開出去——那樣唯一的保護只剩帳號密碼。
- 後端只聽本機：`HOST` 只能是 `127.0.0.1`（或 `::1`、`localhost`），設成其他位址時後端會拒絕啟動。舊版安裝的 `.env` 裡如果是其他位址，重跑安裝腳本時會改回 `127.0.0.1` 並印出警告；如果你原本另外架了反向代理、tunnel 服務或埠轉發，請一併停用。
- **不要用 Tailscale Funnel**（`tailscale funnel`）：Funnel 會把服務公開給整個網際網路，正好違背上面那條。用 `serve`，只給自己的 tailnet。
- 設定（`.env`）與狀態資料夾只有你自己讀得到；不要把 `.env` 提交進 git（已在 `.gitignore`）。
- 用 SSH 連（App）時，安全靠的是你自己的 sshd：讓它只允許金鑰登入（見「用 SSH 連」），`authorized_keys` 建議用 App 提供的限制版那一行（`restrict,port-forwarding,permitopen="127.0.0.1:4791"`），讓那把金鑰只能轉送到 Hestia 的 API。
- App 經 SSH 連線期間，會在手機的 `127.0.0.1` 開一個本機埠（隨機、只在 App 位於前景時開著）。手機上的其他 App 也連得到它，對後端來說也算「本機」：它們拿不到登入 token，仍然要帳號密碼；但 local-only 帳號在這支手機上等於對所有 App 開放，而且它們猜錯密碼可能讓這台機器的本機登入暫時被鎖住。不放心的話，不要在這支手機上經 SSH 使用 local-only 帳號。

## 重跑、升級與改設定

```bash
# 一行安裝的：重跑同一行
curl -fsSL https://github.com/maderaojen/tessera-hestia/releases/latest/download/install.sh | sh
# 從原始碼安裝的
cd tessera-hestia && git pull
api/scripts/install.sh
```

只改設定、不換版本：直接執行程式資料夾裡的 `scripts/install.sh`（一行安裝是 `~/.local/share/hestia/app/scripts/install.sh --skip-build`）。

已經安裝過時，腳本會先列出目前的狀況（和 `--status` 相同），只問一題「保持現在的設定，只更新程式並重新啟動？」。按 Enter 就沿用全部設定與密碼、重新建置並重啟服務，原本的 Tailscale 網址也照舊；tmux 裡的對話不受影響。不想被問就加 `--yes`。

選 n 才逐項修改。密碼有三個選擇：Enter 沿用、`v` 驗證你記得的密碼是否正確（不正確時會問要不要重新設定）、`r` 重新設定。腳本不要求先輸入舊密碼：能在這台機器執行它的人本來就能直接改 `api/.env`，這道關卡擋不住誰，這個密碼防的是遠端登入。

## 移除

一行安裝的：

```bash
~/.local/share/hestia/app/scripts/install.sh --uninstall           # 停止並移除服務與 hestia 指令，保留設定與狀態
~/.local/share/hestia/app/scripts/install.sh --uninstall --purge   # 連設定（.env）與狀態資料夾一起刪除
rm -rf ~/.local/share/hestia                                       # 最後刪掉程式與自己下載的 Node.js
```

從原始碼安裝的，在 repo 裡執行 `api/scripts/install.sh --uninstall`（或加 `--purge`），再自行刪掉 repo。

`--uninstall` 不會刪掉正在執行的自己，最後會印出刪除程式資料夾的指令（`--purge` 之後裡面已經沒有 `.env`）。安裝腳本在系統 Node.js 不夠新時自己下載的那份在 `~/.local/share/hestia/node/`（設了 `HESTIA_HOME` 時在它底下的 `node/`），`--uninstall` 不會動它：上面最後一行會連它一起刪；從原始碼安裝的，不需要時自行 `rm -rf ~/.local/share/hestia/node`。

`--purge` 只刪確定是 Hestia 的狀態資料夾：安裝時會在裡面放一個 `.hestia-state` 標記檔，刪除前會檢查這個標記。沒有標記、是 `/`、家目錄、包含家目錄的資料夾，或家目錄底下第一層的資料夾（例如 `~/work`、`~/.config`）時，一律拒絕並說明原因，什麼都不刪；需要的話請自行刪除。

`--state-dir` 指到一個已經有其他檔案的資料夾時，安裝程式不會改它的權限（只會警告，建議改用專用的空資料夾），並在裡面放 `.hestia-shared`，之後 `--purge` 也不會刪它。

macOS 上 `--uninstall` 會卸載並刪掉 LaunchAgent，`~/Library/Logs/Hestia/` 的紀錄保留。

移除時會關掉轉到這個後端的 `tailscale serve`；Tailscale 本身保留（它可能還在服務別的東西）。Linux 上要連自己裝的 Tailscale 一起移除：`systemctl --user disable --now tailscaled.service`，再刪掉 `~/.local/bin/tailscale*`、`~/.config/systemd/user/tailscaled.service` 與 `~/.local/share/tailscale/`，並在 Tailscale 管理後台移除這台機器。tmux 工作階段不會被關閉。
