import { describe, expect, it } from 'vitest';
import type { SpawnStartup } from '../../src/contract/workspace.js';
import { FIRST_DELIVERY_GIVE_UP_MS, FIRST_TURN_WATCH_MS, UNKNOWN_NOTICE_MS, UPDATE_SETTLE_MS, type ScreenReading } from '../../src/launch-guard/decide.js';
import type { SendOutcome, SessionView, SpawnPorts } from '../../src/spawn/ports.js';
import {
  advanceSpawn, BRIEF_GIVE_UP_MS, CLI_SETTLE_MS, MISSING_GIVE_UP_MS, newStartup, TRUST_SETTLE_MS,
  type SpawnAttention, type SpawnContext, type SpawnHooks, type SpawnSubject, type StepOutcome,
} from '../../src/spawn/startup.js';

// The start shared by delegations and branch lines, against fake ports:
// what each step does, and which hook it reports through.

const view = (patch: Partial<SessionView> = {}): SessionView => ({
  running: true, switching: false, phase: 'idle', lastTurnAt: null, lastSentAt: null,
  profileId: null, provider: 'claude', launching: false, startupPrompt: null, interaction: false, lastError: null,
  ...patch,
});

type World = {
  now: Date;
  sessions: Map<string, SessionView>;
  sent: string[];
  sendOutcome: SendOutcome;
  delivered: 'exact' | 'partial' | 'missing' | 'unknown';
  trustAnswer: 'answered' | 'unsure';
  trustAnswers: number;
  calls: string[];
  prepared: StepOutcome;
  launched: StepOutcome;
  issues: SpawnAttention[];
  failures: string[];
  briefedAt: string | null;
  allowTrust: boolean;
  // What the pane shows (launch-guard/screen.ts readScreen).
  screen: ScreenReading | null;
  skipAnswer: 'answered' | 'unsure';
  skips: number;
  relaunching: string[];
};

function world(): World {
  return {
    now: new Date('2026-10-08T10:00:00.000Z'),
    sessions: new Map(),
    sent: [],
    sendOutcome: { status: 'sent' },
    delivered: 'exact',
    trustAnswer: 'answered',
    trustAnswers: 0,
    calls: [],
    prepared: { ok: true },
    launched: { ok: true },
    issues: [],
    failures: [],
    briefedAt: null,
    allowTrust: true,
    screen: { screen: { kind: 'input_ready' }, tail: '› Ask Codex to do anything' },
    skipAnswer: 'answered',
    skips: 0,
    relaunching: [],
  };
}

function ports(w: World): SpawnPorts {
  return {
    readChild: async (id) => w.sessions.get(id) ?? null,
    answerTrust: async (id) => {
      w.trustAnswers += 1;
      if (w.trustAnswer === 'answered') w.sessions.set(id, { ...w.sessions.get(id)!, startupPrompt: null });
      return w.trustAnswer;
    },
    send: async (id, text) => {
      if (w.sendOutcome.status === 'sent') {
        w.sent.push(text);
        w.sessions.set(id, { ...w.sessions.get(id)!, phase: 'replying' });
      }
      return w.sendOutcome;
    },
    checkDelivered: async () => w.delivered,
    readScreen: async () => w.screen,
    skipUpdate: async () => {
      w.skips += 1;
      if (w.skipAnswer === 'answered') w.screen = { screen: { kind: 'input_ready' }, tail: '› Ask Codex to do anything' };
      return w.skipAnswer;
    },
  };
}

function hooks(w: World, subject: SpawnSubject): SpawnHooks {
  return {
    message: 'read the brief',
    prepare: async () => {
      w.calls.push('prepare');
      if (w.prepared.ok) subject.childSessionId ??= 'child-1';
      return w.prepared;
    },
    ensureSession: async () => {
      w.calls.push('ensureSession');
      if (!w.sessions.has(subject.childSessionId!)) w.sessions.set(subject.childSessionId!, view({ running: false, provider: null, phase: null }));
      return { ok: true };
    },
    launch: async () => {
      w.calls.push('launch');
      if (w.launched.ok) w.sessions.set(subject.childSessionId!, view({ running: false, launching: true, switching: true, phase: null }));
      return w.launched;
    },
    trustAllowed: () => w.allowTrust,
    trustAnswered: () => { w.calls.push('trustAnswered'); },
    failed: (detail) => { w.failures.push(detail); },
    attention: (issue) => { w.issues.push(issue); },
    gone: () => { w.calls.push('gone'); },
    briefed: (sentAt) => { w.briefedAt = sentAt; },
    relaunching: () => { w.relaunching.push('relaunching'); },
  };
}

