import { prompt } from '../i18n/index.js';
import type { UpstreamLocations } from './view.js';

// The part of a brief that says where the upstream conversation can be
// read (ADR 0023): a branch line's, a delegate's and a handoff's brief all
// point at it this way instead of copying it. Its words are in
// i18n/prompts/upstream.json.

// A user's request is quoted up to this many characters.
export const LAST_REQUEST_MAX = 1000;

/** `text` trimmed, and cut at `max` characters with a note that it was. */
export function cut(text: string, max: number, note = prompt('upstream.cut.omitted')): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}${note}` : trimmed;
}

export type UpstreamLocationsInput = {
  // The first, recommended way to read it: the text of the list's first
  // item, a `hestia conversation show` command and what it prints.
  command: string;
  view: Pick<UpstreamLocations, 'archiveFile' | 'transcriptFile' | 'transcriptFormat'>;
};

/** 「上游對話紀錄在哪裡」: the command first, then the files, in the order to try them. */
export function formatUpstreamLocations(input: UpstreamLocationsInput): string[] {
  const { view } = input;
  const lines = ['', prompt('upstream.locations.heading'), '', prompt('upstream.locations.intro'), ''];
  lines.push(`1. ${input.command}`);
  let n = 2;
  if (view.archiveFile) lines.push(prompt('upstream.locations.archive', { n: n++, file: view.archiveFile }));
  if (view.transcriptFile) {
    lines.push(prompt(view.transcriptFormat === 'sqlite' ? 'upstream.locations.transcriptSqlite' : 'upstream.locations.transcriptJsonl', { n: n++, file: view.transcriptFile }));
  }
  return lines;
}
