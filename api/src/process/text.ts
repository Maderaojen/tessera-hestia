import path from 'node:path';
import type { ProcessItemDetail } from './types.js';

// Each detail field is cut here: a command's output can run to megabytes.
export const DETAIL_MAX_CHARS = 256 * 1024;

export function clip(text: string, max = DETAIL_MAX_CHARS): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

export function clipDetail(detail: Omit<ProcessItemDetail, 'truncated' | 'originalBytes'>): ProcessItemDetail {
  const out: ProcessItemDetail = { truncated: false };
  if (detail.exitCode !== undefined) out.exitCode = detail.exitCode;
  if (detail.images) out.images = detail.images;
  for (const key of ['input', 'output', 'diff', 'thinking'] as const) {
    const value = detail[key];
    if (value === undefined) continue;
    if (value === null) {
      if (key === 'thinking') out.thinking = null;
      continue;
    }
    const clipped = clip(value);
    if (clipped.truncated) {
      out.truncated = true;
      out.originalBytes = Math.max(out.originalBytes ?? 0, Buffer.byteLength(value));
    }
    out[key] = clipped.text;
  }
  return out;
}

// A path as the user thinks of it: relative to the folder the CLI was in,
// when it is inside it.
export function relativeTo(file: string, cwd: string | null): string {
  if (!cwd || !path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

// An edit given as old and new text, as a minimal unified-looking diff
// (no context lines: the CLI's input has none).
export function linesDiff(name: string, before: string, after: string): string {
  const minus = before === '' ? [] : before.split('\n').map((line) => `-${line}`);
  const plus = after === '' ? [] : after.split('\n').map((line) => `+${line}`);
  return [`--- ${name}`, `+++ ${name}`, ...minus, ...plus].join('\n');
}

// Claude's toolUseResult.structuredPatch: hunks with their own lines,
// already prefixed with ' ', '-' or '+'.
export function structuredPatchDiff(name: string, hunks: unknown[]): string {
  const lines = [`--- ${name}`, `+++ ${name}`];
  for (const hunk of hunks) {
    if (!hunk || typeof hunk !== 'object') continue;
    const h = hunk as Record<string, unknown>;
    lines.push(`@@ -${String(h.oldStart ?? '?')},${String(h.oldLines ?? '?')} +${String(h.newStart ?? '?')},${String(h.newLines ?? '?')} @@`);
    if (Array.isArray(h.lines)) for (const line of h.lines) if (typeof line === 'string') lines.push(line);
  }
  return lines.join('\n');
}
