import path from 'node:path';
import { listAccounts } from '../account-status/accounts.js';
import { getLaunchProfileCatalog } from '../launch-profiles.js';
import { listAllSessions } from '../registry.js';
import { listProjects } from '../project-store.js';
import { accountIdFor } from '../account-status/types.js';
import type { Binding, Source } from './storage.js';
import { t } from '../i18n/index.js';

export async function discoverUsageSources(): Promise<{ sources: Source[]; warnings: string[] }> {
  const [{ accounts, janusAvailable }, catalog] = await Promise.all([listAccounts(), getLaunchProfileCatalog()]);
  const sources: Source[] = [];
  const warnings: string[] = [];
  if (!janusAvailable || catalog.janus.error) warnings.push('account_discovery_incomplete');
  for (const account of accounts) {
    if (account.provider !== 'claude' && account.provider !== 'codex') { warnings.push('provider_unsupported'); continue; }
    const profile = catalog.profiles.find((p) => p.source === 'janus' && account.source === 'janus' && p.provider === account.provider && p.profileName === account.name);
    const conversationRoot = profile?.source === 'janus' ? profile.conversationRoot : path.join(account.home, account.provider === 'claude' ? 'projects' : 'sessions');
    sources.push({ id: account.id, accountId: account.id, label: `${account.provider} · ${account.name}`, provider: account.provider, root: conversationRoot });
    if (account.provider === 'codex') sources.push({ id: `${account.id}:archive`, accountId: account.id, label: `${account.provider} · ${account.name}`, provider: account.provider, root: path.join(account.home, 'archived_sessions') });
  }
  return { sources, warnings };
}

export async function readUsageBindings(): Promise<Binding[]> {
  const [sessions, projects] = await Promise.all([listAllSessions(), listProjects()]);
  const bindings: Binding[] = [];
  for (const session of sessions) for (const conversation of session.conversations ?? []) {
    const profile = conversation.launchProfile;
    if (!profile || !conversation.providerSessionId || (conversation.provider !== 'claude' && conversation.provider !== 'codex')) continue;
    // Heuristic transcript identities are useful for UI recovery but too weak
    // for assigning usage. Unknown account evidence stays unattributed.
    if (!['pinned_id', 'verified_metadata'].includes(conversation.transcript?.identity ?? '')) continue;
    const accountId = profile.source === 'janus' && profile.profileName ? accountIdFor('janus', profile.provider, profile.profileName) : profile.source === 'native' ? accountIdFor('native', profile.provider, 'default') : null;
    if (!accountId || profile.provider !== conversation.provider) continue;
    bindings.push({ provider: conversation.provider, sessionId: conversation.providerSessionId, startedAt: conversation.startedAt, endedAt: conversation.endedAt,
      projectId: session.projectId, projectLabel: projects.find((p) => p.id === session.projectId)?.name ?? t('usage.project.removed'), tmuxId: session.id, tmuxLabel: session.alias ?? `Tmux ${session.sessionNumber}`, accountId });
  }
  return bindings;
}
