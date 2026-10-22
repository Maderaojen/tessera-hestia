# 人工介入：實測結果

- 更新：2026-10-09
- 英文版：[human-in-the-loop.en.md](human-in-the-loop.en.md)

以下結果全部來自對 Claude Code v2.1.276 的實際測試：啟動方式和 `claudeAdapter.buildLaunch` 相同（`claude
--工作階段-id <uuid>`），在 pane 真的卡住時讀取實際的 `~/.claude/projects/**/<uuid>.jsonl`
transcript。沒有任何一項是從文件推測的。Codex／Gemini **沒有**測過：在有人對它們做同樣的測試之前，它們的「完成」與「等待互動」能力都回報 `unknown`。輪詢這時只用獨立的「檔案靜止」退路判斷，不會宣稱這些能力已經確認。

## 類型 1：CLI 的本機 UI 面板（`/status`，以及應該其他會開本機畫面的 slash command）

把 `/status` 當成聊天訊息送出，會開一個互動式的本機面板（Settings／Status／Config／Usage／Stats 分頁，「Esc to cancel」）。結果：

- **面板開著的時候，transcript 什麼都不寫。** 它的第一筆紀錄（`type: "system"`、`subtype: "local_command"`，內容包在 `<command-name>`／`<local-command-stdout>` 標籤裡）要等面板關掉**之後**才出現。
- 因為它是 `type: "system"`（不是 `"user"`／`"assistant"`），`parseTurns` 本來就會正確忽略它，不可能被誤認成真正的回覆。
- **後果**：這種情況**發生當下**，檔案裡沒有任何結構化的訊號可以偵測，只有「沒有東西」（安靜）。這正是 `polling.ts` 卡住提示的用途：transcript 超過 `STUCK_HINT_MS`（30 秒）沒有變化（從最後一次變化、送出或控制鍵，取最晚的開始算）時給一個軟性、未確認的提示；pane 顯示 Claude 忙碌時先不提示；transcript 一有變化就立刻清掉。它永遠不會變成硬性的狀態改變。
- 方向鍵和 Enter 用不加 `-l` 的 `tmux send-keys -t <target> Right` 就能正確切換面板的分頁。`Escape` 能正確關掉面板，pane 回到一般的 `❯` 提示。

## 類型 2：工具權限提示（Write、Bash 等需要核准的工具）

用 `--permission-mode manual`，再要求 Claude 使用 `Write` 工具來重現。結果：

- 等待中的工具呼叫**有**寫進 transcript，是一則帶有 `tool_use` 內容區塊（`{type, id, name, input}`）的 `assistant` 訊息。但只有一般生成的延遲（使用者訊息之後約 2～3 秒），**不是**等核准才寫。之前有一次讀得太早，誤判成「什麼都沒寫」；下結論說還沒有 tool_use 之前，一定要多等幾秒。
- **等待中的狀態正好是**：一個 `tool_use` 區塊，它的 `id` 還沒有對應的 `user` 訊息 `tool_result` 區塊（`{type:"tool_result",
  tool_use_id, content, is_error?}`）。`claudeAdapter.findPendingInteraction` 找的就是這個。
- **核准和拒絕最後都會寫一個對應的 `tool_result`**：核准是一般內容字串；拒絕是 `is_error: true` 加上拒絕文字（「The user doesn't want to proceed with this tool use...」）。所以只要有人回應，偵測就會自己清掉，不需要分核准／拒絕兩條路。
- 只針對 Write 核准對話框（「1. Yes」、「2. Yes and auto-approve edits」、「3. No」）觀察到的選單操作：第一個選項預設反白，單按 `Enter` 選反白的那一個；直接打一個數字（`3`，一般文字）會跳到並選取那個編號，不用再按 `Enter`。不保證每一種權限提示（Bash、MCP 工具等）都是同樣的樣子，實際只測過這一種。
- 只在 `--permission-mode manual` 下測過。這個帳號自己的預設模式（`auto`）在先前的端對端測試裡，同樣的 Write 操作**完全沒有提示**。也就是說，照這個帳號的設定平常使用時，這種情況可能很少見，但不是不會發生（其他帳號、更嚴格的設定，或某些一定要核准的動作還是會遇到）。

