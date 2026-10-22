# Product terminology

- Status: Accepted
- Updated: 2026-10-19
- 中文：[產品名詞](terminology.md)

## Definitions

| Traditional Chinese | English | Definition |
|---|---|---|
| 專案 | Project | Groups working paths, notes, and sessions. |
| 工作階段 | Session | One tmux session managed by Hestia, containing multiple conversations. Its name and history can remain after it ends. |
| 對話 | Conversation | One independent AI CLI conversation within a session, with its own messages, history, and recap. |
| 收件匣 | Inbox | Where notes not filed under any project go. Always there; can't be renamed or deleted. The app names it in the interface language; the name isn't stored. |

Hierarchy: **Project → Session → Conversation**. A session can retain multiple conversations but runs only one CLI at a time. A CLI's native session ID identifies a conversation, not a Hestia session.

## Interface labels

| Traditional Chinese | English | Scope and result |
|---|---|---|
| 新增工作階段 | New session | Creates another tmux session; choose a CLI and account to start a conversation. |
| 在此專案新增工作階段 | New session in this project | Creates a session at a selected working path in an existing project. |
| 新增專案與工作階段 | New project and session | Creates a project and its first session. |
| 建立新對話 | New conversation | Ends the current CLI and starts a fresh conversation in the current session, keeping older conversations. |
| 切換對話 | Switch conversation | Selects a conversation to view; use Continue conversation to run it again. |
| 繼續對話 | Continue conversation | Resumes a saved conversation, restarting the CLI and rebuilding tmux when supported and needed. |
| 結束工作階段 | End session | Stops the CLI and tmux while keeping the session in the list for viewing. |
| 重新命名工作階段 | Rename session | Changes the session's display name, not a CLI conversation's name. |
| 刪除工作階段 | Delete session | Ends tmux and removes the list item, including all its conversations. It can be restored when trash is supported. |
| 還原工作階段 | Restore session | Returns a session from trash to the list without starting the CLI. |
| 永久刪除工作階段 | Permanently delete session | Removes a session from trash without restoration; conversation archive files on the host are unaffected. |
| 查看摘要 | View recap | Shows recaps of the session's conversations. |
| 分工 | Division of work | Handoff, delegation, and branch lines together: who works on this. Started from the composer's "Who works on it", taking the composer's text as the task. |
| 交接 | Handoff | Another LLM takes over the same work: the current CLI stops, and another account or CLI carries on in the same session. |
| 指派 | Delegate | Hands out a piece of work: done in a new session and worktree, delivered back, and accepted by you. |
| 支線 | Branch line | Opens a separate line with the current memory: runs at the same time in a new session and worktree, without reporting back. |
| 封存 | Archive | Ends a branch line's or delegate's session and removes its worktree (its branch only if merged), keeping only its record; hidden in the list unless shown, and never run again. Replaces the old 收掉 and the delegation's 清理. |
| 相關工作 | Related work | The delegations, branch lines, and handoffs of this session; what is going on is summed up in one line above the composer, and all of it opens in a tabbed panel from the title menu's "Related work…". |
| 額度不夠時 | When usage runs low or out | What this session does when its usage runs low or out (nothing, carry on after the reset, or hand over to another account). |
| 段 | Part | One conversation within a session (part N). The parts run on as one timeline in the chat, with a divider between them saying whether memory carried over: a part a handoff started only read the brief; any other new part carries nothing over. |

## Wording (2026-10-13)

Taiwan usage, written but plain; one wording per meaning. In Chinese: 封存 (not 收掉, or 清理 for delegations; the git panel's worktree 清理 stays), 恢復 (not 接回), 收合／展開 (not 收起、收折), 開啟 (not 打開), 無法 (not 沒辦法), 已達額度上限 (not 撞到額度上限), 自行繼續 for the CLI carrying on by itself vs 自動繼續 scheduled by the app, 停止等待 (not 不等了), 查看… (not 看…), 讀取／修改／執行 in a turn's tool summary with 個檔案, 產生 (not 生成), 繪製 for charts (not 渲染), 連接埠 (not 埠、連線埠), 模型 (not model) and 啟動方式 (not profile) for settings, subagent kept as is (not 子代理), a spaced · as the inline separator (not ・), and since 2026-10-19 主機設定／沿用主機設定 for settings kept on the host and shared by every device connected to it (not 全域／跟隨全域), 便箋 (not 便簽), and 自動整理 for automatic note sorting (not 自動模式).

Interface text lives in the locale files under `web/src/i18n/locales/`; code names only the key (for example `t('settings.locale.hint')`). To revise existing copy, change that key's value in `zh-TW/` and the English in the file of the same name in `en-US/`, together; the code stays as it is. The backend's text for people (notifications, status, the `hestia` command's output) is in the files of the same name under `api/src/i18n/locales/`, both languages changed together; the briefs, prompts and records written for LLMs are in `api/src/i18n/prompts/`, Chinese only, and these terms don't apply to them (changing them changes what the LLMs are told).

## Language and scope

- Traditional Chinese is the default. Chinese interfaces use 專案／工作階段／對話; Project／Session／Conversation appear when English is selected.
- Entry points, shortcut help, the command palette, forms, accessible labels, notifications, errors, states, trash, and usage analytics follow these definitions.
- Session shortcuts act on the currently open session, regardless of pointer position, list filtering, collapse state, or focus on another row.
- Searching sessions finds sessions; searching conversations finds conversation text. Recaps and CLI conversation counts refer to Conversations.
- General product copy uses Session. Brands, native tmux commands, code/API identifiers, raw errors, CLI output, paths, user names, and user content retain their original text. Technical diagnostics may name tmux when describing tmux itself.
- Existing identifiers such as `ManagedSession`, `Conversation`, `tmuxName`, URLs, fields, and storage keys are unchanged by localization.
- Historical requests, decisions, and observations retain their original wording. Current product documents and new interface copy follow this document.
