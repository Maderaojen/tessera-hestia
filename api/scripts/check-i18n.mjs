// The API's own text:
// what a person reads is in src/i18n/locales/{zh-TW,en-US}/<area>.json under
// a key; what the app writes for an LLM or types into a CLI is in
// src/i18n/prompts/<area>.json and src/contract/prompts/<area>.json, in
// Chinese only on purpose (it is what the LLMs are told). Code names keys.
// An optional module keeps its own text the same way inside its folder
// (modules/<name>/i18n/), checked on its own keys; the shell scripts
// (bin/hestia, scripts/install.sh and its scripts/install/platform-*.sh) read theirs from scripts/i18n/locales.
// Run with `npm run i18n:check` (also a test); exits 1 on any problem. Kept
// inside api/ because the public release is api/ alone (without modules/);
// the rules match the web app's (web/scripts/check-i18n.mjs).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

export const LOCALES = ['zh-TW', 'en-US'];
// area.feature.name, lowerCamel segments; the area is the file's name.
export const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,4}$/;
// Chinese characters, and the full-width punctuation that goes with them
// (，：（）「」・): code joining text with them shows Chinese punctuation
// in English too (common.format.* words it per language). The u flag
// keeps an emoji's surrogate pair from reading as one of them.
const IDEOGRAPH = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\u30fb\uff00-\uffef]/u;
// Chinese interface text uses 專案／工作階段／對話 (docs/reference/terminology.md);
// part of a hyphenated command name (tmux kill-session) is a name, not wording.
const ENGLISH_TERMS = /(?<![-\w])(?:sessions?|projects?|conversations?)\b/i;
// Each set of text checked on its own keys: Hestia's, each optional module's
// (modules/<name>, which the public release leaves out) and the shell
// scripts'. `locales`: what a person reads, both languages; `prompts`:
// deliberately Chinese only (prompts, briefs, records, lines typed into a
// CLI); `registries`: where each text file must be imported, so it is typed
// and compiled in; `code`: where the keys are used and no Chinese may be.
const HESTIA = {
  locales: 'src/i18n/locales',
  prompts: ['src/i18n/prompts', 'src/contract/prompts'],
  registries: { 'src/i18n/locales': 'src/i18n/messages.ts', 'src/i18n/prompts': 'src/i18n/messages.ts', 'src/contract/prompts': 'src/contract/typed.ts' },
  code: ['src', 'scripts'],
};
const moduleScope = (base) => ({
  locales: `${base}/i18n/locales`,
  prompts: [`${base}/i18n/prompts`],
  registries: { [`${base}/i18n/locales`]: `${base}/i18n/messages.ts`, [`${base}/i18n/prompts`]: `${base}/i18n/messages.ts` },
  code: [base],
  // Its tests and their helpers, like Hestia's test/, aren't code here.
  skip: `${base}/test/`,
});
// The shell can't import the translator: scripts/i18n/msg.sh reads the
// JSON line by line, so each file must be written one key to a line.
const SHELL = { locales: 'scripts/i18n/locales', prompts: [], registries: {}, shell: ['bin/hestia', 'scripts/install.sh', 'scripts/install/platform-linux.sh', 'scripts/install/platform-darwin.sh', 'scripts/i18n/msg.sh'] };

// Chinese in code that isn't text to move: matching what CLIs wrote and
// older versions stored, and character classes. Each entry must still match
// a line, so one left behind after its code goes is reported too.
export const ALLOWED_CJK = [
  { file: 'src/attachments.ts', match: /請看這張圖片：/, reason: 'the prompt older app versions sent with an image; matched in transcripts byte for byte' },
  { file: 'src/contract/continuity.ts', match: /額度快用完了，接下來會交給另一個LLM接手。/, reason: 'the opening an older version typed for a handoff, still recognized in transcripts' },
  { file: 'src/contract/delegation.ts', match: /你的交付被退回了/, reason: 'recognizes a send-back line in transcripts, also one recorded with its head cut off' },
  { file: 'src/contract/sessions.ts', match: /LEGACY_INTERRUPTED_MARKER = '（已中斷）'/, reason: 'the marker older versions appended to an interrupted reply, stripped when read' },
  { file: 'src/types.ts', match: /STUCK_HINT_TEXT = /, reason: 'what older records hold in lastError, matched to migrate them' },
  { file: 'src/contract/spawnTitle.ts', match: /const WIDE = /, reason: 'a character class (double-width characters), not text' },
  { file: 'src/contract/spawnTitle.ts', match: /const CLAUSE_END = /, reason: 'a character class (where a clause ends, Chinese punctuation too), not text' },
  { file: 'src/continuity/segment-backfill.ts', match: /const BRIEF_FILE = /, reason: 'parses a brief\'s file name out of what was typed into a CLI, full-width parentheses around it included' },
  { file: 'src/continuity/handoff.ts', match: /ctx\.record\('handoff_brief'/, reason: 'the handoff_brief event\'s detail as the records have always held it: the source, then the brief\'s own (Chinese) reason; the app words the reason from briefNoteCode' },
  { file: 'src/providers/claude-suggestion.ts', match: /const WIDE = /, reason: 'a character class (double-width characters), not text' },
];

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}

