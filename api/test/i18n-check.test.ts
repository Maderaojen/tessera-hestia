import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script, no declarations
import { checkI18n } from '../scripts/check-i18n.mjs';
import { localeFromAcceptLanguage, localeFromEnv, prompt, t, tIn } from '../src/i18n/index.js';

const API = fileURLToPath(new URL('../', import.meta.url));

describe('the API\'s text files (scripts/check-i18n.mjs)', () => {
  it('has no problems', () => {
    expect(checkI18n(API)).toEqual([]);
  });

  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir!, file)), { recursive: true });
    writeFileSync(path.join(dir!, file), text);
  };

  it('finds a missing English text, an unknown key, an unused one and Chinese in code', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'api-check-i18n-'));
    write('src/i18n/locales/zh-TW/demo.json', JSON.stringify({ 'demo.a.one': '一 {n}', 'demo.a.two': '二' }));
    write('src/i18n/locales/en-US/demo.json', JSON.stringify({ 'demo.a.one': 'One' }));
    write('src/i18n/prompts/brief.json', JSON.stringify({ 'brief.a.one': '說明' }));
    write('src/i18n/messages.ts', "import a from './locales/zh-TW/demo.json';\nimport b from './locales/en-US/demo.json';\n");
    write('src/x.ts', "t('demo.a.one');\nt('demo.a.three');\nconst s = '中文';\n");
    expect(checkI18n(dir)).toEqual(expect.arrayContaining([
      'English is missing: demo.a.two',
      'Placeholders differ between languages: demo.a.one',
      'src/i18n/messages.ts doesn\'t import ./prompts/brief.json',
      'src/x.ts:2: not a key of the interface text files: "demo.a.three"',
      expect.stringMatching(/^src\/x\.ts:3: Chinese in code/),
      'Unused key: demo.a.two',
      'Unused key: brief.a.one',
    ]));
  });

  it('checks an optional module\'s own text on its own keys, its tests aside', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'api-check-i18n-'));
    write('modules/demo/i18n/locales/zh-TW/demo.json', JSON.stringify({ 'demo.a.one': '一' }));
    write('modules/demo/i18n/locales/en-US/demo.json', JSON.stringify({ 'demo.a.one': 'One' }));
    write('modules/demo/i18n/prompts/ask.json', JSON.stringify({ 'ask.a.one': '問' }));
    write('modules/demo/i18n/messages.ts', "import a from './locales/zh-TW/demo.json';\nimport b from './locales/en-US/demo.json';\n");
    write('modules/demo/core/x.ts', "t('demo.a.one');\nprompt('ask.a.two');\nconst s = '中文';\n");
    write('modules/demo/test/helper.ts', "const s = '測試';\n");
    // A Hestia key isn't one of the module's.
    write('src/i18n/locales/zh-TW/host.json', JSON.stringify({ 'host.a.one': '主機' }));
    write('src/i18n/locales/en-US/host.json', JSON.stringify({ 'host.a.one': 'Host' }));
    write('src/i18n/messages.ts', "import a from './locales/zh-TW/host.json';\nimport b from './locales/en-US/host.json';\n");
    write('modules/demo/routes/y.ts', "t('host.a.one');\n");
    const problems = checkI18n(dir);
    expect(problems).toEqual(expect.arrayContaining([
      'modules/demo/i18n/messages.ts doesn\'t import ./prompts/ask.json',
      'modules/demo/core/x.ts:2: not a key of the prompt files: "ask.a.two"',
      expect.stringMatching(/^modules\/demo\/core\/x\.ts:3: Chinese in code/),
      'modules/demo/routes/y.ts:1: not a key of the interface text files: "host.a.one"',
      'Unused key: ask.a.one',
      'Unused key: host.a.one',
    ]));
    expect(problems.join('\n')).not.toContain('modules/demo/test/');
  });

  it('checks the shell scripts: msg keys, one key to a line, no Chinese outside comments', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'api-check-i18n-'));
    write('scripts/i18n/locales/zh-TW/install.json', `${JSON.stringify({ 'install.a.one': '一', 'install.a.two': '二' }, null, 2)}\n`);
    write('scripts/i18n/locales/en-US/install.json', JSON.stringify({ 'install.a.one': 'One', 'install.a.two': 'Two' }));
    write('scripts/install.sh', '# 註解可以寫中文\nsay "$(msg install.a.one)"\ndie "$(msg install.a.three)"\necho "中文"\n');
    expect(checkI18n(dir)).toEqual(expect.arrayContaining([
      'scripts/i18n/locales/en-US/install.json: write it one key to a line (JSON.stringify(…, null, 2)); the shell reads it by lines',
      'scripts/install.sh:3: not a key of the shell\'s text files: "install.a.three"',
      expect.stringMatching(/^scripts\/install\.sh:4: Chinese in code/),
      'Unused key: install.a.two',
    ]));
    expect(checkI18n(dir).join('\n')).not.toContain('install.sh:1');
  });
});

describe('the API\'s languages', () => {
  it('reads the app\'s Accept-Language, and a browser\'s list by preference', () => {
    expect(localeFromAcceptLanguage('en-US')).toBe('en-US');
    expect(localeFromAcceptLanguage('zh-TW')).toBe('zh-TW');
    expect(localeFromAcceptLanguage('fr-FR,en;q=0.8,zh-TW;q=0.9')).toBe('zh-TW');
    expect(localeFromAcceptLanguage('*')).toBeNull();
    expect(localeFromAcceptLanguage(undefined)).toBeNull();
  });

  it('gives the hestia command HESTIA_LOCALE, else the POSIX locale, else Chinese', () => {
    expect(localeFromEnv({ HESTIA_LOCALE: 'en', LANG: 'zh_TW.UTF-8' })).toBe('en-US');
    expect(localeFromEnv({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_TW.UTF-8' })).toBe('en-US');
    expect(localeFromEnv({ LANG: 'zh_TW.UTF-8' })).toBe('zh-TW');
    expect(localeFromEnv({ LANG: 'C.UTF-8' })).toBe('zh-TW');
    expect(localeFromEnv({ LANG: 'de_DE.UTF-8' })).toBe('zh-TW');
    expect(localeFromEnv({})).toBe('zh-TW');
  });

  it('words interface text in either language and prompts only in Chinese', () => {
    expect(tIn('en-US', 'push.session.replied', { cli: 'Codex' })).toBe('Codex finished replying');
    expect(tIn('zh-TW', 'push.session.replied', { cli: 'Codex' })).toBe('Codex 回覆完成');
    expect(t('push.session.replied', { cli: 'Codex' })).toBe('Codex 回覆完成');
    expect(prompt('handoff.brief.heading')).toBe('# 交接（系統整理）');
  });
});
