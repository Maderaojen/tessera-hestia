import type { ContinuityHandoff, LimitHit } from '../../src/contract/continuity.js';
import type { ContinuityPorts, HandoffConversation, ProfileInfo, SendOutcome, SessionView } from '../../src/continuity/ports.js';
import type { ScreenReading } from '../../src/launch-guard/decide.js';
import type { SegmentHandoffRecord } from '../../src/types.js';

// An in-memory app for continuity/ tests: sessions, their CLIs' limit
// hits, accounts' quota, launch profiles, and a log of what was done.

export const hit: LimitHit = {
  at: '2026-10-03T13:39:16.989Z', scope: 'session', limitType: 'five_hour', model: null,
  resetsAt: '2026-10-03T15:30:00.000Z', message: "You've hit your session limit · resets 11:30pm (Asia/Taipei)", ruleId: 'claude-code/quota-limits',
};

export function sessionView(patch: Partial<SessionView> = {}): SessionView {
  return {
    conversationId: 'c1', running: true, phase: 'idle', switching: false,
    profileId: 'janus:claude:work', accountId: 'janus:claude:work', lastTurnAt: null, lastSentAt: null,
    ...patch,
  };
}

export type World = {
  sessions: Map<string, SessionView>;
  hits: Map<string, { conversationId: string; hit: LimitHit } | null>;
  quota: Map<string, number | null>;
  profiles: ProfileInfo[];
  briefs: Map<string, string>;
  // When each brief last changed (writeBrief sets it to `now`).
  briefTimes: Map<string, string>;
  // The handoff written on each conversation, by `${sessionId}:${conversationId}`.
  segments: Map<string, SegmentHandoffRecord>;
  // markHandoffSegment fails while true.
  markFails: boolean;
  sent: { sessionId: string; text: string }[];
  notices: { sessionId: string; body: string }[];
  interrupted: string[];
  switched: { sessionId: string; profileId: string; force?: boolean; permissionMode?: string }[];
  refreshes: number;
  sendOutcome: SendOutcome;
  // What checkDelivered answers.
  delivery: 'exact' | 'partial' | 'missing' | 'unknown';
  // Briefs a CLI wrote elsewhere, moved into place by findBrief.
  strayBriefs: Map<string, string>;
  switchOutcome: { ok: true } | { ok: false; reason: string };
  // What another feature adds to the brief, per session.
  addenda: Map<string, string>;
  // What the launch guard reads off the pane, and its answers.
  screen: ScreenReading | null;
  skipAnswer: 'answered' | 'unsure';
  skips: number;
  // Profiles started in a tmux with no CLI (a relaunch).
  launched: { sessionId: string; profileId: string; permissionMode?: string }[];
  launchOutcome: { ok: true } | { ok: false; reason: string };
  // The conversation each handoff started, by `${sessionId}:${handoffId}`.
  handoffConversations: Map<string, HandoffConversation>;
  now: Date;
};

export function newWorld(): World {
  return {
    sessions: new Map([['s1', sessionView()]]),
    hits: new Map([['s1', { conversationId: 'c1', hit }]]),
    quota: new Map([['janus:claude:work', 50], ['janus:claude:personal', 80], ['native:codex:default', 90]]),
    profiles: [
      { id: 'janus:claude:work', label: 'Claude · work', accountId: 'janus:claude:work' },
      { id: 'janus:claude:personal', label: 'Claude · personal', accountId: 'janus:claude:personal' },
      { id: 'native:codex', label: 'Codex (原生)', accountId: 'native:codex:default' },
    ],
    briefs: new Map(),
    briefTimes: new Map(),
    segments: new Map(),
    markFails: false,
    sent: [],
    notices: [],
    interrupted: [],
    switched: [],
    refreshes: 0,
    sendOutcome: { status: 'sent' },
    delivery: 'exact',
    strayBriefs: new Map(),
    switchOutcome: { ok: true },
    addenda: new Map(),
    screen: { screen: { kind: 'input_ready' }, tail: '› Ask Codex to do anything' },
    skipAnswer: 'answered',
    skips: 0,
    launched: [],
    launchOutcome: { ok: true },
    handoffConversations: new Map(),
    now: new Date('2026-10-03T13:40:00.000Z'),
  };
}