const blank = (text) => text.replace(/[^\n]/g, ' ');

/** TypeScript with its comments blanked out (line numbers kept); strings, templates and regex literals stay. */
export function stripComments(text) {
  let out = '';
  let i = 0;
  let last = '';
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`' || (c === '/' && (!last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (c === '/' && text[j] === '[') inClass = true;
        else if (c === '/' && text[j] === ']') inClass = false;
        else if (text[j] === c && !inClass) break;
        else if (c !== '`' && text[j] === '\n') break;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      last = c;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

const placeholders = (message) => [...message.matchAll(/\{\w+\}/g)].map(([match]) => match).sort().join(',');

function readArea(problems, path, label) {
  const area = path.split('/').at(-1).slice(0, -'.json'.length);
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(entries)) {
    if (!KEY_PATTERN.test(key)) problems.push(`${label}: "${key}" is not a key (area.feature.name, lowerCamel)`);
    else if (key.split('.')[0] !== area) problems.push(`${label}: "${key}" belongs in ${key.split('.')[0]}.json`);
    if (typeof value !== 'string') problems.push(`${label}: "${key}" is not text`);
  }
  return entries;
}

/** Every problem with the text files and the code's use of them; empty when all is well. */
export function checkI18n(api) {
  const problems = [];
  const allowedUsed = new Set();
  const modules = existsSync(join(api, 'modules'))
    ? readdirSync(join(api, 'modules')).filter((name) => statSync(join(api, 'modules', name)).isDirectory()).sort()
    : [];
  for (const scope of [HESTIA, ...modules.map((name) => moduleScope(`modules/${name}`)), SHELL]) checkScope(api, scope, problems, allowedUsed);
  ALLOWED_CJK.forEach((entry, index) => {
    if (!allowedUsed.has(index) && existsSync(join(api, entry.file))) problems.push(`ALLOWED_CJK entry for ${entry.file} matches nothing; remove it`);
  });
  return problems;
}

