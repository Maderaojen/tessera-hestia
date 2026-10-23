import { renderUnicodeCompact } from 'uqr';

// A QR code drawn in the terminal, for `hestia pair` and `hestia
// ssh-authorize`. White modules on black, set explicitly: the compact
// renderer draws the light parts, so on a light-themed terminal it would
// come out inverted, which many phone cameras won't read. Only for a
// terminal (`color`): in a file the escapes would be noise.
export function terminalQr(text: string, options: { color: boolean }): string[] {
  return renderUnicodeCompact(text, { border: 2 }).split('\n')
    .map((line) => (options.color ? `  \x1b[97;40m${line}\x1b[0m` : line));
}
