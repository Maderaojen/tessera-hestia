import { execFile } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from './child-env.js';
import { LAUNCH_PROFILES_PATH, USER_BIN_DIR } from './config.js';
import { writeFileAtomic } from '@maderaojen/json-file-store';
import type { LaunchOption } from './contract/meta.js';
import { type Provider } from './types.js';
import { quotaAccountIdFor } from './session-dto.js';
import { t } from './i18n/index.js';
import { janusRuntimeFor, runtimeDrivers, type RuntimeId } from './runtimes/index.js';

const execFileAsync = promisify(execFile);
const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;
// Native entries a version-1 launch-profiles.json always has. A runtime
// added later (Agy) is optional in the file and falls back to its default.
const REQUIRED_NATIVE_KEYS = ['claude', 'codex', 'gemini'] as const;

export type NativeProfile = { id: string; provider: Provider; runtimeId: RuntimeId; label: string; source: 'native'; executable: string; args: string[] };
export type JanusProfile = {
  id: string; provider: Provider; runtimeId?: RuntimeId; label: string; source: 'janus'; profileName: string;
  home: string; conversationRoot: string; janusExecutable: string;
};
export type LaunchProfile = NativeProfile | JanusProfile;
export type JanusDescriptor = {
  source: 'janus'; provider: string; name: string; state: string; home: string; conversation_root: string; janusExecutable: string;
};
export type JanusErrorCode = 'not_found' | 'command_failed' | 'timeout' | 'invalid_output';
export type LaunchProfileCatalog = {
  profiles: LaunchProfile[]; discoveredAt: string; janus: { available: boolean; error: null | { code: JanusErrorCode; message: string } };
};
type NativeEntry = { executable: string; args: string[] };
type StoredConfig = {
  version: 1;
  native: Record<(typeof REQUIRED_NATIVE_KEYS)[number], NativeEntry> & Record<string, NativeEntry | undefined>;
  janus: { lastDiscoveredAt: string | null; profiles: JanusDescriptor[] };
};
const DEFAULTS: StoredConfig = {
  version: 1,
  native: Object.fromEntries(runtimeDrivers().map(({ nativeProfile }) => [
    nativeProfile.configKey, { executable: nativeProfile.defaultExecutable, args: [] },
  ])) as unknown as StoredConfig['native'],
  janus: { lastDiscoveredAt: null, profiles: [] },
};

export function janusProfileId(provider: string, name: string): string {
  return `janus:${Buffer.from(JSON.stringify([provider, name]), 'utf8').toString('base64url')}`;
}

const nativeLabel = (label: string | (() => string)) => (typeof label === 'function' ? label() : label);

/** What the API says when Janus can't be asked; worded when it is answered. */
export function janusErrorMessage(code: JanusErrorCode): string {
  return t(code === 'not_found' ? 'launch.janus.notFound' : 'launch.janus.failed');
}

export function nativeProfiles(config: StoredConfig = DEFAULTS): NativeProfile[] {
  return runtimeDrivers().map((driver) => {
    const { configKey, defaultExecutable } = driver.nativeProfile;
    const label = nativeLabel(driver.nativeProfile.label);
    const entry = config.native[configKey] ?? { executable: defaultExecutable, args: [] };
    return {
      id: `native:${configKey}`, provider: driver.provider, runtimeId: driver.runtimeId, label, source: 'native' as const,
      executable: entry.executable, args: [...entry.args],
    };
  });
}

export type ParseOptions = {
  janusExecutable: string;
  canonicalize: (value: string) => Promise<string>;
  isReadableDirectory: (value: string) => Promise<boolean>;
};
export async function parseJanusProfiles(input: unknown, options: ParseOptions): Promise<{
  profiles: JanusProfile[]; records: JanusDescriptor[]; rejected: number;
}> {
  if (!Array.isArray(input)) return { profiles: [], records: [], rejected: 1 };
  const profiles: JanusProfile[] = [];
  const records: JanusDescriptor[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') { rejected++; continue; }
    const item = raw as Record<string, unknown>;
    const { provider, name, home, conversation_root: conversationRoot } = item;
    const rawState = item.state;
    if (typeof provider !== 'string' || typeof name !== 'string' || typeof home !== 'string' || typeof conversationRoot !== 'string'
      || (rawState !== undefined && typeof rawState !== 'string') || (item.source !== undefined && item.source !== 'janus')) {
      rejected++; continue;
    }
    // Janus `paths --json` intentionally omits source/state; its rows are
    // registered profiles. Readiness is then established by validating the
    // actual home and provider conversation root below. If a future API
    // supplies state, only an explicit `ready` row may become launchable.
    const state = typeof rawState === 'string' ? rawState : 'ready';
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) || name.trim() !== name || name.length > 200) { rejected++; continue; }
    const key = JSON.stringify([provider, name]);
    if (seen.has(key)) { rejected++; continue; }
    seen.add(key);
    const descriptor: JanusDescriptor = {
      source: 'janus', provider, name, state, home, conversation_root: conversationRoot,
      janusExecutable: options.janusExecutable,
    };
    records.push(descriptor);
    const runtime = janusRuntimeFor(provider);
    if (state !== 'ready' || !runtime?.janus) continue;
    try {
      if (!path.isAbsolute(home) || !path.isAbsolute(conversationRoot)) { rejected++; continue; }
      const canonicalHome = await options.canonicalize(home);
      const canonicalRoot = await options.canonicalize(conversationRoot);
      if (!(await options.isReadableDirectory(canonicalHome)) || !(await options.isReadableDirectory(canonicalRoot))) { rejected++; continue; }
      const expected = await options.canonicalize(path.join(canonicalHome, runtime.janus.conversationSubdir));
      if (canonicalRoot !== expected || path.relative(canonicalHome, canonicalRoot).startsWith('..')) { rejected++; continue; }
      profiles.push({
        id: janusProfileId(provider, name), provider: runtime.provider, runtimeId: runtime.runtimeId, label: `${provider} · ${name}`, source: 'janus', profileName: name,
        home: canonicalHome, conversationRoot: canonicalRoot, janusExecutable: options.janusExecutable,
      });
    } catch { rejected++; }
  }
  return { profiles, records, rejected };
}