const later = (w: World, ms: number) => { w.now = new Date(w.now.getTime() + ms); };

function setup(startup: SpawnStartup = newStartup('2026-10-08T10:00:00.000Z')) {
  const w = world();
  const subject: SpawnSubject = { startup, childSessionId: null, briefFile: '/work/x/.hestia/forks/f1/brief.md' };
  const step = () => advanceSpawn({ ports: ports(w), now: w.now } as SpawnContext, subject, hooks(w, subject));
  return { w, subject, step };
}

describe('advanceSpawn', () => {
  it('goes workspace → session → launch → briefing, then sends the line and reads it back', async () => {
    const { w, subject, step } = setup();
    await step();
    expect(subject.startup.stage).toBe('session');
    expect(subject.childSessionId).toBe('child-1');
    await step();
    expect(subject.startup.stage).toBe('launch');
    await step();
    expect(w.calls).toEqual(['prepare', 'ensureSession', 'launch']);
    expect(subject.startup.launchedAt).not.toBeNull();
    // The CLI comes up.
    w.sessions.set('child-1', view());
    await step();
    expect(subject.startup.stage).toBe('briefing');
    // Given a moment to draw its input box.
    await step();
    expect(w.sent).toEqual([]);
    later(w, CLI_SETTLE_MS + 1);
    await step();
    expect(w.sent).toEqual(['read the brief']);
    const sentAt = subject.startup.sentAt;
    expect(sentAt).not.toBeNull();
    later(w, 4_000);
    await step();
    // In, but not taken over until its first turn is through.
    expect(subject.startup.deliveredAt).toBe(w.now.toISOString());
    expect(w.briefedAt).toBeNull();
    w.sessions.set('child-1', view({ phase: 'idle' }));
    later(w, 4_000);
    await step();
    expect(w.briefedAt).toBe(sentAt);
    expect(w.issues).toEqual([]);
  });

  it('picks up after a restart without launching or sending twice', async () => {
    // Launched before the restart: the CLI is bound already.
    const { w, subject, step } = setup({ ...newStartup('2026-10-08T10:00:00.000Z'), stage: 'launch' });
    subject.childSessionId = 'child-1';
    w.sessions.set('child-1', view({ running: false, launching: true, switching: true, phase: null }));
    await step();
    expect(w.calls).toEqual([]);
    expect(subject.startup.launchedAt).not.toBeNull();
    // Sent before the restart: only read back.
    subject.startup = { ...subject.startup, stage: 'briefing', sentAt: '2026-10-08T09:59:50.000Z' };
    w.sessions.set('child-1', view({ phase: 'replying' }));
    await step();
    expect(w.sent).toEqual([]);
    expect(subject.startup.deliveredAt).not.toBeNull();
    // Watched through its first turn, also across a restart.
    later(w, FIRST_TURN_WATCH_MS + 1);
    await step();
    expect(w.briefedAt).toBe('2026-10-08T09:59:50.000Z');
  });

  it('sends once more when the line did not arrive, then gives up for good', async () => {
    const { w, subject, step } = setup({ ...newStartup('2026-10-08T09:00:00.000Z'), stage: 'briefing' });
    subject.childSessionId = 'child-1';
    w.sessions.set('child-1', view());
    w.delivered = 'missing';
    await step();
    expect(w.sent).toHaveLength(1);
    later(w, MISSING_GIVE_UP_MS + 1);
    await step();
    expect(subject.startup.sentAt).toBeNull();
    expect(subject.startup.resent).toBe(1);
    w.sessions.set('child-1', view());
    await step();
    expect(w.sent).toHaveLength(2);
    later(w, MISSING_GIVE_UP_MS + 1);
    await step();
    expect(w.issues).toEqual([{ reason: 'brief_not_delivered', detail: '請手動讓 CLI 讀 /work/x/.hestia/forks/f1/brief.md', final: true }]);
    expect(w.briefedAt).toBeNull();
  });

  it('answers the trust prompt once when allowed, and asks when the prompt stays', async () => {
    const { w, subject, step } = setup({ ...newStartup('2026-10-08T09:00:00.000Z'), stage: 'briefing' });
    subject.childSessionId = 'child-1';
    w.sessions.set('child-1', view({ startupPrompt: 'workspace_trust' }));
    w.trustAnswer = 'unsure';
    await step();
    expect(w.issues.at(-1)).toEqual({ reason: 'workspace_trust', detail: '無法確認選項位置，請到終端機回答', final: false });
    w.trustAnswer = 'answered';
    await step();
    expect(w.calls).toEqual(['trustAnswered']);
    expect(subject.startup.trustAnsweredAt).not.toBeNull();
    // Answered: the CLI gets a moment before the line goes in.
    later(w, CLI_SETTLE_MS - 1);
    await step();
    expect(w.sent).toEqual([]);
    later(w, 2);
    await step();
    expect(w.sent).toEqual(['read the brief']);
  });

  it('leaves the trust prompt to the user when not allowed, and flags one that stays after answering', async () => {
    const { w, subject, step } = setup({ ...newStartup('2026-10-08T09:00:00.000Z'), stage: 'briefing' });
    subject.childSessionId = 'child-1';
    w.sessions.set('child-1', view({ startupPrompt: 'workspace_trust' }));
    w.allowTrust = false;
    await step();
    expect(w.trustAnswers).toBe(0);
    expect(w.issues).toEqual([{ reason: 'workspace_trust', detail: null, final: false }]);
    // Answered, yet still on screen past its settling time.
    w.allowTrust = true;
    subject.startup.trustAnsweredAt = w.now.toISOString();
    later(w, TRUST_SETTLE_MS + 1);
    await step();
    expect(w.trustAnswers).toBe(0);
    expect(w.issues.at(-1)?.detail).toBe('已經代為選了「信任」，但提示還在');
  });

  it('reports a failed workspace, launch, a CLI that never got ready, and a session gone', async () => {
    const failing = setup();
    failing.w.prepared = { ok: false, detail: 'no folder' };
    await failing.step();
    expect(failing.w.failures).toEqual(['no folder']);
    expect(failing.subject.startup.stage).toBe('workspace');

    const launchFails = setup({ ...newStartup('2026-10-08T10:00:00.000Z'), stage: 'launch' });
    launchFails.subject.childSessionId = 'child-1';
    launchFails.w.sessions.set('child-1', view({ running: false, provider: null, phase: null }));
    launchFails.w.launched = { ok: false, detail: 'profile gone' };
    await launchFails.step();
    expect(launchFails.w.failures).toEqual(['profile gone']);

    const busy = setup({ ...newStartup('2026-10-08T10:00:00.000Z'), stage: 'briefing' });
    busy.subject.childSessionId = 'child-1';
    busy.w.sessions.set('child-1', view({ phase: 'replying' }));
    later(busy.w, BRIEF_GIVE_UP_MS + 1);
    await busy.step();
    expect(busy.w.issues).toEqual([{ reason: 'brief_not_delivered', detail: 'CLI 一直沒有準備好接收指示', final: false }]);

    const gone = setup({ ...newStartup('2026-10-08T10:00:00.000Z'), stage: 'briefing' });
    gone.subject.childSessionId = 'child-1';
    await gone.step();
    expect(gone.w.calls).toEqual(['gone']);
  });
});

