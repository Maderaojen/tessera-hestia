# Human-in-the-loop: what we found, empirically

- Updated: 2026-10-09
- 中文: [human-in-the-loop.md](human-in-the-loop.md)

All findings below are from hands-on tests against Claude Code v2.1.276,
launched the same way `claudeAdapter.buildLaunch` does (`claude
--session-id <uuid>`), reading the real `~/.claude/projects/**/<uuid>.jsonl`
transcript while a pane was actually stuck. Nothing here is guessed from
documentation. Codex/Gemini were **not** tested — their completion and
pending-interaction capabilities report `unknown` until someone does this
same exercise against them. The poller then uses only the independent
file-quiescence fallback; it does not claim those capabilities were
positively confirmed.

## Category 1 — local CLI UI panels (`/status`, and presumably other slash
commands that open a local screen)

Sending `/status` as a chat message opens an interactive local panel
(Settings / Status / Config / Usage / Stats tabs, "Esc to cancel"). Findings:

- **Nothing is written to the transcript while the panel is open.** The
  first record for it (`type: "system"`, `subtype: "local_command"`,
  content wrapped in `<command-name>`/`<local-command-stdout>` tags) only
  appears *after* the panel is dismissed.
- Because it's `type: "system"` (not `"user"`/`"assistant"`), `parseTurns`
  already ignores it correctly — it can never be mistaken for a real reply.
- **Consequence**: there is no structured signal in the file to detect this
  case *while* it's happening — only its absence (silence). This is exactly
  what the stuck hint in `polling.ts` is for: a soft, unconfirmed hint after
  `STUCK_HINT_MS` (30s) with no transcript change (measured from the last
  change, the send, or a control key, whichever is latest), held back while
  the pane shows Claude busy, cleared the moment the transcript moves again.
  Never a hard status change.
- Arrow keys and Enter navigate the panel's tab bar correctly via bare
  `tmux send-keys -t <target> Right` (no `-l`). `Escape` correctly dismisses
  it, returning the pane to a normal `❯` prompt.

## Category 2 — tool permission prompts (Write/Bash/etc. needing approval)

Reproduced with `--permission-mode manual` and a prompt asking Claude to use
the `Write` tool. Findings:

- The pending tool call **is** written to the transcript, as an `assistant`
  message with a `tool_use` content block (`{type, id, name, input}`) —
  but only after ordinary generation latency (~2-3s after the user's
  message), *not* delayed by the approval wait itself. An earlier read that
  checked too early can misread this as "nothing was written" — always
  allow a few seconds before concluding there's no tool_use yet.
- **The pending state is exactly**: a `tool_use` block whose `id` has no
  matching `user`-message `tool_result` block (`{type:"tool_result",
  tool_use_id, content, is_error?}`) yet. This is what
  `claudeAdapter.findPendingInteraction` scans for.
- **Both approval and denial eventually write a matching `tool_result`** —
  approval: plain content string; denial: `is_error: true` with rejection
  text ("The user doesn't want to proceed with this tool use..."). So the
  detector clears itself either way once a human responds; no separate
  approve/deny branches needed.
- Menu mechanics observed for the Write-approval dialog specifically ("1.
  Yes", "2. Yes and auto-approve edits", "3. No"): the first option is
  pre-highlighted, bare `Enter` selects whatever's highlighted, and typing a
  bare digit (`3`) — ordinary literal text — jumps straight to and selects
  that numbered option, no extra `Enter` needed. Not guaranteed to be the
  same shape for every permission-prompt variant (Bash, MCP tools, etc.) —
  only this one was actually tested.
- Tested only under `--permission-mode manual`. This account's own default
  (`auto`) mode ran the same Write op with **no prompt at all** in earlier
  end-to-end testing — meaning in normal usage under this account's config,
  this category may be rare, but it's not eliminated (other accounts,
  stricter configs, or specific always-gated actions could still hit it).

## Category 3 — trust-folder dialog

**Not reproducible on this machine** — launching in a brand-new, never-seen
directory went straight to the normal chat UI, no trust prompt. Likely this
account/machine already trusts broadly by config. Un-verified whether it
would show up as a `tool_use`-shaped record (probably not — it's a
pre-conversation gate) or how `findPendingInteraction`/the stuck-hint would
behave against it. If it's ever hit in practice, the generic recovery path
(`POST /sessions/:id/respond` with a raw key, or `/resume` after fixing it
by hand in the terminal) still applies even without dedicated detection.

## Category 4 — MCP auth needed

`/status` surfaces "MCP servers: N connected, M need auth" when relevant.
Not tested at all — likely requires an out-of-band OAuth/browser flow that
no key-send can resolve. Out of scope for now; if hit, the honest UX is
"here's a URL, go authorize it yourself," not a key-relay loop.

## What got built from this

- `tmux.sendKey(target, key)` — a whitelisted control-key primitive
  (`Enter`/`Escape`/`Up`/`Down`/`Left`/`Right`/`Tab`), verified against
  categories 1 and 2 above.
