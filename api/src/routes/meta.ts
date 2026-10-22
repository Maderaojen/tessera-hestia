import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { CONTRACT_VERSION, type ApiCapability, type ApiMeta, type LaunchOption, type RuntimeCapability, type RuntimeMeta } from '../contract/index.js';
import { nativeProfiles } from '../launch-profiles.js';
import type { HestiaModule } from '../module-host/types.js';
import { runtimeDrivers, type RuntimeDriver } from '../runtimes/index.js';
import { supportedPermissionModes, unavailablePermissionModes } from '../runtimes/launch.js';

// The optional features this backend has (contract/meta.ts), for a client
// to decide on rather than guessing from the backend's version. A loaded
// module adds its own (apiMeta).
export const API_FEATURES: ApiCapability[] = ['auth_sessions', 'error_codes', 'interrupted_flag', 'session_list_stream', 'attachments', 'conversation_clear', 'model_switch', 'session_close', 'native_push', 'repo_view', 'continuity', 'session_trash', 'recap', 'usage_analytics', 'delegation', 'fork', 'filesystem_search', 'note_trash', 'repo_worktrees', 'launch_cancel', 'delegation_origin', 'handoff_options', 'handoff_brief', 'session_timeline', 'account_login', 'permission_modes', 'turn_process', 'transcript_retention', 'session_files', 'composer_attachments', 'handoff_relaunch', 'process_images'];

// What the driver declares, as capabilities a client can branch on instead
// of knowing which runtime can do what.
export function runtimeCapabilities(driver: RuntimeDriver): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = [];
  if (driver.resume.kind === 'in_place' && driver.buildResume) capabilities.push('resume');
  if (driver.buildExitPlan().status === 'supported') capabilities.push('clear');
  if (driver.interruptReply) capabilities.push('interrupt');
  if (driver.readStartupPrompt) capabilities.push('startup_prompt');
  if (driver.accountStatus) capabilities.push('quota');
  if (driver.janus) capabilities.push('janus');
  if (driver.listSubagents) capabilities.push('subagents');
  if (driver.models) capabilities.push('model_switch');
  if (driver.readLimitHit) capabilities.push('limit_hit');
  return capabilities;
}

// The package version of this API. Read from the nearest package.json up
// from this file, which sits one level deeper once compiled (dist/src/…)
// than when run from source (src/…).
function readApiVersion(): string {
  for (const relative of ['../../package.json', '../../../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (parsed.name === 'hestia-api' && typeof parsed.version === 'string') return parsed.version;
    } catch { /* try the next level */ }
  }
  return 'unknown';
}

const API_VERSION = readApiVersion();

/** GET /meta's answer: Hestia's own features plus those of the modules loaded. */
export function apiMeta(modules: readonly HestiaModule[] = []): ApiMeta {
  const runtimes: RuntimeMeta[] = runtimeDrivers().map((driver) => ({
    id: driver.runtimeId, provider: driver.provider, label: driver.label, capabilities: runtimeCapabilities(driver),
    permissionModes: supportedPermissionModes(driver),
    ...(Object.keys(unavailablePermissionModes(driver)).length ? { permissionModesUnavailable: unavailablePermissionModes(driver) } : {}),
  }));
  // The configured executables and args stay private: only what a launch
  // option shows.
  const nativeLaunchOptions: LaunchOption[] = nativeProfiles().map(({ id, provider, runtimeId, label, source }) => ({ id, provider, runtimeId, label, source }));
  const capabilities = [...new Set<string>([...API_FEATURES, ...modules.flatMap((module) => module.capabilities)])];
  return {
    apiVersion: API_VERSION, contractVersion: CONTRACT_VERSION, capabilities, modules: modules.map((module) => module.id), runtimes, nativeLaunchOptions,
  };
}

export function metaRouter(modules: readonly HestiaModule[] = []): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(apiMeta(modules));
  });
  return router;
}
