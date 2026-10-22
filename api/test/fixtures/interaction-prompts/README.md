# Interaction prompt captures

Claude Code 2.1.284 prompts that wait on the user — tool permissions and
AskUserQuestion — captured from a real pane (`tmux capture-pane -p`) in an
isolated tmux server under `/tmp/aqt`, 2026-09-29. Panes are 120 columns
wide, except `*-narrow` (56). `test/providers/claude-interaction.test.ts`
reads every file here; see `docs/reference/human-in-the-loop.md` for what each key
does on these screens.

File name: `claude.<screen>.<version>.txt`

| Screen | Shows |
|---|---|
| `perm-write` | Write permission, cursor on 1. Yes, "Tab to amend" |
| `perm-write-tab` | after Tab: row 1 open for a note |
| `perm-write-amend` | a note typed on row 1 |
| `perm-bash` / `perm-bash-narrow` | Bash permission with a tip, four options (long rows wrap when narrow) |
| `perm-bash-cursor-no` | cursor moved to 4. No |
| `perm-bash-no-amend` | a note typed on 4. No |
| `q-single` / `q-single-narrow` | a single question (long descriptions wrap when narrow) |
| `q-multi-q1` / `q-multi-q1-typed` | first of three questions; text typed on its free-text row |
| `q-multi-q2` | a multi-select question |
| `q-ms-toggled` / `q-ms-typed` / `q-ms-next` | a box ticked; text typed (ticks it); cursor on Next |
| `q-multi-q3` | the last question |
| `q-review` | the review of all answers before submitting |
| `q-narrow-wrapped-footer` / `q-narrow-wrapped-typed` | 56 columns, cursor on the free-text row: the key hints wrap onto a second line; long typed text wraps |
| `idle-after` / `idle-after-question` | back at the input box once answered: no prompt |

When a Claude Code version changes these screens, add its captures here and
update `docs/reference/cli-version-alignment.md`.
