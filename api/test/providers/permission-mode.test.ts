import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/providers/claude.js';
import { codexAdapter } from '../../src/providers/codex.js';
import { claudePermissionMode, claudePermissionModes, codexPermissionMode, codexPermissionModes } from '../../src/providers/permission-mode.js';

// Shapes copied from real records (scrubbed): Claude Code 2.1.296 (an
// interactive session's permission-mode records and user records, and a
// print-mode run with --permission-mode bypassPermissions), Codex 0.162.1
// rollouts' turn_context (--approve-for-me, then full access).
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/permission-mode');

describe('Claude Code permission mode', () => {
  it('reads the first and latest from the transcript', async () => {
    expect(await claudeAdapter.readPermissionModes!(path.join(FIXTURES, 'claude.2.1.296.jsonl'))).toEqual({
      first: { mode: 'auto', cli: 'auto' },
      last: { mode: 'other', cli: 'plan' },
    });
  });

  it('reads it off the user record when there is no permission-mode record (print mode)', async () => {
    expect(await claudeAdapter.readPermissionModes!(path.join(FIXTURES, 'claude.print.2.1.296.jsonl'))).toEqual({
      first: { mode: 'yolo', cli: 'bypassPermissions' },
      last: { mode: 'yolo', cli: 'bypassPermissions' },
    });
  });

  it('maps the CLI names', () => {
    expect(claudePermissionMode('default').mode).toBe('ask');
    expect(claudePermissionMode('auto').mode).toBe('auto');
    expect(claudePermissionMode('bypassPermissions').mode).toBe('yolo');
    expect(claudePermissionMode('acceptEdits')).toEqual({ mode: 'other', cli: 'acceptEdits' });
    expect(claudePermissionMode('somethingNew')).toEqual({ mode: 'other', cli: 'somethingNew' });
  });

  it('ignores sidechain records and anything without a mode', () => {
    expect(claudePermissionModes([
      { type: 'user', isSidechain: true, permissionMode: 'bypassPermissions' },
      { type: 'assistant', permissionMode: 'bypassPermissions' },
      { type: 'user' },
      'junk',
    ])).toEqual({ first: null, last: null });
  });
});

describe('Codex permission mode', () => {
  it('reads every turn_context', async () => {
    expect(await codexAdapter.readPermissionModes!(path.join(FIXTURES, 'codex.0.162.1.jsonl'))).toEqual({
      first: { mode: 'auto', cli: 'on-request · workspace-write · auto_review' },
      last: { mode: 'yolo', cli: 'never · danger-full-access' },
    });
  });

  it('maps approval policy, reviewer and sandbox', () => {
    expect(codexPermissionMode('never', 'user', 'danger-full-access')?.mode).toBe('yolo');
    expect(codexPermissionMode('on-request', 'auto_review', 'workspace-write')?.mode).toBe('auto');
    expect(codexPermissionMode('on-request', 'user', 'workspace-write')?.mode).toBe('ask');
    expect(codexPermissionMode('untrusted', 'user', 'read-only')?.mode).toBe('ask');
    expect(codexPermissionMode({ granular: { sandbox_approval: false } }, 'user', 'workspace-write')).toEqual({ mode: 'ask', cli: 'granular · workspace-write' });
    // never inside a sandbox: no prompts, but not unconfined either.
    expect(codexPermissionMode('never', 'user', 'read-only')?.mode).toBe('other');
    expect(codexPermissionMode('never', 'auto_review', 'workspace-write')?.mode).toBe('other');
    expect(codexPermissionMode('something-new', 'user', 'workspace-write')?.mode).toBe('other');
    expect(codexPermissionMode(undefined, 'user', 'workspace-write')).toBeNull();
    expect(codexPermissionMode('never', 'user', undefined)).toBeNull();
  });

  it('skips records that are not a turn_context', () => {
    expect(codexPermissionModes([{ type: 'event_msg', payload: { approval_policy: 'never' } }, { type: 'turn_context' }])).toEqual({ first: null, last: null });
  });
});