- `ProviderAdapter` completion and pending-interaction checks return an
  explicit `supported` / `unsupported` / `unknown` result. Claude's verified
  transcript checks report `supported`; Codex/Gemini currently report
  `unknown` and remain unverified. No provider is represented as returning
  `true`/`null` merely because its behavior is unknown.
- `SessionStatus` gained `'needs_interaction'`, set the moment
  `findPendingInteraction` finds something *and* the pane confirms a prompt
  is actually on screen (see "Pane readings" below: an unresolved `tool_use`
  also describes an approved tool that is still running) — checked *before* the
  stability/turn-finalization logic in `polling.ts`, since it's a definite
  signal and doesn't need to wait for the file to go quiet.
- `POST /sessions/:id/respond` — **a pure keystroke/text forward, nothing
  more.** Earlier it forced `status` back to `'waiting'` and cleared
  `pendingInteraction` on every call — wrong, since sending e.g. `Right` to
  move within an open menu doesn't resolve anything, and that forced clear
  made the interaction card vanish after one keypress instead of letting the
  user keep navigating. Same mistake existed a second time for the soft
  stuck-hint banner: an earlier fix still cleared `lastError` on every
  respond call, which made *that* banner (and its buttons) vanish after one
  keypress too — same bug, different field. It now only restarts the stuck
  hint's in-memory quiet clock (`noteControlKey` — real activity, whatever
  it turns out to be, is still evidence against "stuck") and leaves
  `status`/`pendingInteraction`/`lastError`/`lastUserMessageAt` alone
  entirely. It used to bump `lastUserMessageAt`, which made a message typed
  straight into tmux a moment earlier look older than the last send, so it
  was never picked up as new. Callable
  any time the CLI is running (not gated to `'waiting'`/`'needs_interaction'`
  — sending Esc to interrupt an ordinary reply is legitimate too).
- `polling.ts` now keeps polling `'needs_interaction'` sessions, not just
  `'waiting'` — it's the only thing that ever decides an interaction is
  actually resolved (`findPendingInteraction` stops finding it), by
  re-checking the transcript every tick where that capability is supported.
  For unknown/unsupported providers, turn tracking retains the separate
  file-quiescence heuristic but does not assert structured interaction
  detection. Only publishes an update when the
  pending interaction actually changes (same `toolUseId` twice in a row is a
  no-op), so arrow-key navigation doesn't spam an identical card every poll.
- `POST /sessions/:id/resume` — for when the user resolved something by
  hand directly in the terminal, outside this API entirely. Can't be
  auto-detected (see Category 1), so this is a deliberate, explicit
  unlock — straight to `'ready'`, not `'waiting'`, since nothing was just
  sent for polling to watch.

## Pane readings (Claude Code 2.1.281, added later)

The transcript alone turned out to be ambiguous in three places, so a few
readings of the pane (`tmux capture-pane`) were added — always to qualify a
transcript signal, never to raise one on their own. Each was checked
against a real captured pane; the samples live in
`api/test/providers/claude.test.ts`.

- **Permission prompt on screen** (`paneShowsPermissionPrompt`): "Do you
  want to …?" above numbered options starting "❯ 1. Yes". Needed because a
  `tool_use` with no `tool_result` is also what an approved (or auto-mode)
  tool looks like while it runs. If the pane can't be read, the transcript's
  answer stands, so a real prompt is never hidden.
- **Busy** (`paneShowsBusy`): the footer reads "esc to interrupt" whenever
  Claude is generating, thinking or running a tool.
- **Idle** (`paneShowsIdle`): not busy, no prompt, and the input box — a
  "❯" line between two full-width "───" rules — on screen. Auto mode's idle
  footer has no "? for shortcuts", so the footer can't be used. A `/status`
  panel is neither busy nor idle.

These drive the terminal button's activity state and one safety net: a
'waiting' turn the transcript never reports as finished is imported once
the pane has been idle for `PANE_IDLE_FINALIZE_MS`.

## Transcript continuation (Claude Code 2.1.281)

Claude Code sometimes carries a running conversation on in a new transcript
file without restarting the process (seen while idle, after `/status`, after
a cancelled `/resume`). The old file then ends with
`{"type":"continued-in","sessionId":<old>,"continuedInSessionId":<new>}`,
and `<new>.jsonl` in the same directory holds a full copy of the history
(original timestamps) followed by everything since. Reading only the pinned
file silently froze the chat. The poller now follows that explicit pointer
(`claudeAdapter.followContinuation`) and rebinds the same conversation and
session id; since the history is repeated with its original timestamps, only
newer turns are imported.


## Pending prompts are no longer on disk (Claude Code 2.1.284, 2026-09-29)

Re-tested in an isolated tmux server (`tmux -L`, `/tmp` cwd), plus one
observation on a production session. **This breaks Category 2's premise.**

