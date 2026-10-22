import { emptyCounts, type PartKind, type ProcessCounts, type ProcessEvent, type ProcessItem, type TurnPart } from './types.js';

// Which of a turn's texts are its reply and which were said on the way:
// - A text carrying the CLI's own phase (Codex: commentary / final_answer)
//   is what it says.
// - Otherwise (Claude): the texts after the last tool before each point the
//   CLI finished a round (turn_duration, an Esc stop, the turn's end) are
//   the reply; a text a tool follows was said on the way — unless that
//   tool asks the user something (AskUserQuestion, ExitPlanMode), whose
//   lead-in is meant for them.
export function classifyTexts(events: readonly ProcessEvent[]): Map<number, PartKind> {
  const kinds = new Map<number, PartKind>();
  let pending: number[] = [];
  const settle = (kind: PartKind) => {
    for (const i of pending) kinds.set(i, kind);
    pending = [];
  };
  events.forEach((event, i) => {
    if (event.type === 'text') pending.push(i);
    else if (event.type === 'tool') settle(event.interactive ? 'reply' : 'progress');
    else if (event.type === 'end' || event.type === 'interrupt') settle('reply');
  });
  settle('reply');
  events.forEach((event, i) => {
    if (event.type !== 'text') return;
    if (event.phase === 'final_answer') kinds.set(i, 'reply');
    else if (event.phase === 'commentary') kinds.set(i, 'progress');
  });
  return kinds;
}

// The texts as parts: neighbours of the same kind joined the way the turn
// parser joins every text (so all parts together equal the stored text).
export function partsOf(events: readonly ProcessEvent[]): TurnPart[] {
  const kinds = classifyTexts(events);
  const partIndex = partIndexByEvent(events, kinds);
  const parts: TurnPart[] = [];
  events.forEach((event, i) => {
    if (event.type !== 'text') return;
    const part = parts[partIndex.get(i)!];
    if (part) part.text += `\n\n${event.text}`;
    else parts.push({ kind: kinds.get(i) ?? 'reply', text: event.text, at: event.at });
  });
  return parts;
}

export function countsOf(events: readonly ProcessEvent[]): ProcessCounts {
  const counts = emptyCounts();
  // Files read or edited count once each, however often (a Codex patch
  // can name several, comma-separated in its label).
  const files = { read: new Set<string>(), edit: new Set<string>() };
  for (const event of events) {
    if (event.type === 'tool') {
      if (event.kind === 'read' || event.kind === 'edit') {
        for (const file of event.label.split(', ')) if (file) files[event.kind].add(file);
      } else counts[event.kind] += 1;
      if (event.status === 'error') {
        counts.failed += 1;
        if (event.kind === 'run') counts.runFailed += 1;
      }
    } else if (event.type === 'thinking') counts.thinking += 1;
  }
  counts.read = files.read.size;
  counts.edit = files.edit.size;
  return counts;
}

// The level-3 list: everything but the texts, each placed after the part
// it followed.
export function itemsOf(events: readonly ProcessEvent[], hasDetail: (event: ProcessEvent) => boolean): ProcessItem[] {
  const items: ProcessItem[] = [];
  const textParts = partIndexByEvent(events, classifyTexts(events));
  let afterPart = -1;
  events.forEach((event, i) => {
    if (event.type === 'text') {
      afterPart = textParts.get(i) ?? afterPart;
      return;
    }
    if (event.type === 'tool') {
      items.push({ id: event.id, kind: event.kind, label: event.label, at: event.at, status: event.status, hasDetail: hasDetail(event), afterPart });
    } else if (event.type === 'thinking') {
      items.push({ id: event.id, kind: 'thinking', label: '', at: event.at, status: 'ok', hasDetail: hasDetail(event), afterPart });
    } else if (event.type === 'compaction') {
      items.push({ id: event.id, kind: 'compaction', label: '', at: event.at, status: 'ok', hasDetail: false, afterPart });
    }
  });
  return items;
}

// Which part each text event goes in: neighbouring texts of the same kind
// with nothing but texts between them share one (a tool between two
// progress texts keeps them apart).
function partIndexByEvent(events: readonly ProcessEvent[], kinds: Map<number, PartKind>): Map<number, number> {
  const result = new Map<number, number>();
  let part = -1;
  let lastKind: PartKind | null = null;
  let lastText = -1;
  events.forEach((event, i) => {
    if (event.type !== 'text') return;
    const kind = kinds.get(i) ?? 'reply';
    const adjacent = lastText >= 0 && events.slice(lastText + 1, i).every((between) => between.type === 'text');
    if (!(part >= 0 && lastKind === kind && adjacent)) part += 1;
    result.set(i, part);
    lastKind = kind;
    lastText = i;
  });
  return result;
}
