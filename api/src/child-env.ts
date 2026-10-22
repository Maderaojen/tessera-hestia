// The API is started with `node --env-file=.env`, so its own
// environment carries the login credentials. Anything it spawns inherits
// that environment by default — and a tmux server it starts keeps a copy as
// its global environment, which every pane (every AI CLI this app launches)
// then inherits too. These names must never reach a child process.
export const SECRET_ENV_NAMES = [
  'AUTH_USERNAME',
  'AUTH_PASSWORD_HASH',
  'AUTH_LOCAL_USERS',
] as const;

/** A copy of `base` without the secret variables, for child processes. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of SECRET_ENV_NAMES) delete env[name];
  return env;
}

export type TmuxRunner = (args: string[]) => Promise<unknown>;

// tmux's wording when there is no server on the socket (or the socket file
// itself is missing); nothing to scrub then.
const NO_SERVER_RE = /no server running|error connecting to|No such file or directory/i;
// Unsetting a name the server never had is harmless; some tmux versions
// still complain about it.
const UNKNOWN_VARIABLE_RE = /unknown variable/i;

function errorText(error: unknown): string {
  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  return `${typeof stderr === 'string' ? stderr : ''}\n${typeof message === 'string' ? message : String(error)}`;
}

/**
 * Remove the secret variables from an already-running tmux server's global
 * environment, so panes created from now on no longer inherit them (a server
 * started before children got a scrubbed env still holds its copy).
 * Best-effort: no server means nothing to do; any other failure is logged
 * once and the rest are skipped.
 */
export async function scrubTmuxServerEnv(run: TmuxRunner, label = 'default'): Promise<void> {
  for (const name of SECRET_ENV_NAMES) {
    try {
      await run(['set-environment', '-g', '-u', name]);
    } catch (error) {
      const text = errorText(error);
      if (NO_SERVER_RE.test(text)) return;
      if (UNKNOWN_VARIABLE_RE.test(text)) continue;
      console.warn(`[tmux] could not clear secret env on the ${label} tmux server: ${text.trim()}`);
      return;
    }
  }
}