## 類型 3：信任資料夾對話框

**這台機器上重現不了**：在全新、從沒開過的資料夾啟動，會直接進入一般的聊天畫面，沒有信任提示。可能是這個帳號／機器的設定已經廣泛信任。沒有驗證它會不會以 `tool_use` 形式的紀錄出現（應該不會，它是對話開始之前的關卡），也沒有驗證 `findPendingInteraction`／卡住提示遇到它會怎樣。實際遇到的話，就算沒有專門的偵測，一般的恢復方式仍然有效（`POST /sessions/:id/respond` 送原始按鍵，或在終端機手動處理後用 `/resume`）。

## 類型 4：MCP 需要授權

相關時，`/status` 會顯示「MCP servers: N connected, M need auth」。完全沒有測過。應該需要另外走 OAuth／瀏覽器流程，送按鍵解決不了。目前不在範圍內；遇到的話，老實的做法是「這是網址，請自己去授權」，而不是轉送按鍵。

## 根據這些結果做了什麼

- `tmux.sendKey(target, key)`：只允許白名單控制鍵（`Enter`／`Escape`／`Up`／`Down`／`Left`／`Right`／`Tab`）的基本操作，已對上面的類型 1、2 驗證過。
- `ProviderAdapter` 的「完成」與「等待互動」檢查會明確回傳 `supported`／`unsupported`／`unknown`。Claude 驗證過的 transcript 檢查回報 `supported`；Codex／Gemini 目前回報 `unknown`，仍未驗證。不會因為某個 provider 的行為未知，就讓它回傳 `true`／`null`。
- `SessionStatus` 新增 `'needs_interaction'`：`findPendingInteraction` 找到東西，**而且** pane 確認畫面上真的有提示時立刻設定（見下面的「讀取 pane」：沒有結果的 `tool_use` 也可能是已核准、還在執行的工具）。它在 `polling.ts` 的穩定／收尾邏輯**之前**檢查，因為這是明確的訊號，不用等檔案安靜下來。
- `POST /sessions/:id/respond`：**只單純轉送按鍵或文字，別的都不做。** 先前它每次呼叫都把 `status` 強制改回 `'waiting'` 並清掉 `pendingInteraction`，這是錯的：例如送 `Right` 在開著的選單裡移動，什麼都沒有解決，強制清掉卻讓互動卡片按一次鍵就消失，使用者沒辦法繼續操作。軟性的卡住提示橫幅也犯過一樣的錯：先前的修正還是每次 respond 都清 `lastError`，讓**那個**橫幅（和它的按鈕）也是按一次鍵就消失，同一個 bug、不同欄位。現在它只重設卡住提示在記憶體裡的安靜計時（`noteControlKey`：任何真的活動，不管結果如何，都是「沒卡住」的證據），完全不動 `status`／`pendingInteraction`／`lastError`／`lastUserMessageAt`。它以前會更新 `lastUserMessageAt`，結果使用者前一刻直接在 tmux 打的訊息看起來比最後一次送出還舊，永遠不會被當成新的。CLI 執行中隨時都能呼叫（不限於 `'waiting'`／`'needs_interaction'`；送 Esc 中斷一般回覆也是正當用法）。
- `polling.ts` 現在會繼續輪詢 `'needs_interaction'` 的工作階段，不只 `'waiting'`：只有它會判定互動真的解決了（`findPendingInteraction` 找不到了）；在支援這項能力的 provider 上，它每一輪都重新檢查 transcript。對未知或不支援的 provider，輪次追蹤保留另外的「檔案靜止」推測，但不宣稱有結構化的互動偵測。只有等待中的互動真的改變時才發布更新（連續兩次同一個 `toolUseId` 不做事），所以用方向鍵移動時，不會每次輪詢都送出一張一樣的卡片。
- `POST /sessions/:id/resume`：給使用者直接在終端機、完全在這個 API 之外手動解決問題時用。這種情況無法自動偵測（見類型 1），所以這是刻意、明確的解鎖：直接改成 `'ready'`，不是 `'waiting'`，因為剛才並沒有送出任何東西要輪詢去看。

