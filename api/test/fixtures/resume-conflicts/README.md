# Resume conflict captures

Screens a CLI shows right after the app resumed one of its conversations.
`test/runtimes-resume-conflict.test.ts` runs every file here through the
runtime's `resumeConflict.detect` (and checks none reads as a trust prompt).

File name: `<runtime>.<expected>.<label>.txt`

- `runtime`: `codex`
- `expected`: `conflict` (the "open in another app" screen) or `none`
- `label`: CLI version and what the screen shows

| File | Source |
|---|---|
| `codex.conflict.0.160.0-janus-daemon.txt` | Codex CLI 0.160.0 via Janus, `--no-daemon` resume while the shared daemon still held the thread; isolated tmux, real capture (2026-10-05; path shortened) |
| `codex.conflict.0.160.0-second-pane.txt` | Codex CLI 0.160.0, a second pane resuming a thread another pane had open; real capture (2026-10-05) |
| `codex.none.0.160.0-after-resume.txt` | Codex CLI 0.160.0 right after a normal `resume`; real capture (2026-10-05; path shortened) |
| `codex.none.0.160.0-cwd-menu.txt` | Codex CLI 0.160.0's working-directory menu, shown by a resume without `-C`; real capture (2026-10-05; paths shortened) |
