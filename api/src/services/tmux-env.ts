// Variables a session's tmux carries for features that live elsewhere
// (a delegate's HESTIA_DELEGATION_ID, ADR 0015 決策 14). When the app makes
// a tmux again for a session it already has (recovering a dead one, a
// switch that finds its tmux gone), it asks here, so the new tmux carries
// what the first one did. Those features register themselves from their own
// wiring; this module knows none of them.

export type TmuxEnvSource = (sessionId: string) => Promise<Record<string, string>>;

const sources: TmuxEnvSource[] = [];

export function registerTmuxEnv(source: TmuxEnvSource): () => void {
  sources.push(source);
  return () => {
    const index = sources.indexOf(source);
    if (index >= 0) sources.splice(index, 1);
  };
}

/** Every registered variable for this session; one source failing leaves the others. */
export async function tmuxEnvFor(sessionId: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const source of sources) {
    try {
      Object.assign(env, await source(sessionId));
    } catch (err) {
      console.warn(`[tmux-env] reading the variables for ${sessionId} failed`, err);
    }
  }
  return env;
}
