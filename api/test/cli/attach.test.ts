import { describe, expect, it } from 'vitest';
import { attachCommand } from '../../src/cli/attach.js';

const session = { tmuxName: 'hestia-1', tmuxSocket: 'hestia' };

describe('hestia open: attaching', () => {
  it("attaches on the session's own server from a plain terminal", () => {
    const { command, env } = attachCommand(session, { PATH: '/bin' });
    expect(command).toEqual(['-L', 'hestia', 'attach-session', '-t', 'hestia-1']);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('switches the client when already in a tmux on that server', () => {
    const { command } = attachCommand(session, { TMUX: '/tmp/tmux-1000/hestia,123,0' });
    expect(command).toEqual(['-L', 'hestia', 'switch-client', '-t', 'hestia-1']);
  });

  it('attaches as a nested client from a tmux on another server', () => {
    const { command, env } = attachCommand(session, { TMUX: '/tmp/tmux-1000/default,123,0', PATH: '/bin' });
    expect(command).toEqual(['-L', 'hestia', 'attach-session', '-t', 'hestia-1']);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('uses the default server for a session opened before the own socket', () => {
    expect(attachCommand({ tmuxName: 'hestia-0', tmuxSocket: null }, { TMUX: '/tmp/tmux-1000/default,1,0' }).command)
      .toEqual(['switch-client', '-t', 'hestia-0']);
    expect(attachCommand({ tmuxName: 'hestia-0' }, {}).command).toEqual(['attach-session', '-t', 'hestia-0']);
  });
});
