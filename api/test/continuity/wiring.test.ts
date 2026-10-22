import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/registry.js', () => ({ getSession: vi.fn(), listSessions: vi.fn(async () => []) }));
vi.mock('../../src/account-status/index.js', () => ({ getAccountStatus: vi.fn(), requestRefresh: vi.fn(async () => ({})) }));
const registry = await import('../../src/registry.js');
const accountStatus = await import('../../src/account-status/index.js');
const { compareDelivered, continuityPorts, isHandoffRequest } = await import('../../src/continuity/wiring.js');
const { HANDOFF_PROMPTS } = await import('../../src/continuity/policy.js');

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'continuity-wiring-'));
  vi.mocked(registry.getSession).mockResolvedValue({ id: 's1', cwd } as never);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

describe('briefs', () => {
  it('live in .hestia/handoffs, a folder git ignores, written and read back', async () => {
    const { file, absolute } = await continuityPorts.prepareBrief('s1', '0123456789abcdef');
    expect(file).toMatch(/^\.hestia\/handoffs\/\d{8}-\d{6}Z-01234567\.md$/);
    expect(absolute).toBe(path.join(cwd, file));
    expect(await readFile(path.join(cwd, '.hestia', '.gitignore'), 'utf-8')).toBe('*\n');
    expect(await continuityPorts.findBrief('s1', file)).toBeNull();
    await continuityPorts.writeBrief('s1', file, '# brief');
    expect(await continuityPorts.findBrief('s1', file)).toBe('# brief');
  });

  it('one written in the wrong place, even under a mangled name, is moved into place', async () => {
    const { file } = await continuityPorts.prepareBrief('s1', 'dc6ee9c1aaaaaaaa');
    // What Codex 0.160.0 did with a request whose head was lost.
    const stray = path.join(cwd, `${path.basename(file).slice(1)}`);
    await writeFile(stray, '# 寫錯地方');
    expect(await continuityPorts.findBrief('s1', file)).toBe('# 寫錯地方');
    expect(await readFile(path.join(cwd, file), 'utf-8')).toBe('# 寫錯地方');
    await expect(readFile(stray, 'utf-8')).rejects.toThrow();
  });

  it('one level down counts too; a conversation file an older version wrote beside it does not', async () => {
    const { file } = await continuityPorts.prepareBrief('s1', 'abcdef0123456789');
    await mkdir(path.join(cwd, 'docs'));
    await writeFile(path.join(cwd, 'docs', path.basename(file)), '# 在 docs 裡');
    expect(await continuityPorts.findBrief('s1', file)).toBe('# 在 docs 裡');
    const other = await continuityPorts.prepareBrief('s1', '1111111122222222');
    await writeFile(path.join(cwd, path.basename(other.file).replace(/\.md$/, '.conversation.md')), 'x');
    expect(await continuityPorts.findBrief('s1', other.file)).toBeNull();
  });

  it('the system\'s brief points at the conversation and writes no copy of it', async () => {
    const turns = [
      { index: 1, user: { text: '幫我加上登入頁', at: null }, assistant: { text: '好', at: null } },
      { index: 2, user: { text: '再加上登出', at: null }, assistant: { text: '做到一半', at: null } },
    ];
    vi.mocked(registry.getSession).mockResolvedValue({ id: 's1', cwd, tmuxName: 'hestia-s1', projectId: 'p1', conversations: [{ id: 'c1', provider: null, transcript: { state: 'pending' }, turns }] } as never);
    const { file } = await continuityPorts.prepareBrief('s1', 'abcdef0123456789');
    const brief = await continuityPorts.mechanicalBrief('s1', {
      fromConversationId: 'c1', fromProfileId: null, briefFile: file, trigger: 'manual', toLabel: 'Codex', briefSource: 'mechanical', briefNote: null, interruptedAt: null,
    } as never);
    expect(brief).toContain('hestia conversation show --session s1 --conversation c1');
    expect(brief).toContain('> 再加上登出');
    expect(await readdir(path.join(cwd, '.hestia', 'handoffs'))).toEqual([]);
    await expect(readFile(path.join(cwd, file.replace(/\.md$/, '.conversation.md')), 'utf-8')).rejects.toThrow();
  });

  it('nothing outside that folder', async () => {
    await expect(continuityPorts.writeBrief('s1', '../escape.md', 'x')).rejects.toThrow(/not a handoff brief/);
    await expect(continuityPorts.writeBrief('s1', '.hestia/handoffs/../../x.md', 'x')).rejects.toThrow(/not a handoff brief/);
    await expect(continuityPorts.writeBrief('s1', '.hestia/handoffs/x.sh', 'x')).rejects.toThrow(/not a handoff brief/);
  });
});

describe('readQuota', () => {
  const account = (patch: Record<string, unknown>) => ({
    id: 'janus:claude:work', state: 'ok', stale: false,
    windows: [
      { id: 'five_hour', remainingPercent: 40 },
      { id: 'seven_day', remainingPercent: 12 },
      { id: 'seven_day_opus', remainingPercent: 1 },
    ],
    ...patch,
  });

  it('the lower of the 5-hour and 7-day windows; per-model ones are left out', async () => {
    vi.mocked(accountStatus.getAccountStatus).mockResolvedValue({ accounts: [account({})] } as never);
    expect(await continuityPorts.readQuota('janus:claude:work')).toEqual({ remainingPercent: 12 });
  });

  it('nothing for an account that could not be read', async () => {
    vi.mocked(accountStatus.getAccountStatus).mockResolvedValue({ accounts: [account({ state: 'unauthenticated' })] } as never);
    expect(await continuityPorts.readQuota('janus:claude:work')).toBeNull();
    expect(await continuityPorts.readQuota('janus:claude:other')).toBeNull();
  });
});

describe('compareDelivered', () => {
  const sent = '額度快用完了，接下來會交給另一個 LLM 接手。請把交接內容用 Markdown 寫到 /p/.hestia/handoffs/20261005-024513Z-dc6ee9c1.md：任務目標。';
  it.each([
    ['whole', sent, 'exact'],
    ['whole, rewrapped', sent.replace('。請', '。\n請'), 'exact'],
    ['its head lost (the Codex 0.160.0 incident)', sent.slice(sent.indexOf('0261005')), 'partial'],
    ['its tail lost', sent.slice(0, 30), 'partial'],
    ['something else', '繼續', 'missing'],
  ] as const)('%s', (_name, received, expected) => {
    expect(compareDelivered(received, sent)).toBe(expected);
  });
});

describe('isHandoffRequest', () => {
  const request = HANDOFF_PROMPTS.writeBrief('/p/.hestia/handoffs/20261005-024513Z-dc6ee9c1.md');
  it('the request, whole or with its head lost', () => {
    expect(isHandoffRequest(request)).toBe(true);
    expect(isHandoffRequest(request.slice(request.indexOf('0261005')))).toBe(true);
  });
  it('not the work itself', () => {
    expect(isHandoffRequest('請建立 calc.py，裡面有 add 和 multiply 兩個函式')).toBe(false);
    expect(isHandoffRequest('')).toBe(false);
  });
});
