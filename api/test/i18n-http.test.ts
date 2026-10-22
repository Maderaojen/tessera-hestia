import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultLocale, setDefaultLocale, t } from '../src/i18n/index.js';
import { interfaceLocale, rememberInterfaceLocale } from '../src/i18n/http.js';

function app() {
  const made = express();
  made.use(interfaceLocale);
  made.use(rememberInterfaceLocale);
  // Answered after an await, as most routes are: the language must carry over.
  made.get('/text', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.json({ text: t('push.session.replied', { cli: 'Codex' }) });
  });
  return made;
}

describe('a request\'s language', () => {
  afterEach(() => setDefaultLocale('zh-TW'));

  it('answers in the language the request asks for, else the host\'s', async () => {
    expect((await request(app()).get('/text').set('Accept-Language', 'en-US')).body.text).toBe('Codex finished replying');
    expect((await request(app()).get('/text')).body.text).toBe('Codex 回覆完成');
    expect(defaultLocale()).toBe('zh-TW');
  });

  it('takes the host\'s language only from the app\'s own client (the bearer header)', async () => {
    await request(app()).get('/text').set('Accept-Language', 'en-US');
    expect(defaultLocale()).toBe('zh-TW');
    await request(app()).get('/text').set('Accept-Language', 'en-US').set('Authorization', 'Bearer x');
    expect(defaultLocale()).toBe('en-US');
    // Background text (no request) now follows it.
    expect(t('push.session.replied', { cli: 'Codex' })).toBe('Codex finished replying');
  });
});
