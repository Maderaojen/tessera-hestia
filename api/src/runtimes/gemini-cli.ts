import { NATIVE_PROVIDER_HOMES, PROVIDER_ROOTS } from '../config.js';
import { geminiAdapter } from '../providers/gemini.js';
import { RUNTIME_LABELS } from '../contract/runtimes.js';
import type { RuntimeDriver } from './types.js';
import { t } from '../i18n/index.js';

/** Legacy Gemini CLI runtime. Its JSON/JSONL parser must remain separate from Agy. */
export const geminiCliRuntime: RuntimeDriver = {
  ...geminiAdapter,
  runtimeId: 'gemini-cli',
  provider: 'gemini',
  label: RUNTIME_LABELS['gemini-cli'],
  // Kept under the product name it was stored with before runtimes existed.
  nativeProfile: { configKey: 'gemini', label: () => t('launch.native.gemini'), defaultExecutable: 'gemini' },
  processIdentity: { commands: ['gemini'], wrappers: [] },
  // UNVERIFIED — no documented way to pin a session id at launch.
  buildLaunch() { return { argv: ['gemini'], providerSessionId: null }; },
  buildExitPlan: () => ({ status: 'unknown', reason: 'Legacy Gemini exit delivery and termination timing are not version-validated' }),
  resume: { kind: 'unsupported', reason: 'legacy Gemini CLI: no new features' },
  identity: { kind: 'unsupported' },
  nativeLocations: () => ({ home: NATIVE_PROVIDER_HOMES.gemini, conversationRoot: PROVIDER_ROOTS.gemini }),
};
