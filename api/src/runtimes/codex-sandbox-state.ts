// Whether Codex's own sandbox works on this host, as last probed
// (permission-modes/codex-sandbox.ts). Codex's `auto` launch mode
// (`--approve-for-me`) runs every command in the workspace-write sandbox;
// where bubblewrap can't start (Ubuntu's
// kernel.apparmor_restrict_unprivileged_userns=1 without a bwrap profile)
// every command fails before it runs (verified 0.162.1, 2026-10-11), so
// auto isn't offered. Unknown (not probed yet) counts as unavailable.

type State = { available: boolean | null; checkedAt: number | null };

let state: State = { available: null, checkedAt: null };

export function codexSandboxAvailable(): boolean {
  return state.available === true;
}

export function codexSandboxState(): State {
  return { ...state };
}

export function setCodexSandboxState(available: boolean, checkedAt: number = Date.now()): void {
  state = { available, checkedAt };
}

/** Tests: a known answer (or null, not probed). */
export function __setCodexSandboxForTests(available: boolean | null): void {
  state = { available, checkedAt: available === null ? null : Date.now() };
}
