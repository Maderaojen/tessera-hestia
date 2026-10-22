import type { Response, Router } from 'express';
import type { ErrorParams } from '../contract/errors.js';
import type { Processor } from '../contract/processor.js';

// Hestia's extension point (ADR 0022):
// an optional module is a folder under api/modules/ whose index exports a
// ModuleFactory as its default. Hestia finds it at startup (load.ts) and
// hands it this narrow host; a module reaches nothing else of Hestia's.
// Types only, so a module imports this file with `import type` and adds no
// runtime dependency on Hestia's internals.

/** Bumped when ModuleHost changes in a way an existing module would notice. */
export const MODULE_HOST_VERSION = 1;

/** A note as a module reads it: the text and its times, nothing of Hestia's own. */
export type ModuleNote = { id: string; text: string; createdAt: string; updatedAt: string; done: boolean };

/** How a CLI processor runs for this module: its own runner folder, timeout and log prefix. */
export type CliProcessorOptions = { runnerDir: string; timeoutMs: number; logTag: string; tmpPrefix: string };

/** An interface language, as Hestia's own text has them. */
export type ModuleLocale = 'zh-TW' | 'en-US';

/** The CLI processor on the account and model the user picked, or why there is none. */
export type CliProcessorChoice = { model: string; processor: Processor } | { unavailable: 'no_profile' };

export type ModuleHost = {
  version: typeof MODULE_HOST_VERSION;
  /** Hestia's state folder; a module keeps its data in names of its own under it. */
  stateDir: string;
  /**
   * The language of the text a person reads, now: the request's
   * (Accept-Language), else the host's remembered one. A module words its
   * own text in it.
   */
  locale(): ModuleLocale;
  projects: {
    /** Whether a project (the inbox counts) exists and isn't deleted. */
    exists(id: string): Promise<boolean>;
  };
  notes: {
    /** A list's notes, not those in its trash. */
    list(listId: string): Promise<ModuleNote[]>;
    /** Called when a project's notes change in a way that may need work; returns the unsubscribe. */
    onChanged(listener: (projectId: string) => void): () => void;
  };
  processors: {
    cli(options: CliProcessorOptions): Promise<CliProcessorChoice>;
  };
  http: {
    /** Answers a failed call the way every Hestia route does (contract/errors.ts). */
    sendError(res: Response, status: number, code: string, message: string, params?: ErrorParams): void;
  };
};

/** A router a module mounts under /api, behind the login. */
export type ModuleRoute = { path: string; router: Router };

export type HestiaModule = {
  id: string;
  /** Added to GET /meta's capabilities while the module is loaded. */
  capabilities: readonly string[];
  routes: ModuleRoute[];
  /** Background work, started once the backend is up. */
  start?(): void;
};

export type ModuleFactory = (host: ModuleHost) => HestiaModule | Promise<HestiaModule>;
