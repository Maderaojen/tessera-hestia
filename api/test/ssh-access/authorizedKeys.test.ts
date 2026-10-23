import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addOneTimeLine,
  applyEdit,
  authorizeKey,
  expiryTime,
  hestiaPermitOpens,
  isExpiredOneTimeLine,
  joinLines,
  KeyFileError,
  lockPath,
  onlyEdited,
  oneTimeLine,
  parseKeyLine,
  parsePublicKey,
  planAuthorize,
  removeOneTimeLine,
  safeComment,
  splitLines,
  withKeyFileLock,
  type KeyFiles,
} from '../../src/ssh-access/authorizedKeys.js';

// Every file here is under a fresh temporary directory: never ~/.ssh.

// ssh-keygen output (keys made for these tests only).
const PHONE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJhX2VybVRXe2xun4hFTTx/w5QMT4Up2B7e6/FphBP6p phone';
const PHONE_FP = 'SHA256:uPG2mGtpMXuWtO+XxYmrc5w+HZtd2E/TZQ4PsC3lZVE';
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB+Nh/1mdBbj0I7hdK8Fjs2R7PwuE0nSp53W/r8qClpq other';
const RSA_2048 = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCwSEA+ov/Fb6gEQyrzeAWvnv7TCldsSylNgoxWjKbKdHxj4YI+La1qI/UWvSaHcO2kVmGKrE+Hk+IwhIUTMjoFlxi5oVXP27Nk6MwcdakJbDHt68cBGbEhbihDEtnMLtwU/tg2TKOOUUXtfdfwh7qkm72zgbEj+wrAQKcr9sIEyVQZvG80IbxReqD4hpIO6qQOYxItpEBVU85wZZuzlrmQzVyzbXMvzoX1ZRmdG9ruuIE0RIe84JGacjUlBpKPgCtpEyli36rhLyRRX8LGD7v6Dh6u/gpiWGfFN7LTgQxtroWInXyiijtQmjtDee9iROG36O5vi7yVAMHEsR+XgfVt rsa2048';
const RSA_2048_FP = 'SHA256:DV1vJVid7mVjYO0Y1Rwop6B01jInQ7P+qJ6JTK4Cqdo';
const RSA_1024 = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQCVLjs6652vOh6FVPgYn3xFN8HTyRa47lywWUa1B88ZPsoUxXyl6mINx6gqRHE0vGCWe1FpQk696Vk7SCFPvAJ2kKiAAKt0ocW0hLqu73RX0ZDbPionfmES02zqaK4SVlmZVqCCvvqw8/k93hRgeLY27EO0Fr71HaeQc1MltAbJKQ== rsa1024';

const key = (line: string) => parsePublicKey(line)!;
const body = (line: string) => line.split(' ').slice(0, 2).join(' ');
const NOW = new Date('2026-10-22T08:00:00Z');

describe('parsePublicKey', () => {
  it('takes ed25519 and RSA of 2048 bits or more, with ssh-keygen’s fingerprint', () => {
    expect(parsePublicKey(PHONE)).toMatchObject({ type: 'ssh-ed25519', bits: 256, fingerprint: PHONE_FP });
    expect(parsePublicKey(RSA_2048)).toMatchObject({ type: 'ssh-rsa', bits: 2048, fingerprint: RSA_2048_FP });
    expect(parsePublicKey(body(PHONE))).not.toBeNull();
  });

  it('turns down short RSA keys, other types, and blobs that don’t match their type', () => {
    expect(parsePublicKey(RSA_1024)).toBeNull();
    expect(parsePublicKey('ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY= x')).toBeNull();
    // An ed25519 blob called ssh-rsa, and the other way round.
    expect(parsePublicKey(`ssh-rsa ${PHONE.split(' ')[1]}`)).toBeNull();
    expect(parsePublicKey(`ssh-ed25519 ${RSA_2048.split(' ')[1]}`)).toBeNull();
    // Truncated, padded oddly, not base64.
    expect(parsePublicKey(`ssh-ed25519 ${PHONE.split(' ')[1]!.slice(0, 40)}`)).toBeNull();
    expect(parsePublicKey('ssh-ed25519 !!!!')).toBeNull();
    expect(parsePublicKey('')).toBeNull();
  });
});

