// What the backend needs from the operating system it runs on, as small
// interfaces with one implementation per platform (linux.ts, darwin.ts,
// unsupported.ts), picked once in index.ts. Core code (tmux.ts, the
// runtime observers) only ever calls these; it never asks which platform
// it is on.

export type HostPlatformId = 'linux' | 'darwin' | 'unsupported';

/** One row of the system process table. */
export type ProcessEntry = {
  pid: number;
  ppid: number;
  // The command's name as Linux reports it (/proc/<pid>/comm, ps comm):
  // a bare name, never a path, e.g. `claude`, `codex`, `node`.
  comm: string;
  // The full command line, argv joined by spaces.
  args: string;
};

/** What a runtime observer may look at in one live process. */
export type ProcessView = {
  pid: number;
  // As ProcessEntry.comm.
  comm: string;
  // The executable's path; null when the system does not expose it
  // (permissions, exited process).
  exe: string | null;
  // Every currently open descriptor's target, e.g. a file path or `socket:[…]`.
  openFiles: string[];
};

export type ProcessInspection<T> =
  | { status: 'observed'; value: T }
  | { status: 'unavailable' } // unsupported platform, no such process, unreadable
  | { status: 'changed' }; // the PID was reused or restarted while looking

/**
 * Read-only look at one process, fenced by its start time: the view is
 * trusted only when the same process (same PID *and* start time) existed
 * before and after `inspect` ran. Every failure is reported, never thrown,
 * so identity observers fail closed.
 */
export type ProcessInspector = {
  inspect<T>(pid: number, inspect: (view: ProcessView) => T | Promise<T>): Promise<ProcessInspection<T>>;
};

/** The process table, as tmux pane liveness walks it. */
export type ProcessTable = {
  /** Every process on the system. Throws when it can't be read. */
  list(): Promise<ProcessEntry[]>;
  /**
   * The name of the command in the foreground of a tmux pane, as tmux on
   * Linux reports #{pane_current_command} (argv[0]'s base name): given what
   * tmux reported and the pane's root pid. Falls back to `reported`.
   */
  paneCommand(reported: string, panePid: number | null): Promise<string>;
};

/**
 * Starting this install's own tmux server so that stopping or restarting
 * the API service never takes it (and every session in it) along.
 */
export type TmuxServerLauncher = {
  /**
   * The command line that starts `argv` (a `tmux -L … new-session …`)
   * detached from the service, or null to run `argv` as it is.
   */
  detached(argv: readonly string[], description: string): Promise<string[] | null>;
};

/** The service install.sh runs the API as, for what the CLI tells the user. */
export type ServiceManager = {
  /** A command restarting the default install's service, or null where install.sh makes none. */
  restartCommand(): string | null;
};

/** This machine's sshd, for what `hestia ssh-authorize` tells the user when it doesn't answer. */
export type SshdInfo = {
  /** Whether sshd being off is a setting the user turns on (macOS: Remote Login). */
  remoteLoginSetting: boolean;
};

export type HostPlatform = {
  readonly id: HostPlatformId;
  readonly processes: ProcessTable;
  readonly inspector: ProcessInspector;
  readonly tmuxServer: TmuxServerLauncher;
  readonly service: ServiceManager;
  readonly sshd: SshdInfo;
};

/** Runs a program and resolves to its stdout; rejects on a non-zero exit. */
export type CommandRunner = (file: string, args: readonly string[], options?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<string>;
