import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DELEGATION_PATH } from '../config.js';
import { continuity, continuityPorts } from '../continuity/wiring.js';
import type { Delegation } from '../contract/delegation.js';
import { jsonFileStore } from '@maderaojen/json-file-store';
import * as launchScreen from '../launch-guard/screen.js';
import { getLaunchProfileCatalog } from '../launch-profiles.js';
import { permissionModes } from '../permission-modes/service.js';
import { t } from '../i18n/index.js';
import * as push from '../push.js';
import * as registry from '../registry.js';
import { registerBriefAddendum } from '../services/brief-addendum.js';
import { registerTmuxEnv } from '../services/tmux-env.js';
import * as spawnSession from '../spawn/session.js';
import * as spawnWorkspace from '../spawn/workspace.js';
import { activeConversation } from '../sync/binding.js';
import { readUpstream } from '../upstream/view.js';
import { formatDelegationAddendum, formatDelegatorAddendum } from './brief.js';
import { createDelegationEngine, decodeDelegationState, emptyDelegationState, type DelegationEngine } from './engine.js';
import { backfillDelegationOrigins } from './origin-backfill.js';
import { activeDelegationOf, isTerminal } from './policy.js';
import type { DelegationPorts } from './ports.js';
import { reportFileOf } from './startup.js';

// The one place delegation/ meets the rest of the app.

// The tmux variable a delegate finds its delegation by (`hestia delegate`).
export const DELEGATION_ENV = 'HESTIA_DELEGATION_ID';

// Only ever under the delegate's own .hestia/delegations/<id>/.
function delegationDir(delegation: Pick<Delegation, 'id' | 'briefFile' | 'workspace'>): string {
  const dir = path.join(delegation.workspace.path, '.hestia', 'delegations', delegation.id);
  if (path.dirname(path.resolve(delegation.briefFile)) !== dir) throw new Error(`not a delegation brief: ${delegation.briefFile}`);
  return dir;
}

