// The `hestia` command's usage texts: each subcommand keeps its own
// (`usage: hestia …`, more lines indented under it), main.ts puts them
// together, and both are shown under the name this install's command goes
// by (hestia-dev for dev, config.ts COMMAND_NAME).

const INDENT = ' '.repeat('usage: '.length);

/** A usage text under the name this install's command goes by. */
export function usageNamed(usage: string, commandName: string): string {
  return usage.replace(/\bhestia (?=[a-z-])/g, `${commandName} `);
}

/** A subcommand's usage as lines under another `usage:` line: every line indented alike. */
export function usageContinued(usage: string): string[] {
  return usage.split('\n').map((line) => line.replace(/^(usage: | {7})/, INDENT));
}

/** The whole command's usage: the first line says `usage:`, the rest line up under it. */
export function combinedUsage(usages: string[], commandName: string): string {
  const lines = usages.flatMap(usageContinued);
  if (lines.length > 0) lines[0] = lines[0]!.replace(INDENT, 'usage: ');
  return usageNamed(lines.join('\n'), commandName);
}