function checkScope(api, scope, problems, allowedUsed) {
  const rel = (path) => relative(api, path).replaceAll('\\', '/');

  // Interface text: both languages, the same files and keys.
  const messages = {};
  const areaFiles = {};
  for (const locale of LOCALES) {
    messages[locale] = {};
    const directory = join(api, scope.locales, locale);
    areaFiles[locale] = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.json')).sort() : [];
    for (const name of areaFiles[locale]) {
      const path = join(directory, name);
      Object.assign(messages[locale], readArea(problems, path, `${scope.locales}/${locale}/${name}`));
      if (scope.shell) {
        const text = readFileSync(path, 'utf8');
        if (text !== `${JSON.stringify(JSON.parse(text), null, 2)}\n`) problems.push(`${rel(path)}: write it one key to a line (JSON.stringify(…, null, 2)); the shell reads it by lines`);
      }
    }
  }
  const [zhFiles, enFiles] = LOCALES.map((locale) => areaFiles[locale]);
  for (const name of zhFiles) if (!enFiles.includes(name)) problems.push(`${scope.locales}/en-US/${name} is missing (zh-TW has it)`);
  for (const name of enFiles) if (!zhFiles.includes(name)) problems.push(`${scope.locales}/zh-TW/${name} is missing (en-US has it)`);
  const zh = messages['zh-TW'];
  const en = messages['en-US'];
  for (const key of Object.keys(zh)) if (!(key in en)) problems.push(`English is missing: ${key}`);
  for (const key of Object.keys(en)) if (!(key in zh)) problems.push(`Chinese is missing: ${key}`);
  for (const [key, chinese] of Object.entries(zh)) {
    // Placeholders and command options (--session) are names, not wording.
    if (ENGLISH_TERMS.test(chinese.replace(/\{\w+\}|--[\w-]+/g, ''))) problems.push(`Chinese uses an English term (專案／工作階段／對話): ${key}`);
    const english = en[key];
    if (english === undefined) continue;
    if (placeholders(chinese) !== placeholders(english)) problems.push(`Placeholders differ between languages: ${key}`);
    if (IDEOGRAPH.test(english)) problems.push(`English has Chinese characters: ${key}`);
  }

  // Prompts: Chinese only, one directory per kind; a key lives in one place.
  const prompts = {};
  for (const directory of scope.prompts) {
    for (const path of files(join(api, directory)).filter((name) => name.endsWith('.json'))) {
      for (const [key, value] of Object.entries(readArea(problems, path, rel(path)))) {
        if (key in prompts || key in zh) problems.push(`${rel(path)}: "${key}" is defined twice`);
        prompts[key] = value;
      }
    }
  }

  // Each text file is imported by its registry, or its keys aren't typed.
  for (const [directory, registry] of Object.entries(scope.registries)) {
    const source = existsSync(join(api, registry)) ? readFileSync(join(api, registry), 'utf8') : '';
    const base = relative(join(api, registry, '..'), join(api, directory)).replaceAll('\\', '/');
    for (const path of files(join(api, directory)).filter((name) => name.endsWith('.json'))) {
      const wanted = `./${base}/${relative(join(api, directory), path).replaceAll('\\', '/')}`;
      if (!source.includes(`'${wanted}'`)) problems.push(`${registry} doesn't import ${wanted}`);
    }
  }

  // The code: keys named exist in the right files; every key is named
  // somewhere (a string literal counts, so keys passed around as values do);
  // no Chinese outside comments.
  const calls = [
    { pattern: /\b(?:t\(|tIn\([^,()]+,)\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g, known: zh, what: 'interface text' },
    { pattern: /\b(?:prompt|typedText)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g, known: prompts, what: 'prompt' },
  ];
  const used = new Set();
  const chineseIn = (file, text) => text.split('\n').forEach((line, index) => {
    if (!IDEOGRAPH.test(line)) return;
    const allowed = ALLOWED_CJK.findIndex((entry) => entry.file === file && entry.match.test(line));
    if (allowed >= 0) allowedUsed.add(allowed);
    else problems.push(`${file}:${index + 1}: Chinese in code; move it to a locale or prompt file (or, if it is matched against what a CLI or an older version wrote, to ALLOWED_CJK in scripts/check-i18n.mjs): ${line.trim().slice(0, 80)}`);
  });
  for (const directory of scope.code ?? []) {
    for (const path of files(join(api, directory))) {
      const file = rel(path);
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || (scope.skip && file.startsWith(scope.skip))) continue;
      const text = stripComments(readFileSync(path, 'utf8'));
      for (const { pattern, known, what } of calls) {
        for (const match of text.matchAll(pattern)) {
          const argument = match[2];
          const line = text.slice(0, match.index).split('\n').length;
          if (!(argument in known)) problems.push(`${file}:${line}: not a key of the ${what} files: ${JSON.stringify(argument)}`);
        }
      }
      for (const match of text.matchAll(/(['"`])([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,4})\1/g)) used.add(match[2]);
      chineseIn(file, text);
    }
  }
  // Shell scripts: `msg KEY …` (scripts/i18n/msg.sh); comments are whole lines starting with #.
  for (const file of scope.shell ?? []) {
    if (!existsSync(join(api, file))) continue;
    const text = readFileSync(join(api, file), 'utf8').split('\n').map((line) => (/^\s*#/.test(line) ? '' : line)).join('\n');
    for (const match of text.matchAll(/(?:^|[\s;|&(`$])msg\s+([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,4})\b/g)) {
      const line = text.slice(0, match.index).split('\n').length;
      if (!(match[1] in zh)) problems.push(`${file}:${line}: not a key of the shell's text files: ${JSON.stringify(match[1])}`);
      used.add(match[1]);
    }
    chineseIn(file, text);
  }
  for (const key of [...Object.keys(zh), ...Object.keys(prompts)]) if (!used.has(key)) problems.push(`Unused key: ${key}`);
}

// Run as a script (a test imports it without a file URL).
if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkI18n(fileURLToPath(new URL('../', import.meta.url)));
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`${problems.length} problem(s). Text a person reads goes in src/i18n/locales/ (both languages; a module's in modules/<name>/i18n/locales/, the shell scripts' in scripts/i18n/locales/); text for an LLM or a CLI in src/i18n/prompts/ (Chinese only; a module's in modules/<name>/i18n/prompts/).`);
    process.exitCode = 1;
  } else {
    console.log('API text (Hestia, its modules, its shell scripts): every key exists (interface text in both languages, prompts in Chinese) and is used; no text in the code.');
  }
}
