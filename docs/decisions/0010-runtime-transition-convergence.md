# ADR 0010：CLI 啟動轉換收斂為單一確認規則

- 狀態：已實作
- 更新：2026-09-24
- 英文版：[0010-runtime-transition-convergence.en.md](0010-runtime-transition-convergence.en.md)

2026-09-24 使用者同意依「第一階段 → 第二階段 → 第三階段先寫 ADR 再實作」完成 runtime 收斂。前置：各 CLI 的 clear 流程已先統一。第一、二階段已把啟動指令組裝（`runtimes/launch.ts`）與 CLI 生命週期、session identity（`RuntimeDriver`）收進 runtime driver；本 ADR 處理剩下的「啟動之後怎麼確認」。

## 背景

同一個 tmux 會經過四種「送出一條 CLI 啟動指令，再確認它起來了」的轉換：

| 轉換 | 保存欄位 | 送出者 | 確認者（改動前） | `dead` 的判定（改動前） |
|---|---|---|---|---|
| 新啟動 | `launchPending` | `POST /launch` route | route 內 `waitForPaneStable` 後看一次；poller 也會看 | route：畫面穩定後看到一次就 rollback；poller：**看到一次就 rollback，沒有寬限期、沒有 local owner 保護** |
| app `/clear` 重啟 | `clearPending`（`operation: 'clear'`） | poller | poller | 送出後 30 秒寬限期 + 連續 2 次輪詢 dead |
| 切換到先前的 Claude 對話 | `clearPending`（`operation: 'conversation_switch'`） | poller | poller | 同 `/clear` |
| 已結束 tmux 的 Claude 恢復 | `resumePending` | `POST /recover-claude` route | route 內看一次；poller 也會看 | route：畫面穩定後看到一次就 rollback；poller：30 秒寬限期 + 穩定期 |

問題：

1. **新啟動有實際競態**（已用測試證實）。route 先持久化 `launchPending` 才送指令；poller 每 800 ms 掃描，若恰好在「寫入 pending」到「shell 真的 fork 出 CLI」之間（約 100–200 ms，含 `sendText` 送 Enter 前的 100 ms 間隔）看到 pane 仍是 shell，就立刻 rollback 成 idle 並顯示「所選啟動方式已結束」。CLI 隨後照常啟動，但 registry 已不認得它，形成孤兒 CLI；route 之後 commit 也因 pending 已被清掉而失敗。
2. 同樣「CLI 還沒起來 vs. 已經退出」的判斷有三套規則；route 內的單次判斷與 poller 的判斷可能同時進行且結論不同。
3. `/clear` 與切換使用的通用函式/型別仍叫 `*ClaudeClear*`，local owner 集合也以 Claude 命名，與 runtime 中立的設計不符。

## 決策

1. **單一啟動確認規則。** 新增 `sync/startup.ts`，所有轉換在送出啟動指令後都用同一個判斷：
   - `alive` → 確認成功（commit）。
   - `unknown` → 繼續等，不改狀態。
   - `dead` → 只有在「送出後已過 `RUNTIME_STARTUP_GRACE_MS`（30 秒）」**且**「連續觀察到 dead 達 `RUNTIME_DEAD_STABILITY_MS`（兩個輪詢間隔）」才判定失敗；否則繼續等。
   常數沿用原本 `/clear`、resume 已驗證的值，只改成 runtime 中立名稱。
2. **Route 只負責 claim 與 dispatch，確認一律交給 poller。** `POST /launch` 與 `POST /recover-claude` 在持久化 claim、送出一次指令後回 `202` 與目前（`launching`）狀態，不再在 request 內 `waitForPaneStable` 或下 liveness 結論。指令送出失敗時保留 claim、標示不確定、絕不重送（與 `/clear` 相同）。前端既有的「啟動結果確認中」狀態與 SSE 更新負責後續畫面。
3. **所有轉換共用 process-local dispatch ownership。** 從 claim 寫入到指令送出完成為止，發起的 request 持有該 attempt；poller 不判斷被本行程持有中的 attempt。服務重啟後 ownership 自然消失，poller 依持久化狀態接手。
4. **保存欄位維持三個，不合併成單一 union。** `launchPending`、`resumePending`、`clearPending` 的前置條件、commit 內容（新 segment / 重開舊 segment / 同一 segment 恢復）與 rollback 語意不同，也各自被既有 migration 與 public projection 使用。收斂的是「確認規則」與「owner 機制」，不是儲存格式。`launchPending.providerLaunchedAt` 在送出指令前一刻設定，直接作為寬限期起點，不新增欄位、不需 migration。
5. **通用 clear/switch 函式與型別改為中立命名**（例如 `beginPendingClear`、`PendingClearAttempt`）。Claude 恢復（`recover-claude`、`resumePending`）依規格仍只支援 Claude，保留 Claude 命名以如實描述能力。

## 替代方案

- **只替 poller 的 launch 迴圈加 owner 保護，route 維持同步確認**：拒絕。能擋住目前競態，但仍有兩個判斷者、兩套規則；route 內「畫面穩定後看一次 dead 就 rollback」對開機慢的 CLI 同樣會誤判。
- **縮短寬限期（例如 3 秒）讓失敗更快顯示**：暫不採用。30 秒是 `/clear`、resume 已驗證並上線的值；縮短會重新引入「慢啟動被判失敗 → 使用者重試 → 雙 CLI」的風險。若之後要調整，只需改 `sync/startup.ts` 一處。
- **把三個 pending 欄位合併成單一 `transition` union**：拒絕。需要 registry migration 與 public DTO 變動，換來的只是形式統一；真正不一致的是確認規則，已由決策 1–3 解決。

## 後果

- 正常啟動速度不變（poller 下一次輪詢即 commit，≤ 800 ms）；**啟動失敗（例如執行檔不存在）要約 30 秒才顯示錯誤**，換取不會誤判慢啟動。
- `POST /launch` 成功時由 `200 + ready session` 變為 `202 + launching session`；`POST /recover-claude` 同樣改為 `202`。前端已處理 `starting` 狀態，不需改動 UI。
- 原本 route 回報的「CLI did not settle before timeout」提示移除（它只是畫面穩定的猜測，不是狀態）。
- 測試需涵蓋：剛送出的啟動在寬限期內看到 dead 不 rollback；寬限期後需穩定 dead 才 rollback；持有中的 attempt 不被 poller 判斷；route 不再同步確認。