describe('safeComment', () => {
  it('keeps the name readable and nothing that could end the line or add options', () => {
    expect(safeComment('hestia-iPhone')).toBe('hestia-iPhone');
    expect(safeComment('Jen 的 iPhone')).toBe('Jen-的-iPhone');
    expect(safeComment('x\nrestrict ssh-ed25519 AAAA')).toBe('x-restrict-ssh-ed25519-AAAA');
    expect(safeComment('a"b,c\r\0d')).toBe('abc-d');
    expect(safeComment('\n\n')).toBe('hestia');
    expect(safeComment('x'.repeat(200))).toHaveLength(64);
  });
});

describe('parseKeyLine and options', () => {
  it('splits options (quoted spaces and commas too), the key and the comment', () => {
    expect(parseKeyLine(PHONE)).toMatchObject({ options: null, type: 'ssh-ed25519', comment: 'phone' });
    const line = parseKeyLine(`command="echo a b, c",from="10.0.0.1" ${PHONE}`)!;
    expect(line.options).toBe('command="echo a b, c",from="10.0.0.1"');
    expect(line.type).toBe('ssh-ed25519');
    expect(parseKeyLine('# comment')).toBeNull();
    expect(parseKeyLine('   ')).toBeNull();
    expect(parseKeyLine('command="unterminated ssh-ed25519 AAAA')).toBeNull();
  });

  it('recognizes only the lines Hestia writes', () => {
    expect(hestiaPermitOpens('restrict,port-forwarding,permitopen="127.0.0.1:4791"')).toEqual(['127.0.0.1:4791']);
    expect(hestiaPermitOpens('restrict,port-forwarding,permitopen="127.0.0.1:4791",permitopen="127.0.0.1:4792"')).toEqual(['127.0.0.1:4791', '127.0.0.1:4792']);
    expect(hestiaPermitOpens('restrict,port-forwarding')).toEqual([]);
    expect(hestiaPermitOpens('restrict,port-forwarding,command="x"')).toBeNull();
    expect(hestiaPermitOpens('port-forwarding,permitopen="127.0.0.1:4791"')).toBeNull();
    expect(hestiaPermitOpens('restrict,restrict,port-forwarding')).toBeNull();
  });
});

