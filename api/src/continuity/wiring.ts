import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAccountStatus, requestRefresh } from '../account-status/index.js';
import { CONTINUITY_PATH } from '../config.js';
import { readUnpushed, readWorkingState, repoInfo } from '../git/repo-reader.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import * as launchScreen from '../launch-guard/screen.js';
import { getLaunchProfileCatalog } from '../launch-profiles.js';
import { titleOf } from '../notifications.js';
import * as push from '../push.js';
import * as registry from '../registry.js';
import { briefAddendumFor } from '../services/brief-addendum.js';
import { gateRunningConversation, sendUserMessage, stopReply, type RunningSession } from '../services/messages.js';
import * as transitions from '../services/transitions.js';
import { activeConversation, resolvedBinding } from '../sync/binding.js';
import { activeTurnPhase, type LaunchProfileSnapshot, type ManagedSession } from '../types.js';
import { quotaAccountIdFor } from '../session-dto.js';
import { readUpstream } from '../upstream/view.js';
import { formatMechanicalBrief } from './brief.js';
import { handoffMessageKind } from '../contract/continuity.js';
import { createContinuity, decodeContinuityState, emptyContinuityState, type Continuity } from './engine.js';
import { backfillSegmentHandoffs } from './segment-backfill.js';
import type { ContinuityPorts, ProfileInfo } from './ports.js';
import { recordSessionEvent } from '../session-events.js';

// The one place continuity/ meets the rest of the app.

const BLOCKED = 'blocked';
// Where briefs are written, inside the session's own folder so every CLI
// can read and write them without leaving its workspace. The folder ignores
// itself, so it never shows up in git.
const BRIEF_DIR = path.join('.hestia', 'handoffs');
// The windows a handoff threshold is measured on; per-model windows only
// matter to that model, which the app can't tell is the one in use.
const THRESHOLD_WINDOWS = new Set(['five_hour', 'seven_day']);

function accountOfProfile(profile: Pick<LaunchProfileSnapshot, 'provider' | 'runtimeId' | 'source' | 'profileName'>): string | null {
  return quotaAccountIdFor({ provider: profile.provider, runtimeId: profile.runtimeId ?? null, status: 'ready', launchProfile: profile });
}

// A brief path from a port call: only ever a file directly in BRIEF_DIR.
function briefPath(session: ManagedSession, file: string): string {
  const resolved = path.resolve(session.cwd, file);
  if (path.dirname(resolved) !== path.resolve(session.cwd, BRIEF_DIR) || !resolved.endsWith('.md')) {
    throw new Error(`not a handoff brief: ${file}`);
  }
  return resolved;
}

async function requireSession(sessionId: string): Promise<ManagedSession> {
  const session = await registry.getSession(sessionId);
  if (!session) throw new Error('session not found');
  return session;
}

async function readGit(cwd: string): Promise<Parameters<typeof formatMechanicalBrief>[0]['git']> {
  try {
    const info = await repoInfo(cwd);
    if (!info) return null;
    const { branch, files } = await readWorkingState(cwd, info.prefix);
    const { commits } = await readUnpushed(cwd, branch).catch(() => ({ commits: [] }));
    return { branch, files, unpushed: commits };
  } catch {
    return null;
  }
}