- **While a permission prompt or an AskUserQuestion is waiting, the transcript
  has no `tool_use` for it** — nor the assistant text before it in the same
  message. Both are written only once the user responds, together with the
  `tool_result`; the `tool_use` keeps its original timestamp (e.g. generated
  05:28:39, written on answer at 05:29:39). Checked for Write under
  `--permission-mode default` and for AskUserQuestion, after 20–60 s of
  waiting. So `findPendingInteraction` never sees these prompts: the
  session stays `replying` with `pendingInteraction: null`, and no card shows.
  `paneShowsPermissionPrompt` only qualifies a transcript signal, so it
  doesn't catch them either.
- **What the app's composer does now at a prompt** (`/messages`: literal text,
  then Enter): at a permission prompt the letters are ignored and Enter picks
  the highlighted "1. Yes" — sending "please wait" **approved** the write. At
  an AskUserQuestion the text lands in the free-text row only if the cursor
  is already on it; otherwise Enter picks the highlighted option.

### AskUserQuestion on screen

- Several questions: a tab row `←  ☐ 水果  ☐ 顏色  ☐ 動物  ✔ Submit  →`
  (`☒` once answered), footer `Enter to select · Tab/Arrow keys to navigate
  · Esc to cancel`. One question: just `☐ <header>`, footer `↑/↓ to
  navigate`, and Enter submits straight away.
- Options are numbered, each with a description line, then `N. Type
  something.` above a rule and `N+1. Chat about this` below it (not tried).
- A bare digit selects that option and moves to the next question.
- On `Type something.`, literal text (Chinese included, via `send-keys -l`)
  fills that row, digits included (`2隻兔子` stays text). Enter accepts it
  and moves on. On any other row, letters are ignored.
- After the last question comes a review tab: every answer, then `1. Submit
  answers` / `2. Cancel`.
- Answered: `tool_result` content `The user answered: "<question>"="<answer>",
  …`, with free text given verbatim.
- Esc: `tool_result` "The user doesn't want to proceed with this tool use…",
  followed by a `[Request interrupted by user for tool use]` text block.

### Permission prompt: Tab to amend

- The footer reads `Esc to cancel · Tab to amend`. Tab on an option turns it
  editable: `1. Yes, and tell Claude what to do next` → typing gives
  `1. Yes, <text>`; on `3. No` it gives `3. No, <text>`. Enter confirms.
- Yes + text: the normal `tool_result`, plus a separate `text` block with
  the user's words in the same user message.
- No + text: the rejection `tool_result` reads "…To tell you how to proceed,
  the user said:\n<text>…".

### What got built from this (2026-09-29)

- **Read off the pane.** `providers/claude-interaction.ts`
  (`readPaneInteraction`) reads the prompt the pane *ends with* — a
  permission, a question, or the review of several answers — into an
  `InteractionScreen` (options with their numbers, descriptions, the
  free-text row, boxes, amendable rows, steps). Captures:
  `api/test/fixtures/interaction-prompts`. On a narrow pane the key hints
  under a question wrap onto a second line once the cursor is on the
  free-text row ("… ctrl+g to edit in" / "Vim · Esc to cancel").
- **Detected on its own.** The poller (`polling.ts` `findPending`) no longer
  needs a transcript `tool_use`: a prompt on the pane becomes the
  `pendingInteraction` (turn phase `awaiting_approval`), with `screen`
  attached and `toolUseId` = `pane:<hash of the prompt>`, so moving on to
  the next question, or ticking a box, republishes it.
- **Answered from the app.** `POST /sessions/:id/interaction { promptId,
  option, text? }` (`sync/interaction.ts`): refused unless the prompt on
  screen is still the one answered; the cursor is moved with Up/Down,
  re-read after every key; free text (sent as one line) and a permission's
  note (after Tab) are typed, read back, and only then confirmed with
  Enter. A multi-select free-text row gets no Enter (it would untick it).
  Anything it can't verify is left unconfirmed (`interaction_unconfirmed`).
- **Typed input held back.** While a prompt waits (recorded, or seen on the
  pane right before sending), `POST /messages` and `/clear` answer 409
  `interaction_pending` instead of typing text + Enter into it. In the app
  the composer's text becomes the free-text answer, or the note that goes
  with a permission's Yes/No.
- Not done: "Chat about this"; Agy prompts.
- **Codex command approvals (2026-10-09, Codex CLI 0.161.0).** `providers/codex-interaction.ts` reads the "Would you like to run the following command?" the pane ends with: what it is about (Environment, Reason, `$ command`) and its three rows (Yes, proceed / Yes, and don't ask again… / No, and tell Codex…), `›` being the cursor. Tested in an isolated tmux: Up/Down move the cursor (Down on the last row wraps to the first) and Enter takes the row under it; 1 ran the command, 3 declined it and ended the turn. The `(y)`/`(p)`/`(esc)` after each row are its shortcut keys, not part of what it says. Codex writes nothing to its rollout while an approval waits, so the screen is the only place to read it. Captures: `api/test/fixtures/interaction-prompts/codex.*.0.161.0.txt`. Other Codex prompts (edits, network) are untested.

Product terms follow [Product terminology](terminology.en.md).
