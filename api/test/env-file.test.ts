import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeEnv } from '../scripts/env-file.js';

let dir: string;
let envPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
  envPath = path.join(dir, '.env');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeEnv', () => {
  it('creates the file readable by this user only', () => {
    writeEnv(envPath, { PORT: '4799' });
    expect(readFileSync(envPath, 'utf8')).toBe('PORT=4799\n');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('replaces the given keys in place and keeps every other line, so a re-run of the installer loses nothing it did not ask about', () => {
    writeFileSync(envPath, '# comment\nAUTH_USERNAME=old\nAUTH_LOCAL_USERS=x=scrypt:a:b\nPORT=4791\n', { mode: 0o644 });
    writeEnv(envPath, { AUTH_USERNAME: 'new', HOST: '127.0.0.1' });
    expect(readFileSync(envPath, 'utf8')).toBe('# comment\nAUTH_USERNAME=new\nAUTH_LOCAL_USERS=x=scrypt:a:b\nPORT=4791\nHOST=127.0.0.1\n');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('drops a leftover plaintext AUTH_PASSWORD and blank lines', () => {
    writeFileSync(envPath, 'AUTH_PASSWORD=hunter2\n\nPORT=4791\n\n');
    writeEnv(envPath, { AUTH_PASSWORD_HASH: 'scrypt:s:h' });
    expect(readFileSync(envPath, 'utf8')).toBe('PORT=4791\nAUTH_PASSWORD_HASH=scrypt:s:h\n');
  });

  it('refuses a value node\'s .env parser would cut short (# starts a comment, a line break ends it), writing nothing', () => {
    writeFileSync(envPath, 'PORT=4791\n');
    expect(() => writeEnv(envPath, { AUTH_USERNAME: 'me#2' })).toThrow('AUTH_USERNAME cannot contain #');
    expect(() => writeEnv(envPath, { AUTH_USERNAME: 'me\nPORT=1' })).toThrow('AUTH_USERNAME cannot contain a line break');
    expect(readFileSync(envPath, 'utf8')).toBe('PORT=4791\n');
  });
});