## 讀取 pane（Claude Code 2.1.281，之後加上）

後來發現只看 transcript 有三個地方分辨不出來，所以加上幾種 pane（`tmux capture-pane`）的判讀。它們一律只用來**修正** transcript 的訊號，不會自己產生訊號。每一種都對照過真正擷取的 pane，樣本在 `api/test/providers/claude.test.ts`。

- **畫面上有權限提示**（`paneShowsPermissionPrompt`）：「Do you want to …?」底下是以「❯ 1. Yes」開頭的編號選項。需要它是因為已核准（或 auto 模式）的工具在執行時，也是「有 `tool_use`、沒有 `tool_result`」。讀不到 pane 時沿用 transcript 的判斷，所以真正的提示絕不會被藏起來。
- **忙碌**（`paneShowsBusy`）：Claude 在生成、思考或執行工具時，頁尾會顯示「esc to interrupt」。
- **閒置**（`paneShowsIdle`）：不忙碌、沒有提示，而且畫面上有輸入框（兩條整寬「───」之間的一行「❯」）。auto 模式閒置時的頁尾沒有「? for shortcuts」，所以不能用頁尾判斷。`/status` 面板既不算忙碌也不算閒置。

這些判讀決定終端機按鈕的活動狀態，並提供一個安全網：transcript 一直沒回報完成的 'waiting' 輪次，在 pane 閒置超過 `PANE_IDLE_FINALIZE_MS` 後匯入。

## Transcript 接續（Claude Code 2.1.281）

Claude Code 有時不重啟程序，就把進行中的對話接到一個新的 transcript 檔（在閒置時、`/status` 之後、取消 `/resume` 之後都看過）。這時舊檔最後一行是
`{"type":"continued-in","sessionId":<old>,"continuedInSessionId":<new>}`，
同一個資料夾的 `<new>.jsonl` 有完整的歷史副本（保留原本的時間戳記），後面接著之後的所有內容。只讀固定的那個檔案，聊天畫面會默默停住。輪詢現在會跟著這個明確的指標（`claudeAdapter.followContinuation`），把同一段對話和工作階段 id 重新綁到新檔；因為歷史是帶著原本的時間戳記重複一次，只會匯入更新的輪次。

## 等待中的提示不再寫到磁碟（Claude Code 2.1.284，2026-09-29）

在隔離的 tmux server（`tmux -L`，cwd 在 `/tmp`）重新測試，另外在一個正式環境的工作階段上觀察到一次。**這推翻了類型 2 的前提。**

- **權限提示或 AskUserQuestion 在等待時，transcript 裡沒有它的 `tool_use`**，同一則訊息裡在它之前的 assistant 文字也沒有。兩者都要等使用者回應後，才和 `tool_result` 一起寫入；`tool_use` 保留原本的時間戳記（例如 05:28:39 生成，05:29:39 回答時才寫入）。在 `--permission-mode default` 下測過 Write，也測過 AskUserQuestion，都等了 20～60 秒。所以 `findPendingInteraction` 永遠看不到這些提示：工作階段一直是 `replying`、`pendingInteraction: null`，也不會出現卡片。`paneShowsPermissionPrompt` 只用來修正 transcript 的訊號，所以也抓不到。
- **App 的輸入框在提示出現時送出會怎樣**（`/messages`：送出文字，再按 Enter）：在權限提示上，文字被忽略，Enter 選了反白的「1. Yes」，送出「請等一下」結果**核准了**寫入。在 AskUserQuestion 上，只有游標已經停在自由輸入那一列時，文字才會打進去；否則 Enter 選的是反白的選項。

### 畫面上的 AskUserQuestion

- 多個問題：一列分頁 `←  ☐ 水果  ☐ 顏色  ☐ 動物  ✔ Submit  →`（回答過變成 `☒`），頁尾 `Enter to select · Tab/Arrow keys to navigate
  · Esc to cancel`。只有一個問題：只有 `☐ <header>`，頁尾 `↑/↓ to
  navigate`，按 Enter 直接送出。
- 選項有編號，每個選項下面一行說明，接著是分隔線上方的 `N. Type
  something.` 和分隔線下方的 `N+1. Chat about this`（沒試過）。
