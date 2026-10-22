import type { PermissionMode, PermissionModeUnavailableReason } from './permissions.js';

// The CLIs the API can drive, as both sides name them. The API's runtime
// drivers (api/src/runtimes/) are what actually decides a runtime's label
// and capabilities, and GET /api/meta reports them; the web app reads that.
// The table below is what this contract version knows, for the drivers to
// declare their labels from and for a frontend facing a backend without
// /meta (see docs/reference/api-contract-v1.md).

/** The product a CLI belongs to (whose accounts, quota and conversations). */
export const PROVIDERS = ['claude', 'codex', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * The executable and transcript implementation behind a provider.
 * 'legacy-unknown' marks records written before runtimes existed.
 */
export const RUNTIME_IDS = ['claude-code', 'codex-cli', 'gemini-cli', 'agy', 'legacy-unknown'] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

/** A runtime the API has a driver for (every id but 'legacy-unknown'). */
export type DrivenRuntimeId = Exclude<RuntimeId, 'legacy-unknown'>;

/** The name each runtime is shown under, as of this contract version. */
export const RUNTIME_LABELS: Record<DrivenRuntimeId, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  agy: 'Gemini · Agy',
};

/**
 * What the app can do with a runtime, as its driver declares it:
 * - resume: reopen a recorded conversation in place (recover a dead tmux,
 *   switch back to an earlier conversation);
 * - clear: exit and relaunch it in the same tmux (/clear), version-verified;
 * - interrupt: stop an in-flight reply with a verified key;
 * - startup_prompt: recognize its start-up prompt so the app can answer it;
 * - quota: read its accounts' usage;
 * - janus: launch it as a Janus account;
 * - subagents: list the subagents a conversation delegated to;
 * - model_switch: list the models it can use and switch a running one
 *   (contract/models.ts);
 * - limit_hit: recognize that it stopped on a usage limit, so the app can
 *   carry it on once the limit resets (contract/continuity.ts).
 * A client must treat an unknown capability string as absent.
 */
export const RUNTIME_CAPABILITIES = ['resume', 'clear', 'interrupt', 'startup_prompt', 'quota', 'janus', 'subagents', 'model_switch', 'limit_hit'] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export type RuntimeMeta = {
  id: RuntimeId;
  provider: Provider;
  label: string;
  capabilities: RuntimeCapability[];
  // The launch permission modes it supports (contract/permissions.ts),
  // cli_default always among them. Absent from a backend without
  // `permission_modes`.
  permissionModes?: PermissionMode[];
  // Of those, the ones that can't be used on this host now, and why.
  permissionModesUnavailable?: Partial<Record<PermissionMode, PermissionModeUnavailableReason>>;
};

export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === 'string' && (RUNTIME_IDS as readonly string[]).includes(value);
}
