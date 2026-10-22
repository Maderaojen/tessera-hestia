// Which part of the backend may import which (ADR 0016 §2, ADR 0022).
// Relative imports
// are resolved to the file they name (a `.js` specifier is the `.ts`
// source) before the zones are compared, so the same rule means the same
// thing at any depth.
//
// - Hestia (src, test) never imports an optional module (modules/<name>):
//   a build without it must still be whole. It finds them at startup
//   (src/module-host/load.ts).
// - A module's core (modules/<name>/core, its tests in
//   modules/<name>/test/core) uses only itself, its module's contract,
//   the shared contracts and the json-file-store package; the rest of the module
//   reaches it through its index.ts.
// - A module's contract (modules/<name>/contract) imports only itself and
//   src/contract: the web app bundles it.
// - A module's text (modules/<name>/i18n: its locale and prompt files and
//   their lookup) imports only itself and the framework-free translator
//   (@maderaojen/i18n-vue/core); its core and the rest of the module may
//   use it. The language comes from the host (ModuleHost.locale), handed in.
// - The rest of a module (its routes, wiring, entry) uses its own folder,
//   the module host's types (type-only), the contracts and a few
//   packages (json-file-store among them). A module's own tests may also use Hestia and any
//   package; like the rest of the module, they reach its core through
//   its index.ts (the core's own tests, in test/core, reach inside it).
// - contract/processor.ts imports nothing, and a processor never imports
//   recap.
import { builtinModules } from 'node:module';
import path from 'node:path';

const PROCESSOR_CONTRACT = 'src/contract/processor.ts';
const MODULE_HOST_TYPES = 'src/module-host/types.ts';
// What a core may use of Hestia's: contracts that aren't Hestia's own.
// Its one generic file helper is a package (CORE_PACKAGES).
const CORE_SHARED = new Set([
  'src/contract/errors.ts',
  'src/contract/tags.ts',
  'src/contract/projects.ts',
  'src/contract/attachments.ts',
  PROCESSOR_CONTRACT,
]);
const CORE_PACKAGES = new Set(['zod', '@maderaojen/json-file-store']);
const MODULE_PACKAGES = new Set(['zod', 'express', '@maderaojen/json-file-store']);
const I18N_PACKAGES = new Set(['@maderaojen/i18n-vue']);
const TEST_PACKAGES = new Set(['vitest']);
const NODE_BUILTINS = new Set(builtinModules);
// Running programs is a processor's job, never a module's.
const FORBIDDEN_BUILTINS = new Set(['child_process']);

const MODULE = /^modules\/([^/]+)\//;
const CORE = /^modules\/([^/]+)\/(?:test\/)?core\//;
const CORE_SOURCE = /^modules\/([^/]+)\/core\//;
const MODULE_CONTRACT = /^modules\/([^/]+)\/contract\//;
const MODULE_I18N = /^modules\/([^/]+)\/i18n\//;
const MODULE_TEST = /^modules\/[^/]+\/test\//;

const toPosix = (file) => file.split(path.sep).join('/');
const moduleOf = (file) => MODULE.exec(file)?.[1] ?? null;
const coreOf = (file) => CORE.exec(file)?.[1] ?? null;
const contractOf = (file) => MODULE_CONTRACT.exec(file)?.[1] ?? null;
const i18nOf = (file) => MODULE_I18N.exec(file)?.[1] ?? null;
const isTest = (file) => file.startsWith('test/') || MODULE_TEST.test(file);