export const continuityPorts: ContinuityPorts = {
  async listSessionIds() {
    return (await registry.listSessions()).map((session) => session.id);
  },

  async readSession(sessionId) {
    const session = await registry.getSession(sessionId);
    if (!session) return null;
    const conversation = activeConversation(session);
    const profile = conversation?.launchProfile ?? null;
    const lastTurn = conversation?.turns.at(-1);
    return {
      conversationId: session.activeConversationId ?? null,
      running: session.status === 'ready',
      phase: activeTurnPhase(session),
      switching: !!(session.clearPending || session.launchPending || session.resumePending) || session.status === 'launching',
      profileId: profile?.id ?? null,
      accountId: profile && session.provider ? accountOfProfile(profile) : null,
      lastTurnAt: lastTurn?.assistant.at ?? lastTurn?.user.at ?? null,
      lastSentAt: conversation?.lastUserMessageAt ?? null,
    };
  },

  async readLimitHit(sessionId) {
    const session = await registry.getSession(sessionId);
    const binding = session && resolvedBinding(session);
    const hit = binding ? await binding.adapter.readLimitHit?.(binding.file) : null;
    return binding && hit ? { conversationId: binding.conversation.id, hit } : null;
  },

  // The app's own send, with its checks: never typed over a prompt the CLI
  // is waiting on.
  async send(sessionId, text) {
    const gate = await gateRunningConversation(await registry.getSession(sessionId), { startupPrompt: BLOCKED, interaction: BLOCKED });
    if (!gate.ok) {
      return gate.code === 'startup_prompt_pending' || gate.code === 'interaction_pending'
        ? { status: 'blocked', reason: gate.code }
        : { status: 'failed', reason: gate.message };
    }
    await sendUserMessage(gate.session, gate.runtime, text);
    return { status: 'sent' };
  },

  async notify(sessionId, body) {
    const session = await registry.getSession(sessionId);
    if (!session) return;
    await push.sendToAll({ title: titleOf(session), body, url: `/session/${sessionId}`, tag: `${sessionId}:continuity` });
  },

  now: () => new Date(),

  async readQuota(accountId) {
    const account = (await getAccountStatus()).accounts.find((candidate) => candidate.id === accountId);
    if (!account || (account.state !== 'ok' && !account.stale)) return null;
    const remaining = account.windows.filter((window) => THRESHOLD_WINDOWS.has(window.id)).map((window) => window.remainingPercent);
    return { remainingPercent: remaining.length ? Math.min(...remaining) : null };
  },

  refreshQuota() {
    void requestRefresh(false).catch((err: unknown) => console.warn('[continuity] quota refresh failed', err));
  },

  async listProfiles() {
    const catalog = await getLaunchProfileCatalog();
    return catalog.profiles.map((profile): ProfileInfo => ({ id: profile.id, label: profile.label, accountId: accountOfProfile(profile) }));
  },

  async interrupt(sessionId) {
    const session = await requireSession(sessionId);
    if (!session.provider || !session.activeConversationId || session.status === 'dead') return;
    await stopReply(session as RunningSession);
  },

  async switchProfile(sessionId, profileId, options = {}) {
    const result = await transitions.handOff(await requireSession(sessionId), profileId, options);
    await recordSessionEvent({
      sessionId, action: options.force ? 'handoff_force' : 'handoff', result: result.ok ? 'ok' : result.code, source: 'continuity',
      detail: {
        profileId, permissionMode: result.ok ? result.permissionMode : options.permissionMode ?? null,
        ...(result.ok && result.permissionFallbackFrom ? { permissionFallbackFrom: result.permissionFallbackFrom } : {}),
      },
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.error };
  },

  // The launch guard's looks at the pane (ADR 0030), shared with spawn.
  readScreen: (sessionId) => launchScreen.readScreen(sessionId),
  skipUpdate: (sessionId) => launchScreen.skipUpdatePrompt(sessionId),

  async launchProfile(sessionId, profileId, options = {}) {
    const result = await transitions.launch(sessionId, { profileId, ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}) });
    await recordSessionEvent({
      sessionId, action: 'handoff_relaunch', result: result.ok ? 'ok' : result.code, source: 'continuity',
      detail: { profileId, permissionMode: result.ok ? result.permissionMode : options.permissionMode ?? null },
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.error };
  },

  async readHandoffConversation(sessionId, handoffId) {
    const session = await registry.getSession(sessionId);
    const conversations = session?.conversations ?? [];
    const found = conversations.find((conversation) => conversation.handoff?.handoffId === handoffId);
    if (!session || !found?.handoff) return null;
    const briefFile = found.handoff.briefFile;
    return {
      conversationId: found.id,
      latest: conversations.every((conversation) => conversation.sequence <= found.sequence),
      turns: found.turns.length,
      endedAt: found.endedAt,
      endReason: found.endReason,
      profileId: found.launchProfile?.id ?? null,
      permissionMode: found.launchProfile?.permissionMode ?? null,
      record: found.handoff,
      briefPath: briefFile ? path.join(session.cwd, briefFile) : null,
    };
  },

  async prepareBrief(sessionId, handoffId) {
    const session = await requireSession(sessionId);
    const dir = path.join(session.cwd, BRIEF_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(session.cwd, '.hestia', '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
    const file = path.join(BRIEF_DIR, `${stamp}-${handoffId.slice(0, 8)}.md`);
    return { file, absolute: path.join(session.cwd, file) };
  },

  async findBrief(sessionId, file) {
    const session = await requireSession(sessionId);
    const target = briefPath(session, file);
    const found = await readFile(target, 'utf-8').catch(() => null);
    if (found !== null) return found;
    const stray = await findStrayBrief(session.cwd, path.basename(target));
    if (!stray) return null;
    await rename(stray, target).catch(async () => {
      await copyFile(stray, target);
      await rm(stray, { force: true });
    });
    console.warn(`[continuity] session ${sessionId}: brief found at ${stray}, moved to ${target}`);
    return readFile(target, 'utf-8').catch(() => null);
  },

  async writeBrief(sessionId, file, content) {
    const session = await requireSession(sessionId);
    await writeFile(briefPath(session, file), content, 'utf-8');
  },

  async markHandoffSegment(sessionId, conversationId, record) {
    const updated = await registry.updateConversation(sessionId, conversationId, { handoff: record });
    return !!updated;
  },

  async readBriefMeta(sessionId, file) {
    const session = await requireSession(sessionId);
    const target = briefPath(session, file);
    const [text, info] = await Promise.all([readFile(target, 'utf-8'), stat(target)]).catch(() => [null, null] as const);
    return text === null || !info ? null : { text, modifiedAt: info.mtime.toISOString() };
  },

  async mechanicalBrief(sessionId, handoff) {
    const session = await requireSession(sessionId);
    const conversation = session.conversations?.find((item) => item.id === handoff.fromConversationId);
    const turns = conversation?.turns ?? [];
    const fromLabel = handoff.fromProfileId
      ? (await getLaunchProfileCatalog()).profiles.find((profile) => profile.id === handoff.fromProfileId)?.label ?? handoff.fromProfileId
      : null;
    const now = new Date();
    // Where the conversation can be read, not a copy of it (ADR 0023).
    const view = await readUpstream(session.id, handoff.fromConversationId, null);
    // The brief is about the work: the handoff's own request to write it
    // stays in the full record only.
    const work = turns.filter((turn) => !isHandoffRequest(turn.user.text));
    const last = work.at(-1);
    // A CLI that doesn't mark an interrupted reply (Codex) was still
    // interrupted if the handoff did it, after that turn began.
    const interruptedByHandoff = !!handoff.interruptedAt && !!last?.user.at && Date.parse(last.user.at) < Date.parse(handoff.interruptedAt);
    const lastTurn = handoff.trigger === 'limit_hit' ? 'limit_hit'
      : !last ? 'none'
        : last.assistant.interrupted || interruptedByHandoff ? 'interrupted' : 'complete';
    return formatMechanicalBrief({
      handoff, fromLabel, cwd: session.cwd, now, turns: work, lastTurn,
      upstream: { sessionId: session.id, conversationId: handoff.fromConversationId, view },
      git: await readGit(session.cwd),
    });
  },

  // Registered by other features' wiring (services/brief-addendum.ts).
  briefAddendum: (sessionId) => briefAddendumFor(sessionId),

  async checkDelivered(sessionId, text, since) {
    const session = await registry.getSession(sessionId);
    const binding = session && resolvedBinding(session);
    if (!binding) return 'unknown';
    // A message's recorded time can trail the send by the CLI's own delay,
    // never precede it by more than clock skew.
    const after = Date.parse(since) - 5_000;
    const received = (await binding.adapter.parseMessages(binding.file))
      .filter((message) => message.role === 'user' && message.ts && Date.parse(message.ts) >= after)
      .at(-1);
    return received ? compareDelivered(received.text, text) : 'missing';
  },
};

// Whitespace says nothing about what arrived: a CLI may rewrap a long line.
const collapse = (text: string) => text.replace(/\s+/g, '');

// The handoff's own request to write the brief, whole or as much of it as arrived.
export function isHandoffRequest(text: string): boolean {
  return handoffMessageKind(text) === 'write_brief';
}

/** What a CLI recorded against what was typed: whole, or only a part of it. */
export function compareDelivered(received: string, sent: string): 'exact' | 'partial' | 'missing' {
  const got = collapse(received);
  const want = collapse(sent);
  if (got === want || got.includes(want)) return 'exact';
  return got.length > 0 && want.includes(got) ? 'partial' : 'missing';
}

// A brief the CLI wrote under the right name in the wrong place: the
// working folder itself or one level down, matched by the handoff id at
// the end of the name (a CLI that misread the path may also have mangled
// its start, as Codex 0.160.0 once did with a prompt whose head was lost).
// A `<brief>.conversation.md` is never one: handoffs before ADR 0023 wrote
// the whole conversation out beside the brief, and those files are left.
async function findStrayBrief(cwd: string, name: string): Promise<string | null> {
  const suffix = name.slice(name.lastIndexOf('-'));
  const matches = (entry: string) => entry === name || (entry.endsWith(suffix) && !entry.endsWith('.conversation.md'));
  const dirs = [cwd];
  for (const entry of await readdir(cwd, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') dirs.push(path.join(cwd, entry.name));
  }
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && matches(entry.name)) return path.join(dir, entry.name);
    }
  }
  return null;
}

export const continuityStore = jsonFileStore({ path: CONTINUITY_PATH, empty: emptyContinuityState, decode: decodeContinuityState });

export const continuity: Continuity = createContinuity(continuityPorts, continuityStore);

/** Conversations an older handoff started, marked with it (segment-backfill.ts). */
export function backfillHandoffSegments(): Promise<number> {
  return backfillSegmentHandoffs({
    sessions: registry.listAllSessions,
    updateConversation: (sessionId, conversationId, patch) => registry.updateConversation(sessionId, conversationId, patch),
  });
}

/** When the account behind a saved launch profile is over its usage limit, the time it resets. */
export async function accountLimitedUntil(profile: LaunchProfileSnapshot): Promise<string | null> {
  const accountId = accountOfProfile(profile);
  return accountId ? continuity.accountLimitedUntil(accountId) : null;
}
