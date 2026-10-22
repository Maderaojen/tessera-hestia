import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/providers/claude.js';
import { turnsBefore } from '../../src/sync/binding.js';
import { selectNewTurns } from '../../src/sync/turns.js';

// A branch line's Claude transcript as Claude Code 2.1.294 wrote it
// (recorded in an isolated test, de-identified): the conversation it
// forked from, copied with its times, then its own turn. Only its own is
// imported.

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fork', 'claude.fork.2.1.294.jsonl');
// The fork was started between the copied turn and its own first one.
const FORK_STARTED_AT = '2026-10-08T09:03:20.000Z';

describe('a branch line\'s forked transcript', () => {
  it('imports only the turns after the fork', async () => {
    const parsed = await claudeAdapter.parseTurns(fixture);
    expect(parsed.map((turn) => turn.assistant.text)).toEqual(['ALPHA', 'BETA']);
    const offset = turnsBefore(parsed, FORK_STARTED_AT);
    expect(offset).toBe(1);
    const imported = selectNewTurns(parsed, { turns: [], transcriptTurnOffset: offset });
    expect(imported.map((turn) => turn.user.text)).toEqual(['Reply with exactly the word BETA and nothing else.']);
    // Once its own turn is stored, the copied ones stay out by time too.
    expect(selectNewTurns(parsed, { turns: imported, transcriptTurnOffset: offset })).toEqual([]);
  });
});
