import type { LaunchProfileSnapshot, Provider } from '../types.js';
import type { TranscriptAdapter } from '../providers/types.js';
import type { AccountLoginProtocol, AccountRef, AccountStatus } from '../account-status/types.js';
import type { RuntimeId } from '../contract/runtimes.js';
import type { ModelOption } from '../contract/models.js';
import type { PermissionMode, PermissionModeUnavailableReason } from '../contract/permissions.js';

export type { RuntimeId };

export type RuntimeExitPlan =
  | { status: 'supported'; kind: 'text'; text: '/exit' }
  | { status: 'supported'; kind: 'control'; key: 'C-c' }
  | { status: 'unsupported' }
  | { status: 'unknown'; reason: string };

export type ProcessIdentity = { commands: string[]; wrappers: string[] };

export type LaunchPlan = {
  argv: string[];
  // Known up front only when the CLI lets us pin the session id at launch
  // (Claude's `--session-id <uuid>`). null means it has to be observed after
  // startup (see RuntimeIdentityCapability).
  providerSessionId: string | null;
};

export type LaunchOpts = {
  // Display name shown in the CLI's own UI (prompt box, /resume picker,
  // terminal title for Claude). Purely cosmetic — never used to locate the
  // transcript, since not every runtime supports it.
  name?: string;
};

/**
 * One read-only look at a running CLI process for its session identity.
 * Only `resolved` may be bound. `pending` is the normal "not visible yet";
 * `ambiguous` means conflicting evidence; `unobservable` means the evidence
 * this runtime relies on is absent where it should be — worth surfacing if
 * it persists (e.g. Codex attached to a shared daemon holds no thread lock).
 */
export type IdentityObservation =
  | { status: 'resolved'; providerSessionId: string; evidence: string }
  | { status: 'pending' | 'ambiguous' | 'unobservable'; reason: string };

/** How a runtime's session identity becomes known (spec: IdentityPlan). */
export type RuntimeIdentityCapability =
  | { kind: 'pinned_at_launch' }
  | {
    kind: 'observed_after_start';
    // startedAt: when the segment being bound began; its conversation cannot
    // be older than that.
    observe(input: { pid: number; profile: LaunchProfileSnapshot; startedAt: string }): Promise<IdentityObservation>;
  }
  | { kind: 'unsupported' };

/** An answer to a CLI's start-up prompt the app can give on the user's behalf. */
export type StartupChoice = 'trust' | 'decline';

/**
 * A blocking prompt a CLI shows before it accepts any input (e.g. Agy asking
 * whether to trust the workspace). Anything typed meanwhile is eaten by it.
 * `selected` is the option under the cursor, or null if it can't be read;
 * `options` is the menu's answers in screen order, when known.
 */
export type StartupPromptReading = { kind: 'workspace_trust'; selected: StartupChoice | null; options?: StartupChoice[] };

/**
 * A menu read off the pane: the option under the cursor (null when it
 * can't be placed on exactly one) and the options in screen order.
 */
export type MenuReading<C extends string> = { selected: C | null; options: C[] };

/** The answers of a CLI's "update available" menu (Codex 0.163.0). */
export type UpdateChoice = 'update' | 'skip' | 'skip_version';

/** How the launch catalog offers a native (non-Janus) launch of this runtime. */
export type NativeProfileSpec = {
  // Key of this runtime's entry in launch-profiles.json's `native` map, and
  // the `native:<key>` profile id. The three pre-runtime keys are product
  // provider names, kept as they are stored.
  configKey: string;
  // A function when it is worded in the interface language (i18n), read
  // each time a profile list is made.
  label: string | (() => string);
  defaultExecutable: string;
};

/** A runtime whose CLI Janus can run as one of its accounts. */
export type JanusSupport = {
  // Where, under a Janus account's home, this CLI keeps its conversations.
  conversationSubdir: string;
};

/**
 * Usage/limit status of this CLI's accounts (account-status/). Absent means
 * no source is known: the account is listed as unsupported.
 */
export type AccountStatusSupport = {
  probe(account: AccountRef): Promise<AccountStatus>;
  // Variables that must not leak into a probe of the CLI's own default
  // (native) account, e.g. a parent CLAUDE_CONFIG_DIR.
  nativeUnsetEnv?: string[];
  // When the account's login runs out (ms since epoch), or null when it
  // can't be told. Absent: the provider has no such reading (status
  // `login: null`).
  readLoginExpiry?(account: AccountRef): Promise<number | null>;
  // Logging the account in again from the app. Absent: unsupported.
  login?: AccountLoginProtocol;
};