- 直接打數字會選那個選項並跳到下一個問題。
- 在 `Type something.` 上，文字（包括中文，用 `send-keys -l`）會填進那一列，數字也當成文字（`2隻兔子` 維持是文字）。Enter 接受並跳到下一題。在其他列上，文字會被忽略。
- 最後一個問題之後是確認分頁：列出每個答案，接著是 `1. Submit
  answers`／`2. Cancel`。
- 回答後：`tool_result` 內容是 `The user answered: "<question>"="<answer>",
  …`，自由輸入的內容原樣保留。
- Esc：`tool_result` 是「The user doesn't want to proceed with this tool use…」，後面接一個 `[Request interrupted by user for tool use]` 文字區塊。

### 權限提示：用 Tab 補充說明

- 頁尾顯示 `Esc to cancel · Tab to amend`。在選項上按 Tab 會讓它變成可編輯：`1. Yes, and tell Claude what to do next`，打字後變成 `1. Yes, <text>`；在 `3. No` 上則是 `3. No, <text>`。按 Enter 確認。
- Yes 加文字：一般的 `tool_result`，同一則使用者訊息裡另外有一個 `text` 區塊放使用者的話。
- No 加文字：拒絕的 `tool_result` 內容是「…To tell you how to proceed,
  the user said:\n<text>…」。

### 根據這些結果做了什麼（2026-09-29）

- **從 pane 讀提示。** `providers/claude-interaction.ts`（`readPaneInteraction`）讀取 pane **最後面**的提示（權限、問題，或多個答案的確認頁），轉成 `InteractionScreen`（選項和編號、說明、自由輸入列、勾選框、可補充說明的列、步驟）。擷取樣本在 `api/test/fixtures/interaction-prompts`。pane 很窄時，游標移到自由輸入列後，問題下方的按鍵提示會折成兩行（「… ctrl+g to edit in」／「Vim · Esc to cancel」）。
- **自己偵測。** 輪詢（`polling.ts` 的 `findPending`）不再需要 transcript 裡的 `tool_use`：pane 上出現提示，就成為 `pendingInteraction`（這一輪的階段是 `awaiting_approval`），附上 `screen`，`toolUseId` 是 `pane:<提示內容的雜湊>`，所以跳到下一題或勾選一個框時，都會重新發布。
- **從 App 回答。** `POST /工作階段/:id/interaction { promptId,
  option, text? }`（`sync/interaction.ts`）：畫面上的提示已經不是要回答的那一個時拒絕；用 Up／Down 移動游標，每按一次都重新讀取；自由輸入（以一行送出）和權限的補充說明（按 Tab 之後）會先打字、讀回確認，才按 Enter。多選的自由輸入列不按 Enter（按了會取消勾選）。任何無法驗證的步驟都不確認（`interaction_unconfirmed`）。
- **擋下打字輸入。** 有提示在等待時（已記錄，或送出前剛好在 pane 上看到），`POST /messages` 和 `/clear` 回 409 `interaction_pending`，不會把文字加 Enter 打進提示裡。在 App 裡，輸入框的文字會變成自由輸入的答案，或權限 Yes／No 附帶的說明。
- 還沒做：「Chat about this」；Agy 的提示。
- **Codex 的指令核准（2026-10-09，Codex CLI 0.161.0）。** `providers/codex-interaction.ts` 讀取 pane 最後的「Would you like to run the following command?」：說明（Environment、Reason、`$ 指令`）和三個選項（Yes, proceed／Yes, and don't ask again…／No, and tell Codex…），`›` 是游標。隔離 tmux 實測：Up／Down 移動游標（最後一列按 Down 會繞回第一列），Enter 選游標所在的列；選 1 會執行指令，選 3 會拒絕並結束這一輪。選項後面的 `(y)`／`(p)`／`(esc)` 是快捷鍵，不屬於選項文字。等待核准時 rollout 不會寫入任何東西，所以只能從畫面讀。樣本：`api/test/fixtures/interaction-prompts/codex.*.0.161.0.txt`。其他種類的 Codex 提示（修改檔案、網路）未測。
