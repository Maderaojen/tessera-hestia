import { PANE_STREAM_INTERVAL_MS } from './config.js';
import * as tmuxCli from './tmux.js';
import type { CapturePaneOpts } from './tmux.js';

export type PaneUpdate = { content: string; cols: number; rows: number; capturedAt: string } | { error: string };

type Listener = (update: PaneUpdate) => void;

type Loop = {
  interval: NodeJS.Timeout;
  listeners: Set<Listener>;
  lastContent: string | null;
  lastSize: string | null; // "colsxrows", so a resize alone (no text change) still counts as an update
  // When the last successful capture landed, changed or not: lastContent
  // is the pane as of then (see recentAnsiCapture).
  lastCapturedAt: number;
  ansi: boolean;
  tmuxName: string;
  stopped: boolean;
};

// One capture-pane poll loop per (tmuxName, opts) combination, shared by
// every subscriber watching that exact view — several frontend tabs
// watching the same session never each spin up their own `tmux
// capture-pane` polling. A loop starts on the first subscriber and stops
// itself the moment the last one unsubscribes.
const loops = new Map<string, Loop>();

function keyFor(tmuxName: string, opts: CapturePaneOpts): string {
  return `${tmuxName}:${opts.ansi ? 1 : 0}:${opts.history ?? 'screen'}`;
}

// Returns an unsubscribe function. `onUpdate` fires once immediately with
// the current snapshot (or the first captured one, shortly after), then
// again only when the captured content actually changes.
export function subscribe(tmuxName: string, opts: CapturePaneOpts, onUpdate: Listener): () => void {
  const key = keyFor(tmuxName, opts);
  let loop = loops.get(key);

  if (!loop) {
    const newLoop: Loop = {
      interval: undefined as unknown as NodeJS.Timeout,
      listeners: new Set(),
      lastContent: null,
      lastSize: null,
      lastCapturedAt: 0,
      ansi: !!opts.ansi,
      tmuxName,
      stopped: false,
    };
    const tick = async () => {
      if (newLoop.stopped) return;
      try {
        const [content, size] = await Promise.all([tmuxCli.capturePane(tmuxName, opts), tmuxCli.getPaneSize(tmuxName)]);
        const sizeKey = size ? `${size.cols}x${size.rows}` : null;
        newLoop.lastCapturedAt = Date.now();
        if (content !== newLoop.lastContent || sizeKey !== newLoop.lastSize) {
          newLoop.lastContent = content;
          newLoop.lastSize = sizeKey;
          const update: PaneUpdate = {
            content,
            cols: size?.cols ?? 0,
            rows: size?.rows ?? 0,
            capturedAt: new Date().toISOString(),
          };
          for (const listener of newLoop.listeners) listener(update);
        }
      } catch {
        // Pane is gone (session killed mid-stream, ...) — tell everyone
        // once and stop polling; nothing left to watch.
        const update: PaneUpdate = { error: 'pane is no longer available' };
        for (const listener of newLoop.listeners) listener(update);
        newLoop.stopped = true;
        clearInterval(newLoop.interval);
        loops.delete(key);
      }
    };
    newLoop.interval = setInterval(() => void tick(), PANE_STREAM_INTERVAL_MS);
    loop = newLoop;
    loops.set(key, loop);
    void tick(); // paint immediately rather than waiting for the first interval tick
  }

  loop.listeners.add(onUpdate);

  // A subscriber joining a loop that's already running (not the one that
  // just created it above) would otherwise see nothing until the pane
  // content next actually changes — for an idle pane, that can be a long
  // wait or never. Paint it with whatever the loop last captured, same as
  // a freshly-created loop's own immediate tick() does.
  if (loop.lastContent !== null) {
    onUpdate({
      content: loop.lastContent,
      cols: loop.lastSize ? Number(loop.lastSize.split('x')[0]) : 0,
      rows: loop.lastSize ? Number(loop.lastSize.split('x')[1]) : 0,
      capturedAt: new Date().toISOString(),
    });
  }

  return () => {
    const current = loops.get(key);
    if (!current) return;
    current.listeners.delete(onUpdate);
    if (current.listeners.size === 0) {
      current.stopped = true;
      clearInterval(current.interval);
      loops.delete(key);
    }
  };
}

/**
 * What a running terminal view's loop captured with attributes (`-e`)
 * within the last `maxAgeMs`, so a reader that needs the bottom of the
 * screen with attributes (sync/cliSuggestion.ts) can reuse it instead of
 * capturing again. Null when no such loop is running or its capture is
 * older. Its content may reach back into history; the screen is its end.
 */
export function recentAnsiCapture(tmuxName: string, maxAgeMs: number, now: number = Date.now()): string | null {
  for (const loop of loops.values()) {
    if (loop.tmuxName !== tmuxName || !loop.ansi || loop.stopped || loop.lastContent === null) continue;
    if (now - loop.lastCapturedAt <= maxAgeMs) return loop.lastContent;
  }
  return null;
}

export function __resetForTests(): void {
  for (const loop of loops.values()) {
    loop.stopped = true;
    clearInterval(loop.interval);
  }
  loops.clear();
}