/**
 * Whether the app may reopen one of this runtime's recorded conversations:
 * recover it in a dead tmux, or switch back to it. `in_place`: buildResume
 * starts the CLI on that same conversation and the CLI keeps writing the
 * transcript file it was bound to, so the segment is reopened as it was
 * (its turns stay; later ones are appended). Anything else is unsupported
 * until verified, with the reason why. A runtime whose identity is
 * observed after start must also prove, before the resume counts, that the
 * process holds the resumed conversation (sync/resumeIdentity.ts).
 */
export type ResumeCapability =
  | { kind: 'in_place' }
  | { kind: 'unsupported'; reason: string };

/** The keys a model switch may press in a running CLI's pane. */
export type ModelTerminal = {
  capture(): Promise<string>;
  // Types text and submits it (Enter), as a message would be.
  submit(text: string): Promise<void>;
  // Types text without submitting it, e.g. a menu's option number.
  type(text: string): Promise<void>;
  sendKey(key: 'Escape'): Promise<void>;
  sleep?(ms: number): Promise<void>;
};

/**
 * How a switch ended. `switched`: the CLI confirmed it, under `label`.
 * `rejected`: the CLI refused (e.g. a model the account can't use), or the
 * model wasn't on its menu; nothing changed. `unsure`: no confirmation was
 * seen; the user should look at the terminal.
 */
export type ModelSwitchResult =
  | { status: 'switched'; label: string; effort: string | null }
  | { status: 'rejected'; message: string }
  | { status: 'unsure'; message: string };

/**
 * Listing and switching a running CLI's model, from inside the CLI itself,
 * so a switch also becomes that account's default for new sessions.
 */
export type ModelSupport = {
  // 'account': asked the CLI what this account can use; 'builtin': a fixed
  // list the CLI accepts by name.
  source: 'account' | 'builtin';
  list(profile: LaunchProfileSnapshot): Promise<ModelOption[]>;
  // Only called on an idle CLI; `effort` is one of option.efforts, or null
  // when it has none.
  switchModel(terminal: ModelTerminal, option: ModelOption, effort: string | null): Promise<ModelSwitchResult>;
};

/**
 * Everything specific to running one CLI: its transcript format (the
 * TranscriptAdapter part) plus launch/resume argv, process identity, exit,
 * session identity and native locations. Shared orchestration (routes,
 * polling, registry) reaches CLI behavior only through this contract.
 * Which CLI version each behavior was last verified against is tracked in
 * docs/reference/cli-version-alignment.md.
 */