describe('planAuthorize', () => {
  const plan = (content: string, port = 4792) => {
    const lines = splitLines(content);
    const outcome = planAuthorize(lines, key(PHONE), port, 'hestia-phone');
    return { outcome, after: joinLines(applyEdit(lines, outcome.edit)) };
  };

  it('adds a restricted line to an empty or missing file', () => {
    const { outcome, after } = plan('');
    expect(outcome.result).toBe('added');
    expect(after).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:4792" ${body(PHONE)} hestia-phone\n`);
  });

  it('appends after other lines, giving a last line without a newline its newline', () => {
    const { after } = plan(`${OTHER}`);
    expect(after).toBe(`${OTHER}\nrestrict,port-forwarding,permitopen="127.0.0.1:4792" ${body(PHONE)} hestia-phone\n`);
  });

  it('keeps CRLF files CRLF', () => {
    const { after } = plan(`# mine\r\n${OTHER}\r\n`);
    expect(after).toBe(`# mine\r\n${OTHER}\r\nrestrict,port-forwarding,permitopen="127.0.0.1:4792" ${body(PHONE)} hestia-phone\r\n`);
  });

  it('adds the port to a line Hestia wrote, leaving its comment and the rest alone', () => {
    const before = `# top\n\n  restrict,port-forwarding,permitopen="127.0.0.1:4791" ${body(PHONE)} my  old\tname\n${OTHER}\n`;
    const { outcome, after } = plan(before);
    expect(outcome.result).toBe('merged');
    expect(after).toBe(`# top\n\n  restrict,port-forwarding,permitopen="127.0.0.1:4791",permitopen="127.0.0.1:4792" ${body(PHONE)} my  old\tname\n${OTHER}\n`);
  });

  it('writes nothing when the port is already allowed', () => {
    const before = `restrict,port-forwarding,permitopen="127.0.0.1:4791",permitopen="127.0.0.1:4792" ${PHONE}\n`;
    const { outcome, after } = plan(before);
    expect(outcome.result).toBe('merged');
    expect(outcome.edit).toEqual({ remove: [], replace: new Map(), append: [] });
    expect(after).toBe(before);
  });

  it('leaves an unrestricted line alone and suggests the restricted one', () => {
    const { outcome, after } = plan(`${PHONE}\n`);
    expect(outcome).toMatchObject({ result: 'present_unrestricted', suggested: `restrict,port-forwarding,permitopen="127.0.0.1:4792" ${body(PHONE)} hestia-phone` });
    expect(after).toBe(`${PHONE}\n`);
  });

  it('leaves a line with other options alone', () => {
    const before = `from="10.0.0.0/8",restrict,port-forwarding,permitopen="127.0.0.1:4791" ${PHONE}\n`;
    expect(plan(before).outcome.result).toBe('present_other');
    expect(plan(before).after).toBe(before);
  });

  it('leaves the key alone when it is on more than one line', () => {
    const before = `restrict,port-forwarding,permitopen="127.0.0.1:4791" ${PHONE}\nrestrict,port-forwarding,permitopen="127.0.0.1:4793" ${PHONE}\n`;
    expect(plan(before).outcome.result).toBe('present_other');
    expect(plan(before).after).toBe(before);
  });

  it('matches by the key itself, not its comment', () => {
    const { outcome } = plan(`${body(PHONE)} renamed-on-the-server\n`);
    expect(outcome.result).toBe('present_unrestricted');
  });
});

describe('onlyEdited', () => {
  const before = `# a\n${OTHER}\r\n\nlast`;

  it('accepts exactly the planned edit', () => {
    const edit = { remove: [0], replace: new Map([[1, 'x']]), append: ['new'] };
    const after = joinLines(applyEdit(splitLines(before), edit));
    expect(after).toBe(`x\r\n\nlast\nnew\n`);
    expect(onlyEdited(before, after, edit)).toBe(true);
  });

  it('catches any other change: a byte, a line ending, an order, a missing or extra line', () => {
    const edit = { remove: [], replace: new Map<number, string>(), append: ['new'] };
    const good = `# a\n${OTHER}\r\n\nlast\nnew\n`;
    expect(onlyEdited(before, good, edit)).toBe(true);
    expect(onlyEdited(before, good.replace('# a', '# b'), edit)).toBe(false);
    expect(onlyEdited(before, good.replace('\r\n', '\n'), edit)).toBe(false);
    expect(onlyEdited(before, `${OTHER}\r\n# a\n\nlast\nnew\n`, edit)).toBe(false);
    expect(onlyEdited(before, `# a\n\nlast\nnew\n`, edit)).toBe(false);
    expect(onlyEdited(before, `${good}extra\n`, edit)).toBe(false);
    expect(onlyEdited(before, `# a\n${OTHER}\r\n\nlast\nnew`, edit)).toBe(false);
  });
});

