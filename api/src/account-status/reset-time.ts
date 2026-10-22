// Parses the human reset wording Claude's `/usage` panel prints, e.g.
//   "Resets 7:10pm (Asia/Taipei)"
//   "Resets Sep 25, 12am (Asia/Taipei)"
//   "Resets Sep 26, 5:59am (Asia/Taipei)"
// into an absolute instant. The panel only prints wall-clock time in a named
// zone, so we resolve it against that zone (no year, no date → next future
// occurrence).

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

function wallClockIn(instant: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

// UTC instant whose wall clock in `timeZone` is `wall`.
export function zonedTimeToUtc(wall: Wall, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const seen = wallClockIn(guess, timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += asUtc - seenAsUtc;
  }
  return guess;
}

function validZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const RESET_RE = /^Resets\s+(?:(?<mon>[A-Za-z]{3})[a-z]*\s+(?<day>\d{1,2}),?\s+)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)\s*(?:\((?<tz>[^)]+)\))?\s*$/i;

export function parseResetText(text: string, now: Date, defaultZone = 'UTC'): string | null {
  const match = RESET_RE.exec(text.trim());
  if (!match?.groups) return null;
  const g = match.groups;
  const timeZone = g.tz?.trim() || defaultZone;
  if (!validZone(timeZone)) return null;
  const clockHour = Number(g.h);
  const minute = g.m ? Number(g.m) : 0;
  if (clockHour < 1 || clockHour > 12 || minute > 59) return null;
  const hour = (clockHour % 12) + (g.ap.toLowerCase() === 'pm' ? 12 : 0);
  const today = wallClockIn(now.getTime(), timeZone);

  if (g.mon) {
    const month = MONTHS.indexOf(g.mon.toLowerCase()) + 1;
    const day = Number(g.day);
    if (month === 0 || day < 1 || day > 31) return null;
    let instant = zonedTimeToUtc({ year: today.year, month, day, hour, minute }, timeZone);
    // "Jan 2" printed in late December belongs to next year.
    if (instant < now.getTime() - 24 * 60 * 60 * 1000) {
      instant = zonedTimeToUtc({ year: today.year + 1, month, day, hour, minute }, timeZone);
    }
    return new Date(instant).toISOString();
  }

  let instant = zonedTimeToUtc({ ...today, hour, minute }, timeZone);
  if (instant <= now.getTime()) {
    const tomorrow = wallClockIn(now.getTime() + 24 * 60 * 60 * 1000, timeZone);
    instant = zonedTimeToUtc({ ...tomorrow, hour, minute }, timeZone);
  }
  return new Date(instant).toISOString();
}
