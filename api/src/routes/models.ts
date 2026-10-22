import { Router } from 'express';
import { z } from 'zod';
import type { ModelCatalog, ModelChoice } from '../contract/models.js';
import { listModels } from '../model-lists.js';
import * as registry from '../registry.js';
import { recordedRuntime } from '../runtimes/resolve.js';
import type { ModelTerminal, RuntimeDriver } from '../runtimes/types.js';
import { refreshStartupPrompt, startupPromptPossible } from '../sync/startupPrompt.js';
import { sendRuntimeText } from '../sync/input.js';
import * as tmuxCli from '../tmux.js';
import { deriveSessionActivity, type ConversationSegment, type LaunchProfileSnapshot, type ManagedSession } from '../types.js';
import { sendError } from './errors.js';

// Listing and switching the model of the CLI running in a tmux (contract/
// models.ts). The switch is typed into the CLI itself, the way each
// runtime's ModelSupport verified; it becomes that account's default for
// new sessions too, while other running CLIs keep theirs.
export const modelsRouter = Router();

// The lists are cached in model-lists.ts, shared with the recaps' model choice.
export { clearModelLists } from '../model-lists.js';

type Target =
  | { ok: true; session: ManagedSession; conversation: ConversationSegment; runtime: RuntimeDriver; profile: LaunchProfileSnapshot }
  | { ok: false; status: number; code: 'not_found' | 'session_dead' | 'no_active_conversation' | 'model_switch_unsupported'; message: string };

function modelTarget(session: ManagedSession | null | undefined): Target {
  if (!session) return { ok: false, status: 404, code: 'not_found', message: 'not found' };
  if (session.status === 'dead') return { ok: false, status: 409, code: 'session_dead', message: 'session is dead' };
  const conversation = session.conversations?.find((item) => item.id === session.activeConversationId);
  if (!session.provider || !conversation) {
    return { ok: false, status: 409, code: 'no_active_conversation', message: 'no active CLI conversation is bound to this tmux session' };
  }
  const runtime = recordedRuntime(session, conversation);
  if (!runtime?.models || !conversation.launchProfile) {
    return { ok: false, status: 409, code: 'model_switch_unsupported', message: 'this CLI can\'t switch models from the app' };
  }
  return { ok: true, session, conversation, runtime, profile: conversation.launchProfile };
}

modelsRouter.get('/:id/models', async (req, res) => {
  const target = modelTarget(await registry.getSession(req.params.id));
  if (!target.ok) {
    sendError(res, target.status, target.code, target.message);
    return;
  }
  let list;
  try {
    list = await listModels(target.runtime, target.profile, req.query.refresh === '1');
  } catch (error) {
    const reason = (error as Error).message;
    sendError(res, 502, 'model_list_failed', `couldn't list ${target.runtime.label}'s models: ${reason}`, { cli: target.runtime.label, reason });
    return;
  }
  const catalog: ModelCatalog = {
    runtimeId: target.runtime.runtimeId,
    source: target.runtime.models!.source,
    options: list.options,
    current: target.conversation.model ?? null,
    fetchedAt: list.fetchedAt,
  };
  res.json(catalog);
});

// A switch presses several keys in a row (Codex's menus): one at a time
// per tmux.
const switching = new Set<string>();
const HISTORY_LINES = 2_000;

function paneTerminal(tmuxName: string, runtime: RuntimeDriver): ModelTerminal {
  return {
    // With scrollback, so an answer counted before the switch can't scroll
    // out of what is compared (see awaitNewAnswer).
    capture: () => tmuxCli.capturePane(tmuxName, { history: HISTORY_LINES }),
    submit: (text) => sendRuntimeText(tmuxName, runtime, text),
    type: (text) => tmuxCli.typeText(tmuxName, text),
    sendKey: (key) => tmuxCli.sendKey(tmuxName, key),
  };
}

const switchSchema = z.object({ model: z.string().min(1), effort: z.string().min(1).nullable().optional() });

modelsRouter.post('/:id/model', async (req, res) => {
  const parsed = switchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', parsed.error.message);
    return;
  }
  const target = modelTarget(await registry.getSession(req.params.id));
  if (!target.ok) {
    sendError(res, target.status, target.code, target.message);
    return;
  }
  const { session, conversation, runtime, profile } = target;
  if (switching.has(session.id)) {
    sendError(res, 409, 'model_switch_in_progress', 'a model switch is in progress');
    return;
  }
  // Typed while a reply is being written, the command would queue up as a
  // message or land in a permission menu; typed into a start-up prompt,
  // its Enter would answer it.
  if (startupPromptPossible(session, conversation, runtime) && await refreshStartupPrompt(session, runtime)) {
    sendError(res, 409, 'startup_prompt_pending', 'the CLI is asking whether to trust this folder');
    return;
  }
  const activity = deriveSessionActivity(session);
  if (activity !== 'idle') {
    sendError(res, 409, 'cli_busy', 'the CLI is busy; switch once it is idle', { activity });
    return;
  }

  switching.add(session.id);
  try {
    let options;
    try {
      options = (await listModels(runtime, profile, false)).options;
    } catch (error) {
      const reason = (error as Error).message;
      sendError(res, 502, 'model_list_failed', `couldn't list ${runtime.label}'s models: ${reason}`, { cli: runtime.label, reason });
      return;
    }
    const option = options.find((candidate) => candidate.id === parsed.data.model);
    if (!option) {
      sendError(res, 400, 'model_unknown', `no model "${parsed.data.model}" for this account`, { model: parsed.data.model });
      return;
    }
    let effort: string | null = null;
    if (option.efforts.length > 0) {
      effort = parsed.data.effort ?? option.defaultEffort ?? option.efforts[0]!;
      if (!option.efforts.includes(effort)) {
        sendError(res, 400, 'invalid_request', `${option.label} has no effort "${effort}"`);
        return;
      }
    }

    const result = await runtime.models!.switchModel(paneTerminal(session.tmuxName, runtime), option, effort);
    if (result.status === 'rejected') {
      sendError(res, 409, 'model_rejected', result.message, { reason: result.message });
      return;
    }
    if (result.status === 'unsure') {
      sendError(res, 409, 'model_switch_unconfirmed', `${result.message} (check the current model in the terminal)`, { reason: result.message });
      return;
    }
    const choice: ModelChoice = { model: option.id, label: result.label, effort: result.effort, at: new Date().toISOString() };
    await registry.updateConversation(session.id, conversation.id, { model: choice });
    res.json(choice);
  } finally {
    switching.delete(session.id);
  }
});
