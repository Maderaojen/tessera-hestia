import path from 'node:path';

/**
 * How `hestia open` puts the terminal on a session's tmux. Inside a tmux on
 * that same server it switches the client over; anywhere else (no tmux, or
 * a tmux on another server — the user's default one, say) it attaches, with
 * TMUX cleared so tmux allows the nested client.
 */
export function attachCommand(
  session: { tmuxName: string; tmuxSocket?: string | null },
  env: NodeJS.ProcessEnv,
): { command: string[]; env: NodeJS.ProcessEnv } {
  const socket = session.tmuxSocket ?? null;
  const server = socket ? ['-L', socket] : [];
  // $TMUX is "<socket path>,<pid>,<session index>"; a `-L name` server's
  // socket file is named after it, the default one `default`.
  const current = env.TMUX ? path.basename(env.TMUX.split(',')[0] ?? '') : null;
  if (current !== null && current === (socket ?? 'default')) {
    return { command: [...server, 'switch-client', '-t', session.tmuxName], env };
  }
  const rest = { ...env };
  delete rest.TMUX;
  return { command: [...server, 'attach-session', '-t', session.tmuxName], env: rest };
}
