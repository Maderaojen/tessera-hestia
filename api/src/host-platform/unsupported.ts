import { parsePidPpidCommArgs, runCommand } from './shared.js';
import type { CommandRunner, HostPlatform } from './types.js';

/**
 * Anything that is neither Linux nor macOS (native Windows has no tmux:
 * run the backend in WSL, which is Linux). The process table is read the
 * POSIX way and nothing is inspected, so identity observers stay pending
 * instead of guessing.
 */
export function createUnsupportedPlatform(deps: { run?: CommandRunner } = {}): HostPlatform {
  const run = deps.run ?? runCommand;
  return {
    id: 'unsupported',
    processes: {
      async list() {
        return parsePidPpidCommArgs(await run('ps', ['-e', '-o', 'pid=,ppid=,comm=,args=']));
      },
      async paneCommand(reported) {
        return reported;
      },
    },
    inspector: { inspect: async () => ({ status: 'unavailable' }) },
    tmuxServer: { detached: async () => null },
    service: { restartCommand: () => null },
    sshd: { remoteLoginSetting: false },
  };
}