export type RuntimeDriver = TranscriptAdapter & {
  runtimeId: RuntimeId;
  provider: Provider;
  /** Name shown to the user for this CLI (e.g. in notifications, and GET /meta). */
  label: string;
  nativeProfile: NativeProfileSpec;
  janus?: JanusSupport;
  accountStatus?: AccountStatusSupport;
  processIdentity: ProcessIdentity;
  buildLaunch(cwd: string, opts?: LaunchOpts): LaunchPlan;
  // `cwd`: the session's folder, which the conversation was recorded in.
  buildResume?(providerSessionId: string, cwd: string): LaunchPlan;
  resume: ResumeCapability;
  /**
   * Starting a new conversation that carries a recorded one's memory, in
   * another folder (a branch line, ADR 0023 決策 3): the recorded one is
   * left as it is. Absent means unsupported (a branch line then gets a
   * brief instead). Verified per version in cli-version-alignment.md.
   */
  fork?: { buildFork(fromProviderSessionId: string, cwd: string): LaunchPlan };
  /**
   * Recognizes the screen this CLI shows instead of a resumed conversation
   * that another process still holds open, and the key that leaves it
   * (exiting the CLI). Anything typed into it is read as menu keys. Absent
   * means none is known.
   */
  resumeConflict?: { detect(paneText: string): boolean; dismissKey: 'Escape' };
  buildExitPlan(): RuntimeExitPlan;
  // A version-verified key that interrupts an in-flight reply without
  // exiting, so a following exit lands at an idle prompt. Absent means
  // unverified: callers must not assume Claude's interrupt policy.
  interruptReply?: 'Escape';
  /**
   * How long this CLI's input box needs between typed text and the Enter
   * that submits it. Absent means unmeasured: the shared default delay in
   * tmux.sendText applies (see sync/input.ts).
   */
  submitDelayMs?: number;
  /**
   * How a message reaches the input box. `paste`: as one bracketed paste,
   * for a CLI that loses characters or the submitting Enter when long text
   * is typed key by key. Slash commands are still typed (sync/input.ts).
   * Absent means typed.
   */
  textInput?: 'paste';
  identity: RuntimeIdentityCapability;
  /**
   * Recognizes this runtime's version-verified start-up prompt in a pane
   * capture. Absent means none is known: callers then assume none.
   */
  readStartupPrompt?(paneText: string): StartupPromptReading | null;
  /** Where a native (non-Janus) launch of this runtime keeps its data. */
  nativeLocations(): { home: string; conversationRoot: string };
  /** Environment a native launch must set for the CLI to use the snapshot's home. */
  nativeLaunchEnv?(profile: Pick<LaunchProfileSnapshot, 'home'>): Record<string, string>;
  /** Environment every launch of this runtime sets, native or through Janus. */
  launchEnv?: Record<string, string>;
  /**
   * How every launch (fresh, resume, fork; native or through Janus) turns
   * off the CLI's own update check or self-update (ADR 0030): a CLI that
   * updates itself while in use runs an unverified version next, and one
   * that asks first puts a menu where the app types its first message.
   * `args` go right after the CLI's own subcommand, with the permission
   * mode's flags; `env` is set like launchEnv. Verified per version in
   * cli-version-alignment.md. Absent: no verified way (未處理).
   */
  updateCheckOff?: { args?: readonly string[]; env?: Readonly<Record<string, string>> };
  /**
   * Whether the pane ends with this CLI's own input box, ready for a
   * message: not a menu, not busy, not a shell. Version-verified against
   * captures (test/fixtures/launch-screens/). The first message after a
   * launch is typed only once this says so (ADR 0030). Absent: unverified,
   * and callers keep to the transcript-only checks.
   */
  readInputReady?(paneText: string): boolean;
  /**
   * The CLI's own update screens, version-verified: `read` its "update
   * available" menu (null when it isn't what the screen ends with), and
   * `updated` the screen it leaves behind once it has updated itself and
   * quit, asking to be started again. Absent: none known.
   */
  updatePrompt?: {
    read(paneText: string): MenuReading<UpdateChoice> | null;
    updated(paneText: string): boolean;
  };
  /** Version-verified model listing and switching. Absent means unsupported. */
  models?: ModelSupport;
  /**
   * The CLI arguments that start it in a launch permission mode other than
   * cli_default (contract/permissions.ts), placed right after its own
   * subcommand on every launch, resume and fork. null: no verified flags
   * for that mode. Absent: no mode but cli_default.
   */
  permissionArgs?(mode: Exclude<PermissionMode, 'cli_default'>): string[] | null;
  /**
   * Arguments of a native profile that already decide permissions (a flag
   * or `--flag=value`); a launch in any mode but cli_default refuses them
   * rather than pass two. `yoloOnly` ones conflict only with yolo.
   */
  permissionConflicts?: { always: readonly string[]; yoloOnly?: readonly string[] };
  /**
   * Why a mode it has flags for can't be used on this host right now, or
   * null. Absent: every mode with flags can be.
   */
  permissionModeUnavailable?(mode: Exclude<PermissionMode, 'cli_default'>): PermissionModeUnavailableReason | null;
};

export function runtimeForProvider(provider: Provider): RuntimeId {
  switch (provider) {
    case 'claude': return 'claude-code';
    case 'codex': return 'codex-cli';
    case 'gemini': return 'gemini-cli';
  }
}

/**
 * Native profile args come first. A bare `--flag` the runtime's plan adds is
 * dropped when the profile already passes it: Codex rejects `--no-daemon`
 * twice. A flag followed by a value is always kept.
 */
export function nativeLaunchArgs(profileArgs: readonly string[], planArgs: readonly string[]): string[] {
  const kept = planArgs.filter((arg, index) => !(arg.startsWith('--') && profileArgs.includes(arg)
    && (index + 1 >= planArgs.length || planArgs[index + 1]!.startsWith('-'))));
  return [...profileArgs, ...kept];
}
