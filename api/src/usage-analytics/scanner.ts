import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createUsageParser } from './parsers.js';
import type { Binding, Source } from './storage.js';
import type { openLedger } from './storage.js';

const MAX_LINE_BYTES = 1024 * 1024;
export async function scanSource(source: Source, ledger: ReturnType<typeof openLedger>, bindings: Binding[], warnings: Set<string>): Promise<number> {
  const root = await realpath(source.root);
  let scanned = 0;
  let files = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) { warnings.add('source_depth_limit'); return; }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { warnings.add('source_symlink_skipped'); continue; }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (++files > 50_000) { warnings.add('source_file_limit'); return; }
        await read(file);
      }
    }
  }
  async function read(file: string): Promise<void> {
    // Verify after discovery as a symlink may have replaced an entry.
    const stat = await lstat(file);
    const canonical = await realpath(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !canonical.startsWith(root + path.sep)) { warnings.add('source_symlink_skipped'); return; }
    const previous = ledger.cursor(file);
    const fileWarnings = new Set(previous?.warnings);
    const warn = (code: string) => { fileWarnings.add(code); warnings.add(code); };
    fileWarnings.forEach((code) => warnings.add(code));
    const inode = String(stat.ino);
    if (previous && previous.inode === inode && previous.size === stat.size && previous.mtime === stat.mtimeMs) {
      previous.state.warnings.forEach((w) => warnings.add(w)); if (previous.offset < previous.size) warnings.add('incomplete_jsonl_tail'); return;
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if ((await handle.stat()).ino !== stat.ino) { await handle.close(); warnings.add('source_changed_during_scan'); return; }
    const prefixLength = previous?.prefixLength ?? 0;
    const prefix = Buffer.alloc(Math.max(4096, prefixLength));
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
    const hash = (length: number) => createHash('sha256').update(prefix.subarray(0, length)).digest('hex');
    const append = previous && previous.inode === inode && stat.size > previous.size && previous.prefixHash !== undefined && prefixRead.bytesRead >= prefixLength && hash(prefixLength) === previous.prefixHash;
    if (previous && stat.size > previous.size && !append) warn('source_rewritten');
    const parser = createUsageParser(source.provider, path.basename(file, '.jsonl'), append ? previous.state : undefined);
    let offset = append ? previous.offset : 0;
    let committedOffset = offset;
    let pending = Buffer.alloc(0);
    let skipping = false;
    let processed = 0;
    const batch: (() => void)[] = [];
    const flush = () => { ledger.transaction(() => { for (const write of batch) write(); }); batch.length = 0; };
    try {
      while (true) {
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        let start = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (chunk[i] !== 10) continue;
          const piece = chunk.subarray(start, i);
          if (pending.length + piece.length > MAX_LINE_BYTES) skipping = true;
          if (!skipping) {
            const line = pending.length ? Buffer.concat([pending, piece]).toString('utf8') : piece.toString('utf8');
            if (line.trim()) {
              try {
                const event = parser.parse(JSON.parse(line));
                if (event && event.input + event.output + event.cached + event.cacheWrite > 0) {
                  const matching = bindings.filter((b) => b.provider === event.provider && b.sessionId === event.sessionId && Date.parse(event.timestamp) >= Date.parse(b.startedAt) && (!b.endedAt || Date.parse(event.timestamp) < Date.parse(b.endedAt)) && b.accountId === source.accountId);
                  const binding = matching.length === 1 ? matching[0] : null;
                  batch.push(() => { const warning = ledger.upsert({ ...event, accountId: source.accountId, sourceId: source.id,
                    projectId: binding?.projectId ?? null, projectLabel: binding?.projectLabel ?? null,
                    tmuxId: binding?.tmuxId ?? null, tmuxLabel: binding?.tmuxLabel ?? null }); if (warning) warn(warning); });
                  if (matching.length > 1) warn('ambiguous_session_binding');
                }
              } catch (error) {
                if (error instanceof SyntaxError) warn('malformed_jsonl'); else throw error;
              }
            }
          } else warn('oversize_jsonl_skipped');
          pending = Buffer.alloc(0); skipping = false; start = i + 1;
          committedOffset = offset - bytesRead + i + 1;
          if (++processed % 250 === 0) await setImmediate();
        }
        const remainder = chunk.subarray(start, bytesRead);
        if (!skipping && pending.length + remainder.length <= MAX_LINE_BYTES) pending = Buffer.concat([pending, remainder]);
        else { pending = Buffer.alloc(0); skipping = true; }
        flush();
        await setImmediate();
      }
      if (pending.length || skipping) warnings.add('incomplete_jsonl_tail');
      parser.warnings.forEach((w) => warnings.add(w));
      // Events are committed before the cursor. A crash replays deduplicated
      // events; it can never advance past usage not durably stored.
      ledger.saveCursor(file, { offset: committedOffset, size: stat.size, mtime: stat.mtimeMs, inode, state: parser.snapshot(), prefixLength: Math.min(committedOffset, 4096), prefixHash: hash(Math.min(committedOffset, 4096)), warnings: [...fileWarnings] });
      scanned++;
    } finally { await handle.close(); }
  }
  await walk(root, 0);
  return scanned;
}
