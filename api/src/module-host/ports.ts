import { STATE_DIR } from '../config.js';
import { onNotesChanged } from '../notes-events.js';
import * as notesStore from '../notes-store.js';
import { createCliProcessor } from '../processors/cli/processor.js';
import { currentLocale } from '../i18n/index.js';
import { getProject } from '../project-store.js';
import { recap } from '../recap/wiring.js';
import { sendError } from '../routes/errors.js';
import type { ErrorCode } from '../contract/errors.js';
import { MODULE_HOST_VERSION, type CliProcessorChoice, type CliProcessorOptions, type ModuleHost } from './types.js';

// What Hestia hands an optional module (types.ts), made from its own parts.

/**
 * The CLI processor on the account and model the conversation recaps are
 * set to, whether or not recaps are on: one place for the user to pick it.
 */
async function cliProcessor(options: CliProcessorOptions): Promise<CliProcessorChoice> {
  const { profileId, model, effort } = await recap.getSettings();
  if (!profileId || !model) return { unavailable: 'no_profile' };
  return { model, processor: createCliProcessor({ profileId, model, effort, ...options }) };
}

export function createModuleHost(): ModuleHost {
  return {
    version: MODULE_HOST_VERSION,
    stateDir: STATE_DIR,
    locale: currentLocale,
    projects: { exists: async (id) => (await getProject(id)) !== undefined },
    notes: {
      async list(listId) {
        return (await notesStore.listNotes(listId)).map(({ id, text, createdAt, updatedAt, done }) => ({ id, text, createdAt, updatedAt, done }));
      },
      onChanged: onNotesChanged,
    },
    processors: { cli: cliProcessor },
    // A module's codes are its own contract's; the body is Hestia's.
    http: { sendError: (res, status, code, message, params) => sendError(res, status, code as ErrorCode, message, params) },
  };
}
