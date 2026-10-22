import { describe, expect, it } from 'vitest';
import { parseResetText } from '../../src/account-status/reset-time.js';

// 2026-09-24 14:20 in Taipei.
const NOW = new Date('2026-09-24T06:20:00Z');

describe('parseResetText (Claude /usage wording)', () => {
  it('resolves a time-only reset later today in the named zone', () => {
    expect(parseResetText('Resets 7:10pm (Asia/Taipei)', NOW)).toBe('2026-09-24T11:10:00.000Z');
  });

  it('rolls a time-only reset that already passed over to tomorrow', () => {
    expect(parseResetText('Resets 1pm (Asia/Taipei)', NOW)).toBe('2026-09-25T05:00:00.000Z');
  });

  it('resolves month/day resets, including 12am', () => {
    expect(parseResetText('Resets Sep 25, 12am (Asia/Taipei)', NOW)).toBe('2026-09-24T16:00:00.000Z');
    expect(parseResetText('Resets Sep 26, 5:59am (Asia/Taipei)', NOW)).toBe('2026-09-25T21:59:00.000Z');
  });

  it('moves a date that would be in the past into next year', () => {
    expect(parseResetText('Resets Jan 2, 3pm (UTC)', new Date('2026-12-31T10:00:00Z'))).toBe('2027-01-02T15:00:00.000Z');
  });

  it('honours DST in the named zone', () => {
    // US DST ends 2026-11-01 02:00 → 3am is EST (UTC-5).
    expect(parseResetText('Resets Nov 1, 3am (America/New_York)', NOW)).toBe('2026-11-01T08:00:00.000Z');
    expect(parseResetText('Resets Oct 30, 3am (America/New_York)', NOW)).toBe('2026-10-30T07:00:00.000Z');
  });

  it('falls back to the default zone and rejects wording it does not understand', () => {
    expect(parseResetText('Resets 7pm', NOW, 'UTC')).toBe('2026-09-24T19:00:00.000Z');
    expect(parseResetText('Resets 7pm (Not/AZone)', NOW)).toBeNull();
    expect(parseResetText('Resets in 3 hours', NOW)).toBeNull();
    expect(parseResetText('Resets 13pm (UTC)', NOW)).toBeNull();
  });
});