function validStoredConfig(value: unknown): value is StoredConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StoredConfig>;
  if (v.version !== 1 || !v.native || !v.janus || !Array.isArray(v.janus.profiles)) return false;
  const validEntry = (entry: NativeEntry | undefined): boolean => typeof entry?.executable === 'string'
    && Array.isArray(entry.args) && entry.args.every((a) => typeof a === 'string');
  const native = v.native;
  return REQUIRED_NATIVE_KEYS.every((key) => validEntry(native[key]))
    && runtimeDrivers().every(({ nativeProfile: { configKey } }) => native[configKey] === undefined || validEntry(native[configKey]));
}

async function readConfig(): Promise<StoredConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(LAUNCH_PROFILES_PATH, 'utf8'));
    if (!validStoredConfig(parsed)) return DEFAULTS;
    return { ...parsed, native: { ...DEFAULTS.native, ...parsed.native } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULTS;
    return DEFAULTS;
  }
}

async function writeConfig(config: StoredConfig): Promise<void> {
  await writeFileAtomic(LAUNCH_PROFILES_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function findJanus(): Promise<string | null> {
  const override = process.env.HESTIA_JANUS_BIN;
  const candidates = override ? [override] : [
    ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'janus'))),
    path.join(USER_BIN_DIR, 'janus'),
  ];
  for (const candidate of candidates) {
    try {
      if (!path.isAbsolute(candidate)) continue;
      await access(candidate, 1); // X_OK
      const canonical = await realpath(candidate);
      return canonical;
    } catch { /* try next candidate */ }
  }
  return null;
}

let cache: { expiresAt: number; value: LaunchProfileCatalog } | null = null;
let discovery: Promise<LaunchProfileCatalog> | null = null;

async function discover(): Promise<LaunchProfileCatalog> {
  const config = await readConfig();
  const janusExecutable = await findJanus();
  const discoveredAt = new Date().toISOString();
  let janus: LaunchProfileCatalog['janus'] = { available: false, error: { code: 'not_found', message: janusErrorMessage('not_found') } };
  let profiles: JanusProfile[] = [];
  if (janusExecutable) {
    try {
      const { stdout } = await execFileAsync(janusExecutable, ['paths', '--json'], { timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: childEnv() });
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new SyntaxError('invalid output');
      const checked = await parseJanusProfiles(parsed, {
        janusExecutable,
        canonicalize: async (value) => realpath(value),
        isReadableDirectory: async (value) => {
          try {
            if (!(await stat(value)).isDirectory()) return false;
            await access(value, 4);
            return true;
          } catch {
            return false;
          }
        },
      });
      profiles = checked.profiles;
      if (checked.rejected) console.warn(`[launch-profiles] rejected Janus entries: ${checked.rejected}`);
      janus = { available: true, error: null };
      const records = checked.records;
      await writeConfig({ ...config, janus: { lastDiscoveredAt: discoveredAt, profiles: records } });
    } catch (error) {
      const code: JanusErrorCode = (error as Error & { killed?: boolean }).killed ? 'timeout' : error instanceof SyntaxError ? 'invalid_output' : 'command_failed';
      janus = { available: false, error: { code, message: janusErrorMessage(code) } };
      console.warn(`[launch-profiles] Janus discovery failed: ${code}`);
    }
  }
  return { profiles: [...nativeProfiles(config), ...profiles], discoveredAt, janus };
}

export async function getLaunchProfileCatalog(forceRefresh = false): Promise<LaunchProfileCatalog> {
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) return cache.value;
  if (!discovery) discovery = discover().finally(() => { discovery = null; });
  const value = await discovery;
  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

function nativeLabelOf(profile: LaunchProfile): string | null {
  if (profile.source !== 'native') return null;
  const driver = runtimeDrivers().find((candidate) => candidate.runtimeId === profile.runtimeId);
  return driver ? nativeLabel(driver.nativeProfile.label) : null;
}

/** A catalog profile as clients see it (contract LaunchOption): no executable, home or args. */
export function launchOptionOf(profile: LaunchProfile): LaunchOption {
  return {
    // The catalog is cached; a native profile's label is worded per answer.
    id: profile.id, provider: profile.provider, runtimeId: profile.runtimeId, label: nativeLabelOf(profile) ?? profile.label, source: profile.source,
    ...(profile.source === 'janus' ? { profileName: profile.profileName } : {}),
    quotaAccountId: quotaAccountIdFor({ provider: profile.provider, runtimeId: profile.runtimeId, status: 'ready', launchProfile: profile }),
  };
}

export function __resetLaunchProfilesForTests(): void { cache = null; discovery = null; }
