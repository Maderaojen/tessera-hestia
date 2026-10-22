# Launch-screen captures

What a just-launched CLI's pane shows, for the launch guard (ADR 0030):
the first message after a launch is typed only into the CLI's own input
box. `test/runtimes-launch-screen.test.ts` runs every file here (and some
captures other readers keep, listed in the test) through
`readLaunchScreen` with the matching runtime.

File name: `<runtime>.<expected>.<label>.txt`

- `runtime`: `claude`, `codex` or `agy`
- `expected`: `ready` (its input box), `startup` (the trust prompt),
  `update_<choice>` (the update menu, `<choice>` under the cursor),
  `updated` (it updated itself and quit, asking to be restarted), or
  `unknown` (anything else: nothing is typed into it)
- `label`: CLI version and what the screen shows

Paths are shortened; user and host names replaced. When a CLI version
changes one of these screens, add its capture here
(`tmux -L <socket> capture-pane -p -t <target> > <file>`), change only that
runtime's reader, and update `docs/reference/cli-version-alignment.md`.

| File | Source |
|---|---|
| `codex.update_update.0.163.0.txt` | Codex 0.163.0, isolated tmux and CODEX_HOME whose `version.json` names a newer `latest_version`, as it starts (2026-10-16) |
| `codex.update_skip.0.163.0.txt` | Same, after one Down |
| `codex.update_skip_version.0.163.0.txt` | Same, after two Downs (a third wraps back to Update now) |
| `codex.ready.0.163.0-update-notice.txt` | Same, after Esc (skip): the input box under the "Update available!" notice |
| `codex.ready.0.163.0-update-check-off.txt` | Same CODEX_HOME launched with `-c check_for_update_on_startup=false`: no menu, no notice |
| `codex.unknown.0.163.0-login.txt` | Same, after Skip with no credentials: the sign-in menu |
| `codex.unknown.0.163.0-busy.txt` | Same with a dummy API key, a message being retried ("esc to interrupt" above the box) |
| `codex.updated.0.163.0-cube-handoff.txt` | The cube handoff's pane after Codex picked Update now (live, 2026-10-16) |
| `claude.ready.2.1.300-update-installed.txt` | A live Claude Code 2.1.300 pane's last lines, idle, after its background updater installed 2.1.301 |
| `claude.ready.2.1.295-update-installed.txt` | A live Claude Code 2.1.295 pane's last lines, the same |
| `claude.unknown.2.1.301-onboarding.txt` | Claude Code 2.1.301, isolated HOME and CLAUDE_CONFIG_DIR: the first-run theme picker |
| `agy.unknown.1.3.3-login.txt` | Agy 1.3.3 (a copy of the binary), isolated HOME: the sign-in menu |
| `agy.unknown.1.3.3-theme.txt` | Same, signed in (a copy of the token, deleted after): the first-run theme picker |
| `agy.startup.1.3.3.txt` | Same, after first-run setup (data sharing left off): the workspace-trust menu |
| `agy.ready.1.3.3.txt` | Same, after trusting the folder: the input box under a dismissible notice (account name replaced) |