// ADR 0030: the 2026-10-16 cube incident and what now happens instead.
describe('advanceSpawn: the launch guard', () => {
  const UPDATE_MENU: ScreenReading = {
    screen: { kind: 'update_prompt', selected: 'update', options: ['update', 'skip', 'skip_version'] },
    tail: '› 1. Update now (runs `npm install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\n  enter continue · esc skip',
  };
  const UPDATED: ScreenReading = { screen: { kind: 'cli_updated' }, tail: '🎉 Update ran successfully! Please restart Codex.\ndev@host:~/cube$' };

  function briefing() {
    // In briefing for a little while: past the CLI's settling time.
    const started = setup({ ...newStartup('2026-10-08T09:59:50.000Z'), stage: 'briefing' });
    started.subject.childSessionId = 'child-1';
    started.w.sessions.set('child-1', view());
    return started;
  }

  it('never types into the update menu: Skip is chosen (cursor confirmed), then the line goes in at the input box', async () => {
    const { w, step } = briefing();
    w.screen = UPDATE_MENU;
    await step();
    expect(w.skips).toBe(1);
    expect(w.sent).toEqual([]);
    await step();
    expect(w.sent).toEqual(['read the brief']);
    expect(w.issues).toEqual([]);
  });

  it('leaves the update menu to the user, with the screen, when Skip can\'t be confirmed', async () => {
    const { w, step } = briefing();
    w.screen = UPDATE_MENU;
    w.skipAnswer = 'unsure';
    await step();
    expect(w.sent).toEqual([]);
    expect(w.issues).toEqual([{ reason: 'startup_prompt', detail: expect.stringContaining('Skip until next version'), final: false }]);
    expect(w.issues[0]!.detail).toMatch(/^CLI 在問要不要更新/);
    // Told once; nothing typed while it stays.
    later(w, UPDATE_SETTLE_MS + 1);
    await step();
    expect(w.issues).toHaveLength(1);
    expect(w.sent).toEqual([]);
  });

  it('waits on a screen it doesn\'t know, tells the user once with its tail, and sends once the input box shows', async () => {
    const { w, subject, step } = briefing();
    w.screen = { screen: { kind: 'unknown' }, tail: '> 1. Sign in with ChatGPT\n  Press enter to continue' };
    await step();
    later(w, UNKNOWN_NOTICE_MS + 1);
    await step();
    expect(w.sent).toEqual([]);
    expect(w.issues).toEqual([{ reason: 'startup_prompt', detail: 'App 不認得這個畫面，還沒送出指示：\n> 1. Sign in with ChatGPT\n  Press enter to continue', final: false }]);
    expect(subject.startup.guard?.tail).toContain('Sign in with ChatGPT');
    await step();
    expect(w.issues).toHaveLength(1);
    w.screen = { screen: { kind: 'input_ready' }, tail: '› ' };
    await step();
    expect(w.sent).toEqual(['read the brief']);
  });

  it('a CLI with no conversation bound yet hasn\'t taken the line in: waits, sends once more, then gives up', async () => {
    const { w, subject, step } = briefing();
    w.delivered = 'unknown';
    await step();
    later(w, 4_000);
    await step();
    expect(w.briefedAt).toBeNull();
    expect(subject.startup.sentAt).not.toBeNull();
    later(w, FIRST_DELIVERY_GIVE_UP_MS);
    await step();
    expect(subject.startup).toMatchObject({ sentAt: null, resent: 1 });
    w.sessions.set('child-1', view());
    await step();
    expect(w.sent).toHaveLength(2);
    later(w, FIRST_DELIVERY_GIVE_UP_MS + 4_000);
    await step();
    expect(w.issues.at(-1)).toEqual({ reason: 'brief_not_delivered', detail: '請手動讓 CLI 讀 /work/x/.hestia/forks/f1/brief.md', final: true });
    expect(w.briefedAt).toBeNull();
  });

  it('a CLI that quits during its first turn has not taken over: no briefed, the user is told with the pane\'s tail', async () => {
    const { w, subject, step } = briefing();
    await step();
    later(w, 4_000);
    await step();
    expect(subject.startup.deliveredAt).not.toBeNull();
    w.sessions.set('child-1', view({ running: false, provider: null, phase: null }));
    w.screen = { screen: { kind: 'unknown' }, tail: 'Segmentation fault\ndev@host:~/cube$' };
    await step();
    expect(w.briefedAt).toBeNull();
    expect(w.issues).toEqual([{ reason: 'cli_exited', detail: 'Segmentation fault\ndev@host:~/cube$', final: false }]);
    expect(w.calls).not.toContain('launch');
  });

  it('a CLI that quit to finish updating itself is started again once, same profile, and the line sent again', async () => {
    const { w, subject, step } = briefing();
    w.sessions.set('child-1', view({ running: false, provider: null, phase: null }));
    w.screen = UPDATED;
    await step();
    expect(subject.startup).toMatchObject({ stage: 'launch', launchedAt: null, sentAt: null, guard: { relaunches: 1 } });
    expect(w.relaunching).toEqual(['relaunching']);
    await step();
    expect(w.calls).toEqual(['launch']);
    w.sessions.set('child-1', view());
    w.screen = { screen: { kind: 'input_ready' }, tail: '› ' };
    await step();
    expect(subject.startup.stage).toBe('briefing');
    later(w, CLI_SETTLE_MS + 1);
    await step();
    expect(w.sent).toEqual(['read the brief']);
    // The same again: not a second time.
    w.sessions.set('child-1', view({ running: false, provider: null, phase: null }));
    w.screen = UPDATED;
    await step();
    expect(w.calls).toEqual(['launch']);
    expect(w.issues.at(-1)).toMatchObject({ reason: 'cli_exited', final: false });
  });
});
