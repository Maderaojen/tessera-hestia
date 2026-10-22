// What a continuity handoff brief adds for features that live elsewhere (a
// delegate's "how to deliver", ADR 0015 決策 16). When continuity hands a
// session to another profile in the same tmux, the CLI taking over reads
// the brief — and nothing else — so a feature that gave the first CLI its
// own instructions registers them here, from its own wiring; continuity
// asks here and knows none of them (as services/tmux-env.ts does for the
// tmux's variables).

export type BriefAddendumSource = (sessionId: string) => Promise<string | null>;

const sources: BriefAddendumSource[] = [];

export function registerBriefAddendum(source: BriefAddendumSource): () => void {
  sources.push(source);
  return () => {
    const index = sources.indexOf(source);
    if (index >= 0) sources.splice(index, 1);
  };
}

/** Every registered addendum for this session, in order; null when none has one. One source failing leaves the others. */
export async function briefAddendumFor(sessionId: string): Promise<string | null> {
  const parts: string[] = [];
  for (const source of sources) {
    try {
      const part = (await source(sessionId))?.trim();
      if (part) parts.push(part);
    } catch (err) {
      console.warn(`[brief-addendum] reading the addendum for ${sessionId} failed`, err);
    }
  }
  return parts.length ? parts.join('\n\n') : null;
}
