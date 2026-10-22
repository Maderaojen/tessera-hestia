import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FORK_PATH } from '../config.js';
import { continuity, continuityPorts } from '../continuity/wiring.js';
import type { Fork } from '../contract/fork.js';
import { readWorkingState, repoInfo } from '../git/repo-reader.js';
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
import { conversationForkBlocked } from '../runtimes/conversation-blocks.js';
import { readUpstream } from '../upstream/view.js';
import { formatForkAddendum } from './brief.js';
import { createForkEngine, decodeForkState, emptyForkState, type ForkEngine } from './engine.js';
import { openForkOf } from './policy.js';
import type { ForkPorts } from './ports.js';

// The one place fork/ meets the rest of the app.

// The tmux variable a branch line finds its fork by (`hestia conversation show --upstream`).
export const FORK_ENV = 'HESTIA_FORK_ID';

async function profileLabel(profileId: string | null): Promise<string | null> {
  if (!profileId) return null;
  return (await getLaunchProfileCatalog()).profiles.find((profile) => profile.id === profileId)?.label ?? profileId;
}

// Only ever under the branch line's own .hestia/forks/<id>/.
async function ensureForkDir(fork: Pick<Fork, 'id' | 'briefFile' | 'workspace'>): Promise<void> {
  const dir = path.join(fork.workspace.path, '.hestia', 'forks', fork.id);
  if (path.dirname(path.resolve(fork.briefFile)) !== dir) throw new Error(`not a branch line's brief: ${fork.briefFile}`);
  await mkdir(dir, { recursive: true });
  // The folder ignores itself, so it never shows up in git (or as uncommitted work).
  await writeFile(path.join(fork.workspace.path, '.hestia', '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
}

export const forkPorts: ForkPorts = {
  now: () => new Date(),
  newId: () => randomBytes(4).toString('hex'),
  newSessionId: () => randomUUID(),

  async readParent(sessionId) {
    const session = await registry.getSession(sessionId);
    if (!session) return null;
    const conversation = activeConversation(session);
    const profileId = conversation?.launchProfile?.id ?? null;
    return {
      cwd: session.cwd,
      projectId: session.projectId,
      tmuxName: session.tmuxName,
      title: session.alias?.trim() || session.tmuxName,
      conversationId: conversation?.id ?? null,
      turns: conversation?.turns.length ?? 0,
      profileId,
      profileLabel: await profileLabel(profileId),
      forkBlocked: conversation ? conversationForkBlocked(conversation) : 'conversation_unforkable',
    };
  },

  readUpstream: (sessionId, conversationId, turnsAtFork) => readUpstream(sessionId, conversationId, turnsAtFork),

  async listProfiles() {
    return (await getLaunchProfileCatalog()).profiles.map((profile) => ({ id: profile.id, label: profile.label }));
  },

  // Read only, through continuity's own ports, as a delegation reads it.
  async readQuota(profileId) {
    const accountId = (await continuityPorts.listProfiles()).find((profile) => profile.id === profileId)?.accountId ?? null;
    if (!accountId) return { remainingPercent: null, limitedUntil: null };
    const [quota, limitedUntil] = await Promise.all([
      continuityPorts.readQuota(accountId).catch(() => null),
      continuity.accountLimitedUntil(accountId).catch(() => null),
    ]);
    return { remainingPercent: quota?.remainingPercent ?? null, limitedUntil };
  },

  planWorkspace: (input) => spawnWorkspace.planWorkspace('fork', { ...input, isolation: 'worktree' }),
  ensureWorkspace: (workspace) => spawnWorkspace.ensureWorkspace(workspace),

  async parentDirtyFiles(parentCwd) {
    const info = await repoInfo(parentCwd).catch(() => null);
    if (!info) return null;
    // Repo-wide: the worktree is the whole repo, not just this subfolder.
    return (await readWorkingState(info.toplevel, '')).files;
  },

  async writeBrief(fork, content) {
    await ensureForkDir(fork);
    await writeFile(fork.briefFile, content, 'utf-8');
  },

  ensureChildSession: (input) => spawnSession.ensureSession({
    sessionId: input.sessionId, cwd: input.cwd, projectId: input.projectId, alias: input.alias,
    env: { [FORK_ENV]: input.fork.id }, source: 'fork', detail: { forkId: input.fork.id },
    forkOrigin: {
      forkId: input.fork.id,
      fromSessionId: input.fork.origin.sessionId,
      fromConversationId: input.fork.origin.conversationId,
      sharedFolder: input.fork.workspace.isolation === 'shared',
    },
  }),

  launch: (sessionId, profileId, from, permissionMode) => spawnSession.launch(sessionId, profileId, 'fork', from ?? undefined, permissionMode),
  launchPermissionMode: ({ sessionId, profileId, requested }) => permissionModes.launchModeForProfile({
    sessionId, profileId, ...(requested ? { requested } : {}),
  }),
  closeChild: (sessionId, force) => spawnSession.closeSession(sessionId, 'fork', { force }),
  workspaceRemovable: (workspace) => spawnWorkspace.removalRefusal(workspace, { deleteBranch: true }),
  removeWorkspace: (workspace) => spawnWorkspace.removeWorkspace(workspace, { deleteBranch: true }),

  readChild: (sessionId) => spawnSession.readSession(sessionId),
  answerTrust: (sessionId) => spawnSession.answerTrust(sessionId),
  // The app's own send and read-back, as continuity uses them.
  send: (sessionId, text) => continuityPorts.send(sessionId, text),
  checkDelivered: (sessionId, text, since) => continuityPorts.checkDelivered(sessionId, text, since),
  // The launch guard's looks at the pane (ADR 0030), shared with continuity.
  readScreen: (sessionId) => launchScreen.readScreen(sessionId),
  skipUpdate: (sessionId) => launchScreen.skipUpdatePrompt(sessionId),

  async notify(fork, body) {
    await push.sendToAll({ title: t('fork.push.title', { title: fork.title }), body, url: `/session/${fork.origin.sessionId}?fork=${encodeURIComponent(fork.id)}`, tag: `fork:${fork.id}` });
  },
};

export const forkStore = jsonFileStore({ path: FORK_PATH, empty: emptyForkState, decode: decodeForkState });

export const fork: ForkEngine = createForkEngine(forkPorts, forkStore);

// A branch line's tmux made again (a dead one recovered, a switch that
// found it gone) carries its fork again, as the first one did.
registerTmuxEnv(async (sessionId): Promise<Record<string, string>> => {
  const own = openForkOf(await fork.list({ sessionId }), sessionId);
  return own ? { [FORK_ENV]: own.id } : {};
});

// Continuity handing a branch line's tmux to another profile: the CLI
// taking over is told it is a branch line, and where the upstream is.
registerBriefAddendum(async (sessionId) => {
  const own = openForkOf(await fork.list({ sessionId }), sessionId);
  return own ? formatForkAddendum(own) : null;
});