export function fakePorts(world: World): ContinuityPorts {
  return {
    listSessionIds: async () => [...world.sessions.keys()],
    readSession: async (id) => world.sessions.get(id) ?? null,
    readLimitHit: async (id) => world.hits.get(id) ?? null,
    send: async (sessionId, text) => {
      if (world.sendOutcome.status === 'sent') {
        world.sent.push({ sessionId, text });
        // Like the real send: the turn goes to replying, any hit is behind it.
        world.sessions.set(sessionId, { ...world.sessions.get(sessionId)!, phase: 'replying', lastSentAt: world.now.toISOString() });
        world.hits.set(sessionId, null);
      }
      return world.sendOutcome;
    },
    notify: async (sessionId, body) => { world.notices.push({ sessionId, body }); },
    now: () => world.now,
    readQuota: async (accountId) => (world.quota.has(accountId) ? { remainingPercent: world.quota.get(accountId) ?? null } : null),
    refreshQuota: () => { world.refreshes += 1; },
    listProfiles: async () => world.profiles,
    interrupt: async (sessionId) => {
      world.interrupted.push(sessionId);
      world.sessions.set(sessionId, { ...world.sessions.get(sessionId)!, phase: 'idle' });
    },
    switchProfile: async (sessionId, profileId, options = {}) => {
      // Forced, the CLI being left is ended whatever it was doing.
      if (world.switchOutcome.ok || options.force) {
        world.switched.push({ sessionId, profileId, ...(options.force ? { force: true } : {}), ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}) });
        world.sessions.set(sessionId, { ...world.sessions.get(sessionId)!, switching: true, running: false, phase: null });
        return { ok: true };
      }
      if (world.switchOutcome.ok) {
        world.switched.push({ sessionId, profileId });
        world.sessions.set(sessionId, { ...world.sessions.get(sessionId)!, switching: true, running: false, phase: null });
      }
      return world.switchOutcome;
    },
    prepareBrief: async (_sessionId, handoffId) => ({ file: `.hestia/handoffs/${handoffId.slice(0, 8)}.md`, absolute: `/p/.hestia/handoffs/${handoffId.slice(0, 8)}.md` }),
    findBrief: async (_sessionId, file) => {
      const stray = world.strayBriefs.get(file);
      if (stray !== undefined) {
        world.briefs.set(file, stray);
        world.strayBriefs.delete(file);
      }
      return world.briefs.get(file) ?? null;
    },
    writeBrief: async (_sessionId, file, content) => {
      world.briefs.set(file, content);
      world.briefTimes.set(file, world.now.toISOString());
    },
    markHandoffSegment: async (sessionId, conversationId, record) => {
      if (world.markFails) return false;
      world.segments.set(`${sessionId}:${conversationId}`, record);
      return true;
    },
    readBriefMeta: async (_sessionId, file) => {
      const text = world.briefs.get(file);
      return text === undefined ? null : { text, modifiedAt: world.briefTimes.get(file) ?? world.now.toISOString() };
    },
    mechanicalBrief: async (_sessionId, handoff: ContinuityHandoff) => `# 交接（系統整理）\n${handoff.trigger} ${handoff.briefNote ?? ''}`.trim(),
    briefAddendum: async (sessionId) => world.addenda.get(sessionId) ?? null,
    checkDelivered: async () => world.delivery,
    readScreen: async () => world.screen,
    skipUpdate: async () => {
      world.skips += 1;
      if (world.skipAnswer === 'answered') world.screen = { screen: { kind: 'input_ready' }, tail: '› Ask Codex to do anything' };
      return world.skipAnswer;
    },
    readHandoffConversation: async (sessionId, handoffId) => world.handoffConversations.get(`${sessionId}:${handoffId}`) ?? null,
    launchProfile: async (sessionId, profileId, options = {}) => {
      if (!world.launchOutcome.ok) return world.launchOutcome;
      world.launched.push({ sessionId, profileId, ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}) });
      world.sessions.set(sessionId, { ...world.sessions.get(sessionId)!, switching: true, running: false, phase: null });
      return { ok: true };
    },
  };
}

/** The CLI quit: its conversation ended, the tmux back at its shell. */
export function cliQuit(world: World, sessionId: string): void {
  world.sessions.set(sessionId, sessionView({ conversationId: null, running: false, phase: null, profileId: null, accountId: null }));
}

/** The relaunch landed: a new conversation on the target profile, idle. */
export function landSwitch(world: World, sessionId: string, profileId: string, conversationId = 'c2'): void {
  const accountId = world.profiles.find((p) => p.id === profileId)?.accountId ?? null;
  world.sessions.set(sessionId, sessionView({ conversationId, profileId, accountId }));
  world.hits.set(sessionId, null);
}
