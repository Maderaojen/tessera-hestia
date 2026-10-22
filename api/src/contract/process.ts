// A turn's process — which of its texts are the reply, what tools it used,
// its thinking — read from the CLI's own transcript on request and never
// stored (capability `turn_process`; docs/specs/turn-process-levels.md).

export type ToolKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'other';
export type ProcessItemStatus = 'ok' | 'error' | 'running';
export type TurnPartKind = 'reply' | 'progress';

/** One stretch of a turn's text: its reply, or something said on the way. */
export type TurnPart = { kind: TurnPartKind; text: string; at: string | null };

// `read` and `edit` count files (each once), the other kinds count calls;
// `failed` is every failed call, `runFailed` the failed commands among them.
export type ProcessCounts = Record<ToolKind, number> & { failed: number; runFailed: number; thinking: number };

/**
 * `available`: `parts` joined with a blank line are exactly the turn's
 * `assistant.text` (without the old interrupted marker). `open`: the turn
 * is still being written. Otherwise why there is none: the transcript is
 * gone (`transcript_missing`), the stored turn can't be found in it or
 * differs from it (`unmatched`, `unavailable`), or the CLI's transcripts
 * aren't read this way (`unsupported`).
 */
export type TurnProcessBrief =
  | { status: 'available'; open: boolean; parts: TurnPart[]; counts: ProcessCounts }
  | { status: 'transcript_missing' | 'unmatched' | 'unavailable' | 'unsupported' };

export type ProcessItem = {
  id: string;
  kind: ToolKind | 'thinking' | 'compaction';
  label: string;
  at: string | null;
  status: ProcessItemStatus;
  hasDetail: boolean;
  // The part (index into `parts`) this came after; -1 before any text.
  afterPart: number;
};

export type ProcessItemDetail = {
  input?: string;
  output?: string;
  diff?: string;
  // Thinking: its text, or null when the CLI kept none.
  thinking?: string | null;
  // A command's exit code, when the CLI recorded one.
  exitCode?: number | null;
  truncated: boolean;
  // When cut: the longest cut field's original size, in bytes.
  originalBytes?: number;
  // The images the item showed the CLI (capability process_images): a
  // tool result's own image (Claude, `result`) or the file it looked at
  // (Codex view_image, `file`). Each is fetched on its own from GET
  // …/process/items/:itemId/images/:index; absent when there are none.
  images?: ProcessImage[];
};

/**
 * One image of a process item. `name`: the file's name for `file`, null
 * for a result's own image. Served only as PNG, JPEG, GIF or WebP by its
 * actual bytes, at most PROCESS_IMAGE_MAX_BYTES; a file is read from where
 * the transcript says (inside the project or not), never a path a client
 * names, and refused when it is sensitive, the backend's own, not a
 * regular file, or changed into something else.
 */
export type ProcessImage = { index: number; source: 'result' | 'file'; name: string | null };
export const PROCESS_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * What changed in git while a turn went on (GET …/turns/:index/git): the
 * commits made between its user message and the next one (the latest turn:
 * up to a minute after the CLI last wrote for it; `until` null while it is
 * still going, up to now), in each repo the CLI worked in. Commits other
 * sessions made in the same repo meanwhile are among them. `projectRoot`:
 * the project path the Git area opens this repo by (null when it can't).
 * `uncommitted`: for the latest turn only, how many files are changed but
 * not committed right now (not attributable to any one turn).
 */
export type TurnGitCommit = { sha: string; subject: string; committedAt: string | null; files: { path: string; status: string }[] };
export type TurnGitRepo = { root: string; projectRoot: string | null; commits: TurnGitCommit[]; truncated: boolean; uncommitted: number | null };
export type TurnGitChanges = { since: string | null; until: string | null; repos: TurnGitRepo[] };

/**
 * How long each Claude account's transcripts are kept (capability
 * transcript_retention; GET/PUT /transcript-retention). `days` null: not
 * set, Claude Code's default (`defaultDays`) applies. `file` is the
 * settings file a change is written to. `unreadable`: that file isn't a
 * JSON object Hestia can safely change.
 */
export type RetentionAccount = {
  id: string;
  name: string;
  source: 'native' | 'janus';
  file: string;
  state: 'ok' | 'unreadable';
  days: number | null;
};
export type TranscriptRetention = { defaultDays: number; minDays: number; maxDays: number; accounts: RetentionAccount[] };
