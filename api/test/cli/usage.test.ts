import { describe, expect, it } from 'vitest';
import { CONVERSATION_USAGE } from '../../src/cli/conversation.js';
import { DELEGATE_USAGE } from '../../src/cli/delegate.js';
import { SSH_AUTHORIZE_USAGE } from '../../src/cli/sshAuthorize.js';
import { terminalQr } from '../../src/cli/terminalQr.js';
import { combinedUsage, usageContinued, usageNamed } from '../../src/cli/usage.js';

// The command's usage, put together from each subcommand's (main.ts), and
// the QR code `hestia pair` and `hestia ssh-authorize` both draw.

describe('usage texts', () => {
  it('names the command as this install calls it, and nothing else that says hestia', () => {
    expect(usageNamed('usage: hestia open [dir]\n       hestia pair', 'hestia-dev')).toBe('usage: hestia-dev open [dir]\n       hestia-dev pair');
    expect(usageNamed('see ~/.config/madera/hestia', 'hestia-dev')).toBe('see ~/.config/madera/hestia');
  });

  it('lines every subcommand up under the first usage line', () => {
    expect(usageContinued("usage: hestia ssh-authorize [--address HOST]\n       hestia ssh-authorize --public-key 'K'"))
      .toEqual(['       hestia ssh-authorize [--address HOST]', "       hestia ssh-authorize --public-key 'K'"]);
    const usage = combinedUsage(['usage: hestia open', DELEGATE_USAGE, CONVERSATION_USAGE, SSH_AUTHORIZE_USAGE], 'hestia');
    const lines = usage.split('\n');
    expect(lines[0]).toBe('usage: hestia open');
    expect(lines.filter((line) => line.startsWith('usage: '))).toHaveLength(1);
    // As main.ts put it together before: each subcommand's first line moved under the first.
    const before = [
      'usage: hestia open',
      DELEGATE_USAGE.replace('usage: ', '       '),
      CONVERSATION_USAGE.replace('usage: ', '       '),
      ...SSH_AUTHORIZE_USAGE.split('\n').map((line) => line.replace(/^(usage: | {7})/, '       ')),
    ].join('\n');
    expect(usage).toBe(before);
    expect(combinedUsage(['usage: hestia open'], 'hestia-dev')).toBe('usage: hestia-dev open');
  });
});

describe('terminalQr', () => {
  it('white on black for a terminal, plain for a file', () => {
    const coloured = terminalQr('hestia://x', { color: true });
    expect(coloured.length).toBeGreaterThan(5);
    expect(coloured.every((line) => line.startsWith('  \x1b[97;40m') && line.endsWith('\x1b[0m'))).toBe(true);
    const plain = terminalQr('hestia://x', { color: false });
    expect(plain.join('')).not.toContain('\x1b');
    expect(plain).toHaveLength(coloured.length);
  });
});
