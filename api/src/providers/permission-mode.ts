import type { SessionActualPermissionMode } from '../contract/permissions.js';

// The permission mode a CLI is actually in, by its own transcript (ADR 0027
// 決策 5). Only what the CLI writes anyway is read, from the records the
// poller already holds; nothing is asked of the CLI.

/** The conversation's first and latest recorded permission mode (null: none recorded). */
export type ObservedPermissionModes = {
  first: SessionActualPermissionMode | null;
  last: SessionActualPermissionMode | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function firstAndLast(records: readonly unknown[], read: (record: Record<string, unknown>) => SessionActualPermissionMode | null): ObservedPermissionModes {
  let first: SessionActualPermissionMode | null = null;
  for (const raw of records) {
    const record = asRecord(raw);
    first = record ? read(record) : null;
    if (first) break;
  }
  if (!first) return { first: null, last: null };
  for (let index = records.length - 1; index >= 0; index--) {
    const record = asRecord(records[index]);
    const last = record ? read(record) : null;
    if (last) return { first, last };
  }
  return { first, last: first };
}

// Claude Code (verified 2.1.296): every prompt writes a
// `{"type":"permission-mode","permissionMode":…,"sessionId":…}` record in
// an interactive session, and the user record itself carries
// `permissionMode` (in print mode the only place). Values: `default`,
// `auto`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`.
export function claudePermissionMode(cli: string): SessionActualPermissionMode {
  if (cli === 'bypassPermissions') return { mode: 'yolo', cli };
  if (cli === 'auto') return { mode: 'auto', cli };
  if (cli === 'default') return { mode: 'ask', cli };
  return { mode: 'other', cli };
}

function readClaudeRecord(record: Record<string, unknown>): SessionActualPermissionMode | null {
  if (record.type !== 'permission-mode' && record.type !== 'user') return null;
  if (record.isSidechain === true) return null;
  const mode = record.permissionMode;
  return typeof mode === 'string' && mode ? claudePermissionMode(mode) : null;
}

export function claudePermissionModes(records: readonly unknown[]): ObservedPermissionModes {
  return firstAndLast(records, readClaudeRecord);
}

// Codex (verified 0.162.1): every turn's `turn_context` payload has
// `approval_policy` (`never`, `on-request`, `untrusted`, `on-failure`, or
// `{ granular: … }`), `approvals_reviewer` (`user` or `auto_review`) and
// `sandbox_policy.type` (`danger-full-access`, `workspace-write`,
// `read-only`). `--approve-for-me` is on-request + auto_review +
// workspace-write; `--dangerously-bypass-approvals-and-sandbox` never +
// danger-full-access.
export function codexPermissionMode(approval: unknown, reviewer: unknown, sandbox: unknown): SessionActualPermissionMode | null {
  const policy = typeof approval === 'string' ? approval : asRecord(approval) && 'granular' in (approval as object) ? 'granular' : null;
  const sandboxType = typeof sandbox === 'string' ? sandbox : null;
  if (!policy || !sandboxType) return null;
  const cli = `${policy} · ${sandboxType}${reviewer === 'auto_review' ? ' · auto_review' : ''}`;
  if (policy === 'never') return { mode: sandboxType === 'danger-full-access' ? 'yolo' : 'other', cli };
  if (reviewer === 'auto_review') return { mode: 'auto', cli };
  if (policy === 'on-request' || policy === 'untrusted' || policy === 'on-failure' || policy === 'granular') return { mode: 'ask', cli };
  return { mode: 'other', cli };
}

function readCodexRecord(record: Record<string, unknown>): SessionActualPermissionMode | null {
  if (record.type !== 'turn_context') return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;
  return codexPermissionMode(payload.approval_policy, payload.approvals_reviewer, asRecord(payload.sandbox_policy)?.type);
}

export function codexPermissionModes(records: readonly unknown[]): ObservedPermissionModes {
  return firstAndLast(records, readCodexRecord);
}
