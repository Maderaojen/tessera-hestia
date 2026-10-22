import type { RuntimeId } from './runtimes.js';

// How much a CLI may do without asking, chosen when it is launched. Only future launches
// follow a change: a running CLI keeps the mode it was started with.
//
// - cli_default: Hestia passes nothing; the CLI's own settings decide (the
//   behavior before this existed, and every factory default).
// - auto: the CLI's own "decide for me" mode (Claude Code's
//   `--permission-mode auto`, Codex's `--approve-for-me`).
// - yolo: no approvals at all (Claude Code's bypassPermissions, Codex's
//   `--dangerously-bypass-approvals-and-sandbox`, Agy's
//   `--dangerously-skip-permissions`). Never a global default: only a
//   tmux's own setting or one launch's choice, each confirmed by the user.

export const PERMISSION_MODES = ['cli_default', 'auto', 'yolo'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** What the global per-runtime default may be: never yolo. */
export const GLOBAL_PERMISSION_MODES = ['cli_default', 'auto'] as const;
export type GlobalPermissionMode = (typeof GLOBAL_PERMISSION_MODES)[number];

/**
 * Why a mode a runtime has flags for can't be used on this host right now:
 * 'sandbox_unavailable' — Codex's auto runs every command in Codex's own
 * sandbox, which can't start here (e.g. AppArmor blocks bubblewrap).
 */
export type PermissionModeUnavailableReason = 'sandbox_unavailable';
export type PermissionModeUnavailability = Partial<Record<RuntimeId, Partial<Record<PermissionMode, PermissionModeUnavailableReason>>>>;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * GET/PUT /permission-modes: each runtime's default for new launches
 * (absent: cli_default), and which modes each runtime supports (as its
 * driver declares; cli_default always). PUT takes `defaults`, field by
 * field, null putting a runtime back on cli_default; yolo is refused.
 */
export type PermissionModeSettingsResponse = {
  defaults: Partial<Record<RuntimeId, GlobalPermissionMode>>;
  supported: Partial<Record<RuntimeId, PermissionMode[]>>;
  // Supported modes that can't be used on this host now, and why: refused
  // when chosen (400 permission_mode_unavailable); one already saved
  // starts as cli_default instead.
  unavailable?: PermissionModeUnavailability;
};
export type PermissionModeSettingsPatch = { defaults: Partial<Record<RuntimeId, GlobalPermissionMode | null>> };

/**
 * GET/PUT /sessions/:id/permission-modes: this tmux's own choice per
 * runtime (may be yolo), and what applies to a launch in it (its own, then
 * the global default). PUT: null puts a runtime back on the global value.
 */
export type SessionPermissionModesResponse = {
  override: Partial<Record<RuntimeId, PermissionMode>>;
  effective: Partial<Record<RuntimeId, PermissionMode>>;
  defaults: Partial<Record<RuntimeId, GlobalPermissionMode>>;
  supported: Partial<Record<RuntimeId, PermissionMode[]>>;
  unavailable?: PermissionModeUnavailability;
};
export type SessionPermissionModesPatch = { override: Partial<Record<RuntimeId, PermissionMode | null>> };

/**
 * The permission mode the running CLI is actually in, read from its own
 * transcript: it can change in the terminal (Claude Code's shift+tab,
 * Codex's /permissions). Mapped onto the app's words; what the CLI itself
 * calls it is in `cli`.
 *
 * - ask: it asks before acting (Claude Code `default`; Codex an approval
 *   policy that asks, with the user reviewing).
 * - auto: the CLI decides (Claude Code `auto`; Codex approvals reviewed by
 *   its auto reviewer, `approvals_reviewer: auto_review`).
 * - yolo: never asks (Claude Code `bypassPermissions`; Codex approval
 *   `never` with the `danger-full-access` sandbox).
 * - other: anything else (Claude Code `plan`, `acceptEdits`; Codex `never`
 *   inside a sandbox).
 */
export const ACTUAL_PERMISSION_MODES = ['ask', 'auto', 'yolo', 'other'] as const;
export type ActualPermissionMode = (typeof ACTUAL_PERMISSION_MODES)[number];
export type SessionActualPermissionMode = { mode: ActualPermissionMode; cli: string };
