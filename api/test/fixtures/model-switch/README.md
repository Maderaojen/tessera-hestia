# Model switch captures

Screens around switching a running CLI's model, read by
`test/runtimes-models.test.ts` through the matching runtime's reader
(`runtimes/claude-models.ts`, `codex-models.ts`, `agy-models.ts`).

File name: `<runtime>.<what>.<version>.txt`. When a CLI version changes one
of these screens, add its capture here (`tmux capture-pane -p -t <target>
> <file>`), fix that runtime's reader, then update
`docs/reference/cli-version-alignment.md`.

| File | Source |
|---|---|
| `claude.answers.2.1.283.txt` | Claude Code 2.1.283: `/model claude-sonnet-5` then an unknown name, isolated tmux (2026-09-27; path shortened) |
| `claude.confirm-dialog.2.1.283.txt` | Claude Code 2.1.283, Pro account without usage credits: `/model fable` asks first (2026-09-27; path shortened) |
| `codex.model-menu.0.157.1.txt` | Codex CLI 0.157.1 `/model` menu (2026-09-27; path shortened) |
| `codex.effort-menu.0.157.1.txt` | Its effort menu after picking GPT-6-Astra, with "More reasoning…" |
| `codex.effort-menu-4-levels.0.157.1.txt` | The effort menu for GPT-5.5 (no max/ultra) |
| `codex.advanced-menu.0.157.1.txt` | "More reasoning…": Max / Ultra |
| `codex.changed.0.157.1.txt` | After picking Max: "Model changed to gpt-6-astra max" |
| `agy.answers.1.2.12.txt` | Agy 1.2.12: `/model gemini-3.7-flash-low` then an unknown id (2026-09-27; account and path redacted) |
