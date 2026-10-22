import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { observeAgySession } from '../src/runtimes/agy.js';
import { codexCliRuntime, observeCodexSession } from '../src/runtimes/codex-cli.js';
import { inspectProcess, openFilesIn } from '../src/runtimes/process-evidence.js';

// Real processes, not mocked /proc: a copy of the shell named like the CLI
// (so /proc comm and exe match) inheriting open descriptors on the files
// the CLI would hold, waiting on a stdin nothing writes to. This exercises
// the same evidence path production uses. Not a copy of `sleep`: from
// Ubuntu 25.10 that is Rust coreutils' one binary for every command, which
// picks the command by its own file name and quits under any other (seen
// on GitHub's ubuntu-26.04 runners, 2026-10-20).
const linux = process.platform === 'linux';
const SHELL = ['/usr/bin/dash', '/bin/dash', '/bin/sh'].find((candidate) => { try { openSync(candidate, 'r'); return true; } catch { return false; } });
const ID = '01a0d313-7e06-7152-8a0a-02677506d4dd';
const OTHER = '01a0d329-fac1-7e33-a94e-4b0ebca070be';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-identity-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Start `<dir>/<name>` (a copy of the shell) holding the given files open. */
async function startHolding(dir: string, name: string, files: string[]): Promise<ChildProcess> {
  const binary = path.join(dir, name);
  copyFileSync(SHELL!, binary);
  const fds = files.map((file) => openSync(file, 'r'));
  // The shell's own `read`, so no other process holds the files too.
  const child = spawn(binary, ['-c', 'read _'], { stdio: ['pipe', 'ignore', 'ignore', ...fds] });
  for (const fd of fds) closeSync(fd);
  cleanups.push(() => child.kill('SIGKILL'));
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  // Wait for exec to land so /proc shows the new comm.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const view = await inspectProcess(child.pid!, (v) => v.comm);
    if (view.status === 'observed' && view.value === name) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return child;
}

function codexHome(): { home: string; lock: (id: string) => string } {
  const home = scratch();
  mkdirSync(path.join(home, 'thread-writer-locks'));
  return {
    home,
    lock: (id) => {
      const file = path.join(home, 'thread-writer-locks', `${id}.lock`);
      writeFileSync(file, '');
      return file;
    },
  };
}

describe.skipIf(!linux || !SHELL)('runtime identity evidence from live processes', () => {
  it('reads a process\'s own open files and fences the view by start time', async () => {
    const dir = scratch();
    const file = path.join(dir, 'held.txt');
    writeFileSync(file, 'x');
    const child = await startHolding(dir, 'holder', [file]);
    const inspection = await inspectProcess(child.pid!, (view) => ({ comm: view.comm, held: openFilesIn(view.openFiles, dir) }));
    expect(inspection).toEqual({ status: 'observed', value: { comm: 'holder', held: [file] } });
    expect(await inspectProcess(2 ** 22 + 12345, () => null)).toEqual({ status: 'unavailable' });
  });

  it('resolves Codex identity from exactly one thread lock held by the codex process', async () => {
    const { home, lock } = codexHome();
    const child = await startHolding(scratch(), 'codex', [lock(ID)]);
    expect(await observeCodexSession({ pid: child.pid!, home }))
      .toEqual({ status: 'resolved', providerSessionId: ID, evidence: 'process_thread_lock' });
    // Through the driver capability, with the launch snapshot's home.
    expect(codexCliRuntime.identity.kind).toBe('observed_after_start');
    if (codexCliRuntime.identity.kind !== 'observed_after_start') return;
    const viaDriver = await codexCliRuntime.identity.observe({
      pid: child.pid!,
      startedAt: new Date(0).toISOString(),
      profile: { id: 'native:codex', provider: 'codex', runtimeId: 'codex-cli', source: 'native', home, delegate: { kind: 'native', executable: 'codex' } },
    });
    expect(viaDriver).toMatchObject({ status: 'resolved', providerSessionId: ID });
  });

  it('reports a codex holding no lock (shared daemon) or two locks (/clear) as unobservable', async () => {
    const { home, lock } = codexHome();
    lock(ID);
    const none = await startHolding(scratch(), 'codex', []);
    expect(await observeCodexSession({ pid: none.pid!, home }))
      .toEqual({ status: 'unobservable', reason: 'holds 0 thread locks (need exactly 1)' });
    const two = await startHolding(scratch(), 'codex', [lock(ID), lock(OTHER)]);
    expect(await observeCodexSession({ pid: two.pid!, home }))
      .toEqual({ status: 'unobservable', reason: 'holds 2 thread locks (need exactly 1)' });
  });

  it('never takes a lock held by a process that is not codex', async () => {
    const { home, lock } = codexHome();
    const other = await startHolding(scratch(), 'node', [lock(ID)]);
    expect(await observeCodexSession({ pid: other.pid!, home })).toEqual({ status: 'pending', reason: 'foreground_process_is_not_codex' });
  });

  it('resolves Agy identity only from one open, metadata-verified conversation DB', async () => {
    const root = scratch();
    const db = (file: string, cascadeId: string) => {
      const handle = new DatabaseSync(file);
      handle.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT)');
      handle.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('t', cascadeId);
      handle.close();
      return file;
    };
    const good = db(path.join(root, `${ID}.db`), ID);
    const child = await startHolding(scratch(), 'agy', [good]);
    expect(await observeAgySession({ pid: child.pid!, conversationRoot: root }))
      .toEqual({ status: 'resolved', providerSessionId: ID, evidence: 'process_fd_and_db_metadata' });

    const idle = await startHolding(scratch(), 'agy', []);
    expect(await observeAgySession({ pid: idle.pid!, conversationRoot: root })).toEqual({ status: 'pending', reason: 'conversation_db_not_open' });

    const conflicting = db(path.join(root, `${OTHER}.db`), ID); // filename and cascade_id disagree
    const liar = await startHolding(scratch(), 'agy', [conflicting]);
    expect(await observeAgySession({ pid: liar.pid!, conversationRoot: root })).toEqual({ status: 'ambiguous', reason: 'conflicting_db_metadata' });

    const both = await startHolding(scratch(), 'agy', [good, conflicting]);
    expect(await observeAgySession({ pid: both.pid!, conversationRoot: root })).toEqual({ status: 'ambiguous', reason: 'multiple_open_conversation_dbs' });
  });

  it('never takes an Agy conversation DB created before the segment began', async () => {
    // Agy 1.2.12 opens an old, unrelated conversation behind its trust prompt.
    const root = scratch();
    const file = path.join(root, `${ID}.db`);
    const handle = new DatabaseSync(file);
    handle.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT)');
    handle.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('t', ID);
    handle.close();
    const child = await startHolding(scratch(), 'agy', [file]);
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await observeAgySession({ pid: child.pid!, conversationRoot: root, notBefore: later }))
      .toEqual({ status: 'pending', reason: 'open_conversation_db_predates_launch' });
    const earlier = new Date(Date.now() - 60_000).toISOString();
    expect(await observeAgySession({ pid: child.pid!, conversationRoot: root, notBefore: earlier }))
      .toMatchObject({ status: 'resolved', providerSessionId: ID });
  });
});