async function ensureDelegationDir(delegation: Delegation): Promise<string> {
  const dir = delegationDir(delegation);
  await mkdir(dir, { recursive: true });
  // The folder ignores itself, so it never shows up in git (or as uncommitted work).
  await writeFile(path.join(delegation.workspace.path, '.hestia', '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
  return dir;
}

async function profileLabel(profileId: string | null): Promise<string | null> {
  if (!profileId) return null;
  return (await getLaunchProfileCatalog()).profiles.find((profile) => profile.id === profileId)?.label ?? profileId;
}

export const delegationPorts: DelegationPorts = {
  now: () => new Date(),
  newId: () => randomBytes(4).toString('hex'),
  newSessionId: () => randomUUID(),

  async readParent(sessionId) {
    const session = await registry.getSession(sessionId);
    if (!session) return null;
    const profileId = activeConversation(session)?.launchProfile?.id ?? null;
    return {
      cwd: session.cwd,
      projectId: session.projectId,
      tmuxName: session.tmuxName,
      conversationId: session.activeConversationId ?? null,
      profileId,
      profileLabel: await profileLabel(profileId),
    };
  },

  async listProfiles() {
    return (await getLaunchProfileCatalog()).profiles.map((profile) => ({ id: profile.id, label: profile.label }));
  },

  // Read only, through continuity's own ports: the account-status snapshot
  // and the limit hits continuity has seen.
  async readQuota(profileId) {
    const accountId = (await continuityPorts.listProfiles()).find((profile) => profile.id === profileId)?.accountId ?? null;
    if (!accountId) return { remainingPercent: null, limitedUntil: null };
    const [quota, limitedUntil] = await Promise.all([
      continuityPorts.readQuota(accountId).catch(() => null),
      continuity.accountLimitedUntil(accountId).catch(() => null),
    ]);
    return { remainingPercent: quota?.remainingPercent ?? null, limitedUntil };
  },

  async planWorkspace(input) {
    return { ...(await spawnWorkspace.planWorkspace('delegate', input)), headAtDelivery: null };
  },

  ensureWorkspace: (workspace) => spawnWorkspace.ensureWorkspace(workspace),
  workspaceState: (workspace) => spawnWorkspace.workspaceState(workspace),
  deliveryMergedInto: (workspace) => spawnWorkspace.mergedInto(workspace, workspace.headAtDelivery),
  workspaceRemovable: (workspace, options) => spawnWorkspace.removalRefusal(workspace, options),
  removeWorkspace: (workspace, options) => spawnWorkspace.removeWorkspace(workspace, options),
  parentDirty: (parentCwd) => spawnWorkspace.parentDirty(parentCwd),

  readUpstream: (sessionId, conversationId, upTo) => readUpstream(sessionId, conversationId, upTo),

  async writeBrief(delegation, content) {
    await ensureDelegationDir(delegation);
    await writeFile(delegation.briefFile, content, 'utf-8');
  },

  async writeParentReport(delegation, content) {
    const session = delegation.parentSessionId ? await registry.getSession(delegation.parentSessionId) : null;
    if (!session) throw new Error('the delegating session is gone');
    const dir = path.join(session.cwd, '.hestia', 'delegations', delegation.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(session.cwd, '.hestia', '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
    // Sharing the delegate's folder, report.md is the delegate's own report.
    const file = path.join(dir, path.resolve(dir) === path.dirname(path.resolve(delegation.briefFile)) ? 'report-for-parent.md' : 'report.md');
    await writeFile(file, content, 'utf-8');
    return file;
  },

  async writeFeedback(delegation, round, content) {
    const file = path.join(await ensureDelegationDir(delegation), `feedback-${round}.md`);
    await writeFile(file, content, 'utf-8');
    return file;
  },

  async sameWork(sessionId, conversationId) {
    const session = await registry.getSession(sessionId);
    if (!session) return false;
    if (!conversationId || session.activeConversationId === conversationId) return true;
    // Continuity's handoffs end a conversation as provider_switch and go on
    // in the next one: the same work. Anything else in between is not.
    const conversations = session.conversations ?? [];
    const from = conversations.findIndex((conversation) => conversation.id === conversationId);
    const to = conversations.findIndex((conversation) => conversation.id === session.activeConversationId);
    if (from < 0 || to <= from) return false;
    return conversations.slice(from, to).every((conversation) => conversation.endReason === 'provider_switch');
  },

  closeChild: (sessionId, force) => spawnSession.closeSession(sessionId, 'delegation', { force }),

  ensureChildSession: (input) => spawnSession.ensureSession({
    sessionId: input.sessionId, cwd: input.cwd, projectId: input.projectId, alias: input.alias,
    env: { [DELEGATION_ENV]: input.delegationId }, source: 'delegation', detail: { delegationId: input.delegationId },
    delegationOrigin: { delegationId: input.delegationId, ...input.origin },
  }),

  launch: (sessionId, profileId, permissionMode) => spawnSession.launch(sessionId, profileId, 'delegation', undefined, permissionMode),
  launchPermissionMode: ({ sessionId, profileId, requested, llm }) => permissionModes.launchModeForProfile({
    sessionId, profileId, llm, ...(requested ? { requested } : {}),
  }),
  readChild: (sessionId) => spawnSession.readSession(sessionId),
  answerTrust: (sessionId) => spawnSession.answerTrust(sessionId),

  // The app's own send and read-back, as continuity uses them.
  send: (sessionId, text) => continuityPorts.send(sessionId, text),
  checkDelivered: (sessionId, text, since) => continuityPorts.checkDelivered(sessionId, text, since),
  // The launch guard's looks at the pane (ADR 0030), shared with continuity.
  readScreen: (sessionId) => launchScreen.readScreen(sessionId),
  skipUpdate: (sessionId) => launchScreen.skipUpdatePrompt(sessionId),
  interrupt: (sessionId) => continuityPorts.interrupt(sessionId),

  firstReplyAfter: (sessionId, since) => spawnSession.firstReplyAfter(sessionId, since),

  // Read-only: a carry-on waiting for the reset, or a handoff going.
  async continuityBusy(sessionId) {
    const view = await continuity.getSession(sessionId);
    return !!(view.pending || view.handoff);
  },

  async limitWaitUntil(sessionId) {
    return (await continuity.getSession(sessionId)).pending?.wakeAt ?? null;
  },

  async notify(delegation, body) {
    const url = delegation.parentSessionId ? `/session/${delegation.parentSessionId}?delegation=${encodeURIComponent(delegation.id)}` : '/';
    await push.sendToAll({ title: t('delegation.push.title', { title: delegation.title }), body, url, tag: `delegation:${delegation.id}` });
  },
};

export const delegationStore = jsonFileStore({ path: DELEGATION_PATH, empty: emptyDelegationState, decode: decodeDelegationState });

export const delegation: DelegationEngine = createDelegationEngine(delegationPorts, delegationStore);

/** Delegates' sessions made before they recorded their delegation get it now. */
export function backfillDelegationSessionOrigins(): Promise<number> {
  return backfillDelegationOrigins({
    delegations: () => delegation.list({}),
    getSession: registry.getSessionRecord,
    updateSession: registry.updateSession,
  });
}

// A delegate's tmux made again (a dead one recovered, a switch that found it
// gone) carries its delegation again, as the first one did.
registerTmuxEnv(async (sessionId): Promise<Record<string, string>> => {
  const own = activeDelegationOf(await delegation.list({ sessionId }), sessionId);
  return own ? { [DELEGATION_ENV]: own.id } : {};
});

// Continuity handing a delegate's tmux to another profile: the CLI taking
// over is told how to deliver (決策 16), at the end of the handoff brief.
// A delegating tmux handed on is told what it delegated and hasn't heard
// back about, so what arrives later makes sense to the CLI taking over.
registerBriefAddendum(async (sessionId) => {
  const delegations = await delegation.list({ sessionId });
  const own = activeDelegationOf(delegations, sessionId);
  const started = delegations.filter((d) => d.parentSessionId === sessionId && !isTerminal(d.state));
  const parts = [
    own ? formatDelegationAddendum({ delegation: own, reportFile: reportFileOf(own) }) : null,
    formatDelegatorAddendum(started),
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join('\n\n') : null;
});
