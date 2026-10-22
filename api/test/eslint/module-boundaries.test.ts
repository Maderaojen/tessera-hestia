import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from '../../eslint/module-boundaries.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const at = (file: string) => path.join(root, file);
const options = [{ root }];

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' } });

// A made-up module, modules/example, so the rule is checked on its own terms.
tester.run('module-boundaries', rule, {
  valid: [
    // Extracted storage remains an explicitly allowed foundational package.
    { filename: at('modules/example/core/store.ts'), code: "import { jsonFileStore } from '@maderaojen/json-file-store';", options },
    { filename: at('modules/example/routes/a.ts'), code: "import { writeFileAtomic } from '@maderaojen/json-file-store';", options },
    // A module's core uses itself, its contract, the shared contracts, json-file-store, zod and node.
    { filename: at('modules/example/core/a/b.ts'), code: "import { x } from '../c/d.js'; import { y } from '../index.js';", options },
    { filename: at('modules/example/core/a/b.ts'), code: "import type { C } from '../../contract/c.js';", options },
    { filename: at('modules/example/core/a/b.ts'), code: "import { extractTags } from '../../../../src/contract/tags.js';", options },
    { filename: at('modules/example/core/a/b.ts'), code: "import type { ProcessorRequest } from '../../../../src/contract/processor.js';", options },
    { filename: at('modules/example/core/a/b.ts'), code: "import { z } from 'zod'; import path from 'node:path'; import { readFile } from 'fs/promises';", options },
    // Its text: the core and the rest of the module use it; it uses itself and the translator.
    { filename: at('modules/example/core/a/b.ts'), code: "import { prompt, t } from '../../i18n/index.js';", options },
    { filename: at('modules/example/wiring.ts'), code: "import { t } from './i18n/index.js';", options },
    { filename: at('modules/example/i18n/index.ts'), code: "import { createTranslator } from '@maderaojen/i18n-vue/core'; import { MESSAGES } from './messages.js';", options },
    { filename: at('modules/example/i18n/messages.ts'), code: "import zh from './locales/zh-TW/a.json' with { type: 'json' };", options },
    // Its tests may reach anywhere inside it, and use vitest.
    { filename: at('modules/example/test/core/a/b.test.ts'), code: "import { describe } from 'vitest'; import { x } from '../../../core/a/b.js';", options },
    // A module's contract: itself and Hestia's.
    { filename: at('modules/example/contract/a.ts'), code: "import type { B } from './b.js'; import type { ProcessorFailureCode } from '../../../src/contract/processor.js';", options },
    // The rest of the module: its own folder, its core through the entry
    // point, the contracts, json-file-store, the host's types, a few packages.
    { filename: at('modules/example/index.ts'), code: "import type { ModuleFactory } from '../../src/module-host/types.js'; import { x } from './routes/a.js'; import { y } from './core/index.js';", options },
    { filename: at('modules/example/routes/a.ts'), code: "import { Router } from 'express'; import { z } from 'zod'; import path from 'node:path'; import { CODES } from '../contract/index.js'; import type { ErrorParams } from '../../../src/contract/errors.js'; import { jsonFileStore } from '@maderaojen/json-file-store';", options },
    { filename: at('modules/example/wiring.ts'), code: "import { type ModuleHost } from '../../src/module-host/types.js';", options },
    // Its own tests may reach into Hestia.
    { filename: at('modules/example/test/integration.test.ts'), code: "import request from 'supertest'; import { createApp } from '../../../src/server.js'; import { loadModules } from '../../../src/module-host/load.js';", options },
    { filename: at('modules/example/core/index.ts'), code: "export type { X } from '../contract/x.js'; type Y = typeof import('./a/b.js');", options },
    { filename: at('modules/example/test/core/a/b.test.ts'), code: "import { readFileSync } from 'node:fs'; import { it } from 'vitest';", options },
    { filename: at('modules/example/paths.ts'), code: "import path from 'node:path';", options },
    { filename: at('modules/example/routes/a.ts'), code: "export { x } from '../core/index.js';", options },
    { filename: at('modules/example/test/routes/a.test.ts'), code: "import { x } from '../../core/index.js'; import { sendError } from '../../../../src/routes/errors.js';", options },
    // Hestia's own module host, and its test fixtures (not under modules/).
    { filename: at('src/module-host/load.ts'), code: "import type { HestiaModule } from './types.js'; import { readdir } from 'node:fs/promises';", options },
    { filename: at('test/module-host/load.test.ts'), code: "import x from '../fixtures/modules/example/index.js';", options },
    // Hestia itself is untouched by the rule otherwise.
    { filename: at('src/notes-store.ts'), code: "import { createNotesStore } from './notes/store.js';", options },
    { filename: at('src/routes/notes.ts'), code: "import * as tmux from '../tmux.js'; import express from 'express';", options },
    { filename: at('src/contract/projects.ts'), code: "import type { UploadedAttachment } from './attachments.js';", options },
    { filename: at('src/processors/cli/processor.ts'), code: "import { spawn } from 'node:child_process'; import { getRuntimeDriver } from '../../runtimes/index.js';", options },
  ],
  invalid: [
    // A core reaching into Hestia, another module, or running programs.
    { filename: at('modules/example/core/a/b.ts'), code: "import { NOTES_DIR } from '../../../../src/config.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/index.ts'), code: "import * as tmux from '../../../src/tmux.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/index.ts'), code: "import type { Turn } from '../../../src/contract/sessions.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/index.ts'), code: "export * from '../../../src/recap/schema.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/index.ts'), code: "const registry = await import('../../../src/registry.js');", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/index.ts'), code: "type R = typeof import('../../../src/registry.js');", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/index.ts'), code: "import { x } from '../routes/a.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/a/b.ts'), code: "import { x } from '../../../other/core/index.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/a/b.ts'), code: "import type { C } from '../../../other/contract/c.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/core/a/b.ts'), code: "import { spawn } from 'node:child_process';", options, errors: [{ messageId: 'corePackage' }] },
    { filename: at('modules/example/core/a/b.ts'), code: "import { execFile } from 'child_process';", options, errors: [{ messageId: 'corePackage' }] },
    { filename: at('modules/example/core/a/b.ts'), code: "import express from 'express';", options, errors: [{ messageId: 'corePackage' }] },
    { filename: at('modules/example/core/a/b.ts'), code: "import { describe } from 'vitest';", options, errors: [{ messageId: 'corePackage' }] },
    { filename: at('modules/example/test/core/a/b.test.ts'), code: "import { NOTES_DIR } from '../../../../../src/config.js';", options, errors: [{ messageId: 'coreReach' }] },
    // A module's text reaches nothing else; the contract doesn't use it (the web app bundles the contract).
    { filename: at('modules/example/i18n/index.ts'), code: "import { currentLocale } from '../../../src/i18n/index.js';", options, errors: [{ messageId: 'i18nReach' }] },
    { filename: at('modules/example/i18n/index.ts'), code: "import { x } from '../core/index.js';", options, errors: [{ messageId: 'i18nReach' }] },
    { filename: at('modules/example/i18n/index.ts'), code: "import { z } from 'zod';", options, errors: [{ messageId: 'i18nReach' }] },
    { filename: at('modules/example/contract/a.ts'), code: "import { t } from '../i18n/index.js';", options, errors: [{ messageId: 'moduleContractReach' }] },
    { filename: at('modules/example/core/a/b.ts'), code: "import { t } from '../../../other/i18n/index.js';", options, errors: [{ messageId: 'coreReach' }] },
    // The contracts.
    { filename: at('src/contract/processor.ts'), code: "import type { RecapErrorCode } from './recap.js';", options, errors: [{ messageId: 'processorContract' }] },
    { filename: at('src/contract/processor.ts'), code: "import { z } from 'zod';", options, errors: [{ messageId: 'processorContract' }] },
    { filename: at('src/contract/projects.ts'), code: "import type { X } from '../../modules/example/contract/index.js';", options, errors: [{ messageId: 'contractToModule' }] },
    { filename: at('modules/example/contract/a.ts'), code: "import { x } from '../routes/a.js';", options, errors: [{ messageId: 'moduleContractReach' }] },
    { filename: at('modules/example/contract/a.ts'), code: "import { z } from 'zod';", options, errors: [{ messageId: 'moduleContractReach' }] },
    { filename: at('modules/example/contract/a.ts'), code: "import { STATE_DIR } from '../../../src/config.js';", options, errors: [{ messageId: 'moduleContractReach' }] },
    // Hestia never imports a module.
    { filename: at('src/server.ts'), code: "import { x } from '../modules/example/core/index.js';", options, errors: [{ messageId: 'hostToModule' }] },
    { filename: at('src/main.ts'), code: "const m = await import('../modules/example/index.js');", options, errors: [{ messageId: 'hostToModule' }] },
    { filename: at('test/server.test.ts'), code: "import { x } from '../modules/example/routes/a.js';", options, errors: [{ messageId: 'hostToModule' }] },
    { filename: at('test/notes-store.test.ts'), code: "type T = typeof import('../modules/example/index.js');", options, errors: [{ messageId: 'hostToModule' }] },
    // The rest of a module.
    { filename: at('modules/example/routes/a.ts'), code: "import { x } from '../core/a/b.js';", options, errors: [{ messageId: 'coreDeep' }] },
    { filename: at('modules/example/routes/a.ts'), code: "import { getProject } from '../../../src/project-store.js';", options, errors: [{ messageId: 'moduleReach' }] },
    { filename: at('modules/example/routes/a.ts'), code: "import { sendError } from '../../../src/routes/errors.js';", options, errors: [{ messageId: 'moduleReach' }] },
    { filename: at('modules/example/routes/a.ts'), code: "import { x } from '../../other/index.js';", options, errors: [{ messageId: 'moduleReach' }] },
    { filename: at('modules/example/routes/a.ts'), code: "import { x } from '../test/helpers.js';", options, errors: [{ messageId: 'moduleReach' }] },
    { filename: at('modules/example/index.ts'), code: "import { MODULE_HOST_VERSION } from '../../src/module-host/types.js';", options, errors: [{ messageId: 'moduleHostValue' }] },
    { filename: at('modules/example/index.ts'), code: "import request from 'supertest';", options, errors: [{ messageId: 'modulePackage' }] },
    { filename: at('modules/example/wiring.ts'), code: "import { spawn } from 'node:child_process';", options, errors: [{ messageId: 'modulePackage' }] },
    { filename: at('modules/example/core/index.ts'), code: "export * from '../../../src/registry.js';", options, errors: [{ messageId: 'coreReach' }] },
    { filename: at('modules/example/contract/a.ts'), code: "import type { X } from '../core/index.js';", options, errors: [{ messageId: 'moduleContractReach' }] },
    { filename: at('modules/example/routes/a.ts'), code: "import { loadModules } from '../../../src/module-host/load.js';", options, errors: [{ messageId: 'moduleReach' }] },
    { filename: at('modules/example/routes/a.ts'), code: "const types = await import('../../../src/module-host/types.js');", options, errors: [{ messageId: 'moduleHostValue' }] },
    { filename: at('modules/example/test/routes/a.test.ts'), code: "import { x } from '../../core/a/b.js';", options, errors: [{ messageId: 'coreDeep' }] },
    { filename: at('test/module-host/load.test.ts'), code: "import x from '../../modules/example/index.js';", options, errors: [{ messageId: 'hostToModule' }] },
    { filename: at('src/contract/meta.ts'), code: "export * from '../../modules/example/contract/index.js';", options, errors: [{ messageId: 'contractToModule' }] },
    { filename: at('src/processors/cli/processor.ts'), code: "import { parseRecapOutput } from '../../recap/schema.js';", options, errors: [{ messageId: 'processorToRecap' }] },
  ],
});