function packageName(source) {
  const bare = source.startsWith('node:') ? source.slice('node:'.length) : source;
  const parts = bare.split('/');
  return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function packageAllowed(source, allowed, test) {
  const name = packageName(source);
  if (source.startsWith('node:') || NODE_BUILTINS.has(name)) return !FORBIDDEN_BUILTINS.has(name);
  return allowed.has(name) || (test && TEST_PACKAGES.has(name));
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keeps Hestia, its optional modules and their cores apart (ADR 0016, 0022).' },
    schema: [{ type: 'object', properties: { root: { type: 'string' } }, required: ['root'], additionalProperties: false }],
    messages: {
      processorContract: 'contract/processor.ts imports nothing: other implementations copy it as it is.',
      processorToRecap: 'A processor may not import recap ({{target}}): it is the recap adapter that uses processors.',
      contractToModule: 'Hestia\'s contract may not import a module; the web app bundles contracts alone.',
      hostToModule: 'Hestia may not import an optional module ({{target}}): it finds modules at startup (src/module-host/load.ts).',
      coreReach: 'A module\'s core may not import {{target}} (only itself, its contract, its text, the shared contracts and json-file-store).',
      i18nReach: 'A module\'s text (i18n/) imports only itself and the translator, not {{target}}.',
      corePackage: 'A module\'s core may not use the package {{target}}.',
      coreDeep: 'Import a module\'s core through {{entry}}, not {{target}}.',
      moduleContractReach: 'A module\'s contract imports only itself and src/contract, not {{target}}: the web app bundles it.',
      moduleReach: 'A module may import only its own folder, the contracts, json-file-store and the module host\'s types, not {{target}}.',
      moduleHostValue: 'Import the module host\'s types with `import type`: a module adds no runtime dependency on Hestia.',
      modulePackage: 'A module may not use the package {{target}}.',
    },
  },
  create(context) {
    const root = context.options[0].root;
    const importer = toPosix(path.relative(root, context.filename));
    if (importer.startsWith('..')) return {};
    const importerModule = moduleOf(importer);
    const importerCore = coreOf(importer);
    const importerContract = contractOf(importer);
    const importerI18n = i18nOf(importer);
    // A module's routes, wiring and entry: not its core, contract, text or tests.
    const moduleCode = importerModule !== null && importerCore === null && importerContract === null && importerI18n === null && !isTest(importer);

    function checkPackage(node, source) {
      if (importerCore) {
        if (!packageAllowed(source, CORE_PACKAGES, isTest(importer))) context.report({ node, messageId: 'corePackage', data: { target: source } });
      } else if (importerI18n) {
        if (!I18N_PACKAGES.has(packageName(source))) context.report({ node, messageId: 'i18nReach', data: { target: source } });
      } else if (importerContract) {
        context.report({ node, messageId: 'moduleContractReach', data: { target: source } });
      } else if (moduleCode) {
        if (!packageAllowed(source, MODULE_PACKAGES, false)) context.report({ node, messageId: 'modulePackage', data: { target: source } });
      }
    }

    function check(node, source, typeOnly) {
      if (typeof source !== 'string') return;
      if (importer === PROCESSOR_CONTRACT) {
        context.report({ node, messageId: 'processorContract' });
        return;
      }
      if (!source.startsWith('.')) {
        checkPackage(node, source);
        return;
      }
      const resolved = path.resolve(path.dirname(context.filename), source).replace(/\.js$/, '.ts');
      const target = toPosix(path.relative(root, resolved));

      if (importerCore) {
        if (coreOf(target) !== importerCore && contractOf(target) !== importerCore && i18nOf(target) !== importerCore && !CORE_SHARED.has(target)) {
          context.report({ node, messageId: 'coreReach', data: { target } });
        }
        return;
      }
      if (importerI18n) {
        if (i18nOf(target) !== importerI18n) context.report({ node, messageId: 'i18nReach', data: { target } });
        return;
      }
      if (importerContract) {
        if (contractOf(target) !== importerContract && !target.startsWith('src/contract/')) {
          context.report({ node, messageId: 'moduleContractReach', data: { target } });
        }
        return;
      }
      if (importer.startsWith('src/contract/') && target.startsWith('modules/')) {
        context.report({ node, messageId: 'contractToModule' });
        return;
      }
      if ((importer.startsWith('src/') || importer.startsWith('test/')) && target.startsWith('modules/')) {
        context.report({ node, messageId: 'hostToModule', data: { target } });
        return;
      }
      const core = CORE_SOURCE.exec(target)?.[1];
      if (core && target !== `modules/${core}/core/index.ts`) {
        context.report({ node, messageId: 'coreDeep', data: { target, entry: `modules/${core}/core/index.ts` } });
        return;
      }
      if (moduleCode) {
        if (target === MODULE_HOST_TYPES) {
          if (!typeOnly) context.report({ node, messageId: 'moduleHostValue' });
          return;
        }
        const own = moduleOf(target) === importerModule && !MODULE_TEST.test(target);
        if (!own && !target.startsWith('src/contract/')) {
          context.report({ node, messageId: 'moduleReach', data: { target } });
        }
        return;
      }
      if (importer.startsWith('src/processors/') && target.startsWith('src/recap/')) {
        context.report({ node, messageId: 'processorToRecap', data: { target } });
      }
    }

    const typeOnlyImport = (node) => node.importKind === 'type'
      || (node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.importKind === 'type'));
    return {
      ImportDeclaration: (node) => check(node, node.source.value, typeOnlyImport(node)),
      ExportNamedDeclaration: (node) => { if (node.source) check(node, node.source.value, node.exportKind === 'type'); },
      ExportAllDeclaration: (node) => check(node, node.source.value, node.exportKind === 'type'),
      ImportExpression: (node) => { if (node.source.type === 'Literal') check(node, node.source.value, false); },
      // `typeof import('…')` in a type position.
      // `source` in newer typescript-eslint, `argument` before it.
      TSImportType: (node) => {
        const literal = 'source' in node ? node.source : node.argument?.type === 'TSLiteralType' ? node.argument.literal : null;
        if (literal?.type === 'Literal') check(node, literal.value, true);
      },
    };
  },
};

export default rule;