describe('one-time lines', () => {
  it('can only forward to the listener, and expire', () => {
    const line = oneTimeLine('AAAA', 51234, new Date('2026-10-22T08:03:10Z'), 'hestia-authorize-x');
    // Rounded up to the minute, in UTC.
    expect(line).toBe('restrict,port-forwarding,permitopen="127.0.0.1:51234",expiry-time="202610220804Z" ssh-ed25519 AAAA hestia-authorize-x');
    expect(expiryTime(new Date('2026-01-02T03:04:59Z'))).toBe('202601020304Z');
  });

  it('is expired once its expiry-time has passed, and only if it is one of ours', () => {
    const line = oneTimeLine('AAAA', 1, new Date('2026-10-22T08:00:00Z'), 'hestia-authorize-x');
    expect(isExpiredOneTimeLine(line, new Date('2026-10-22T07:59:00Z'))).toBe(false);
    expect(isExpiredOneTimeLine(line, new Date('2026-10-22T08:00:00Z'))).toBe(true);
    expect(isExpiredOneTimeLine(line.replace('hestia-authorize-x', 'someone-else'), NOW)).toBe(false);
    expect(isExpiredOneTimeLine('expiry-time="20200101" ssh-ed25519 AAAA mine', NOW)).toBe(false);
  });

  it('is a line ssh-keygen reads', () => {
    let hasKeygen = true;
    try {
      execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    } catch (error) {
      hasKeygen = (error as { status?: number }).status !== undefined;
    }
    if (!hasKeygen) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hestia-keygen-'));
    try {
      const file = path.join(dir, 'authorized_keys');
      writeFileSync(file, `${oneTimeLine(PHONE.split(' ')[1]!, 4000, NOW, 'hestia-authorize-x')}\n`);
      expect(execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' })).toContain(PHONE_FP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the file', () => {
  let home: string;
  let files: KeyFiles;
  const file = () => path.join(files.sshDir, 'authorized_keys');
  const uid = process.getuid!();

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'hestia-authorized-'));
    files = { sshDir: path.join(home, '.ssh'), uid };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const leftovers = () => readdirSync(files.sshDir).filter((name) => name !== 'authorized_keys');

  it('creates ~/.ssh (0700) and the file (0600) when missing', async () => {
    const outcome = await authorizeKey(files, key(PHONE), 4791, 'hestia-phone', NOW);
    expect(outcome.result).toBe('added');
    expect(lstatSync(files.sshDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(file()).mode & 0o777).toBe(0o600);
    expect(readFileSync(file(), 'utf8')).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:4791" ${body(PHONE)} hestia-phone\n`);
    expect(leftovers()).toEqual([]);
  });

  it('keeps the original mode and every other byte', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    const before = `# keys\r\n${OTHER}\r\n\n\tcommand="a b" ${RSA_2048}`;
    writeFileSync(file(), before);
    chmodSync(file(), 0o644);
    await authorizeKey(files, key(PHONE), 4791, 'hestia-phone', NOW);
    const after = readFileSync(file(), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(`\r\nrestrict,port-forwarding,permitopen="127.0.0.1:4791" ${body(PHONE)} hestia-phone\r\n`);
    expect(lstatSync(file()).mode & 0o777).toBe(0o644);
  });

  it('stops on a file group or others can write, and says the chmod', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    writeFileSync(file(), `${OTHER}\n`);
    chmodSync(file(), 0o664);
    const error = await authorizeKey(files, key(PHONE), 4791, 'x', NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyFileError);
    expect(error).toMatchObject({ code: 'file_mode', chmod: `chmod go-w ${file()}` });
    expect(readFileSync(file(), 'utf8')).toBe(`${OTHER}\n`);
    expect(lstatSync(file()).mode & 0o777).toBe(0o664);
  });

  it('stops on a ~/.ssh group or others can write, changing nothing', async () => {
    mkdirSync(files.sshDir);
    chmodSync(files.sshDir, 0o775);
    await expect(authorizeKey(files, key(PHONE), 4791, 'x', NOW)).rejects.toMatchObject({ code: 'ssh_dir_mode', chmod: `chmod go-w ${files.sshDir}` });
    expect(lstatSync(files.sshDir).mode & 0o777).toBe(0o775);
    expect(existsSync(file())).toBe(false);
  });

  it('stops on another owner', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    writeFileSync(file(), '');
    await expect(authorizeKey({ ...files, uid: uid + 1 }, key(PHONE), 4791, 'x', NOW)).rejects.toMatchObject({ code: 'ssh_dir_owner' });
  });

  it('stops on a symbolic link, leaving its target alone', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    const target = path.join(home, 'elsewhere');
    writeFileSync(target, `${OTHER}\n`);
    symlinkSync(target, file());
    await expect(authorizeKey(files, key(PHONE), 4791, 'x', NOW)).rejects.toMatchObject({ code: 'file_symlink' });
    expect(readFileSync(target, 'utf8')).toBe(`${OTHER}\n`);
    expect(lstatSync(file()).isSymbolicLink()).toBe(true);
  });

  it('stops on a symbolic-link ~/.ssh', async () => {
    const real = path.join(home, 'real-ssh');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, files.sshDir);
    await expect(authorizeKey(files, key(PHONE), 4791, 'x', NOW)).rejects.toMatchObject({ code: 'ssh_dir_symlink' });
    expect(readdirSync(real)).toEqual([]);
  });

  it('adds a one-time line, cleans expired ones from earlier runs, and removes it again', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    const stale = oneTimeLine('AAAAC3NzaC1lZDI1NTE5AAAAIB+Nh/1mdBbj0I7hdK8Fjs2R7PwuE0nSp53W/r8qClpq', 1, new Date('2026-10-22T07:00:00Z'), 'hestia-authorize-old');
    const live = oneTimeLine('AAAAC3NzaC1lZDI1NTE5AAAAIB+Nh/1mdBbj0I7hdK8Fjs2R7PwuE0nSp53W/r8qClpq', 2, new Date('2026-10-22T08:10:00Z'), 'hestia-authorize-other-run');
    writeFileSync(file(), `${OTHER}\n${stale}\n${live}\n`);
    const mine = oneTimeLine(PHONE.split(' ')[1]!, 3, new Date('2026-10-22T08:03:00Z'), 'hestia-authorize-mine');
    const added = await addOneTimeLine(files, mine, NOW);
    expect(added.cleaned).toBe(1);
    expect(readFileSync(file(), 'utf8')).toBe(`${OTHER}\n${live}\n${mine}\n`);
    const removed = await removeOneTimeLine(files, 'hestia-authorize-mine', NOW);
    expect(removed.removed).toBe(1);
    // Another run's line that hasn't expired stays.
    expect(readFileSync(file(), 'utf8')).toBe(`${OTHER}\n${live}\n`);
    expect(leftovers()).toEqual([]);
  });

  it('an interrupted write leaves the old file whole and no temporary file behind', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    writeFileSync(file(), `${OTHER}\n`);
    const ops = { rename: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    await expect(authorizeKey(files, key(PHONE), 4791, 'x', NOW, { ops })).rejects.toThrow('EIO');
    expect(readFileSync(file(), 'utf8')).toBe(`${OTHER}\n`);
    expect(leftovers()).toEqual([]);
    // And the lock was let go: the next run goes through.
    expect((await authorizeKey(files, key(PHONE), 4791, 'x', NOW)).result).toBe('added');
  });

  it('doesn’t overwrite an edit someone made while it was writing', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    writeFileSync(file(), `${OTHER}\n`);
    const ops = {
      rename: (from: string, to: string) => import('node:fs/promises').then((fs) => fs.rename(from, to)),
      beforeRename: async () => writeFileSync(file(), `${OTHER}\n# typed by hand\n`),
    };
    await expect(authorizeKey(files, key(PHONE), 4791, 'x', NOW, { ops })).rejects.toMatchObject({ code: 'changed_while_writing' });
    expect(readFileSync(file(), 'utf8')).toBe(`${OTHER}\n# typed by hand\n`);
    expect(leftovers()).toEqual([]);
  });

  it('takes turns: concurrent writes in one process all land', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    writeFileSync(file(), `${OTHER}\n`);
    const lines = Array.from({ length: 12 }, (_, i) => oneTimeLine(PHONE.split(' ')[1]!, 1000 + i, new Date('2026-10-22T09:00:00Z'), `hestia-authorize-${i}`));
    await Promise.all([
      ...lines.map((line) => addOneTimeLine(files, line, NOW)),
      authorizeKey(files, key(RSA_2048), 4791, 'rsa', NOW),
    ]);
    const content = readFileSync(file(), 'utf8');
    expect(content.startsWith(`${OTHER}\n`)).toBe(true);
    for (const line of lines) expect(content).toContain(`${line}\n`);
    expect(content).toContain(`${body(RSA_2048)} rsa\n`);
    expect(splitLines(content)).toHaveLength(14);
    expect(existsSync(lockPath(files))).toBe(false);
  });

  it('takes turns across processes', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    writeFileSync(file(), `${OTHER}\n`);
    const modulePath = fileURLToPath(new URL('../../src/ssh-access/authorizedKeys.ts', import.meta.url));
    const script = `
      import { addOneTimeLine, oneTimeLine } from ${JSON.stringify(modulePath)};
      const [dir, uid, i] = process.argv.slice(-3);
      for (let n = 0; n < 5; n++) {
        await addOneTimeLine({ sshDir: dir, uid: Number(uid) }, oneTimeLine('AAAA', 1, new Date('2099-01-01T00:00:00Z'), 'hestia-authorize-p' + i + '-' + n), new Date(), { lock: { waitMs: 20000 } });
      }`;
    const run = (i: number) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, '--', files.sshDir, String(uid), String(i)], { stdio: 'inherit', cwd: path.dirname(modulePath) });
      child.on('exit', (code) => resolve(code ?? 1));
    });
    expect(await Promise.all([0, 1, 2, 3].map(run))).toEqual([0, 0, 0, 0]);
    const content = readFileSync(file(), 'utf8');
    expect(splitLines(content)).toHaveLength(21);
    for (let i = 0; i < 4; i++) for (let n = 0; n < 5; n++) expect(content).toContain(` hestia-authorize-p${i}-${n}\n`);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('clears a lock left by a process that is gone, and waits for a live one', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    // A pid that can't be running.
    writeFileSync(lockPath(files), `999999999\n${Date.now()}\n`);
    expect(await withKeyFileLock(files, async () => 'ran')).toBe('ran');
    expect(existsSync(lockPath(files))).toBe(false);
    // Held by this (live) process, just now: wait, then give up.
    writeFileSync(lockPath(files), `${process.pid}\n${Date.now()}\n`);
    await expect(withKeyFileLock(files, async () => 'ran', { waitMs: 200, pollMs: 20 })).rejects.toMatchObject({ code: 'locked' });
    // The same lock, too old: cleared.
    writeFileSync(lockPath(files), `${process.pid}\n${Date.now() - 60_000}\n`);
    expect(await withKeyFileLock(files, async () => 'ran')).toBe('ran');
  });

  it('an empty lock waits while new, and is cleared once old (a run that died before writing it)', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    writeFileSync(lockPath(files), '');
    await expect(withKeyFileLock(files, async () => 'ran', { waitMs: 200, pollMs: 20 })).rejects.toMatchObject({ code: 'locked' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(files), old, old);
    expect(await withKeyFileLock(files, async () => 'ran')).toBe('ran');
  });

  it('leaves a file that is not UTF-8 alone', async () => {
    mkdirSync(files.sshDir, { mode: 0o700 });
    const before = Buffer.concat([Buffer.from(`${OTHER} caf`), Buffer.from([0xe9]), Buffer.from('\n')]);
    writeFileSync(file(), before, { mode: 0o600 });
    await expect(authorizeKey(files, key(PHONE), 4791, 'phone', NOW)).rejects.toMatchObject({ code: 'not_utf8' });
    expect(readFileSync(file()).equals(before)).toBe(true);
  });
});
