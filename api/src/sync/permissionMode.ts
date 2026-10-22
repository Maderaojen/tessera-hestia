import * as registry from '../registry.js';
import { deriveSessionActivity, type ActualPermissionModeState, type ManagedSession } from '../types.js';
import { resolvedBinding } from './binding.js';

// The permission mode the running CLI is actually in, for the chat header
// and the session list (ADR 0027 決策 5): the CLI's own latest record of
// it, from the transcript the poller already reads (its parse is cached).
//
// Changed in the terminal: an auto or yolo launch, when the latest mode
// isn't that one; a CLI-default launch (Hestia passed nothing, so the
// account's own settings decided), when it isn't the conversation's first
// recorded mode.

export async function readActualPermissionMode(session: ManagedSession): Promise<ActualPermissionModeState | null> {
  const activity = deriveSessionActivity(session);
  if (activity === 'ended' || activity === 'not_started' || activity === 'starting') return null;
  const binding = resolvedBinding(session);
  if (!binding?.adapter.readPermissionModes) return null;
  const { first, last } = await binding.adapter.readPermissionModes(binding.file).catch(() => ({ first: null, last: null }));
  if (!last) return null;
  const launched = session.launchProfile?.permissionMode ?? 'cli_default';
  const changedInTerminal = launched === 'cli_default' ? !!first && first.cli !== last.cli : last.mode !== launched;
  return { mode: last.mode, cli: last.cli, changedInTerminal };
}

const same = (a: ActualPermissionModeState | null | undefined, b: ActualPermissionModeState | null) =>
  (a ?? null) === b || (!!a && !!b && a.mode === b.mode && a.cli === b.cli && a.changedInTerminal === b.changedInTerminal);

/** Writes only what changed: every write is pushed to clients. */
export async function refreshActualPermissionMode(session: ManagedSession): Promise<void> {
  const actual = await readActualPermissionMode(session);
  if (same(session.actualPermissionMode, actual)) return;
  await registry.updateSession(session.id, { actualPermissionMode: actual });
}
