# Start-up prompt captures

Screens a CLI shows before it accepts input (its workspace-trust menu), and
screens right after one was answered. `test/runtimes-startup-prompt.test.ts`
runs every file here through the matching runtime's reader.

File name: `<runtime>.<expected>.<label>.txt`

- `runtime`: `claude`, `codex` or `agy` (the reader it is fed to)
- `expected`: `trust` / `decline` (the option under the cursor), `unknown`
  (prompt recognised, cursor unreadable) or `none` (no live prompt)
- `label`: CLI version and/or what the screen shows

When a CLI version changes its prompt, add its capture here
(`tmux capture-pane -p -t <target> > <file>`); only that runtime's spec
should need to change. Then update `docs/reference/cli-version-alignment.md`.

| File | Source |
|---|---|
| `claude.decline.2.1.281-usage-probe.txt` | Claude Code 2.1.281, usage-probe folder, real capture (2026-09-24) |
| `claude.decline.2.1.283.txt` | Claude Code 2.1.283 (claude-work), fresh folder, real capture (2026-09-27; path shortened) |
| `claude.decline.fresh-folder-2026-09-25.txt` | Claude Code, fresh folder, as shown 2026-09-25 |
| `claude.trust.older-numbered-form.txt` | Older Claude Code wording, reconstructed |
| `agy.trust.1.2.10.txt` | Agy 1.2.10, isolated tmux, 2026-09-25 |
| `agy.trust.1.2.12-status-bar.txt` | Agy 1.2.12, 133-column app pane, real capture (2026-09-27) |
| `codex.trust.0.157.1.txt` | Codex CLI 0.157.1, isolated tmux, real capture (2026-09-27; path shortened) |
| `codex.none.0.157.1-after-trust.txt` | Codex CLI 0.157.1 right after choosing Trust, real capture (2026-09-27; path shortened) |
| `claude.none.after-trust-sample.txt` | The fresh-folder prompt answered Yes, Claude's screen below it (sample) |
| `claude.none.after-decline-sample.txt` | The fresh-folder prompt answered No, the shell below it (sample) |
| `agy.none.input-box-sample.txt` | Agy's normal input box (sample) |
| `agy.none.after-trust-sample.txt` | The 1.2.10 prompt answered, Agy's input box below it (sample) |
