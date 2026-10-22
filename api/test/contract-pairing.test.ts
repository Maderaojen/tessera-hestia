import { describe, expect, it } from 'vitest';
import { appPairingLink, parsePairingLink, webPairingLink } from '../src/contract/index.js';

const BACKEND = 'https://box.tail1.ts.net:8443';

describe('pairing links', () => {
  it('the app link puts the backend in the query and the code after the #', () => {
    const link = appPairingLink(BACKEND, 'Ab-_9');
    expect(link).toBe('hestia://pair?url=https%3A%2F%2Fbox.tail1.ts.net%3A8443#code=Ab-_9');
    const url = new URL(link);
    expect(url.protocol).toBe('hestia:');
    expect(url.search).not.toContain('Ab-_9');
  });

  it('reads back both kinds', () => {
    expect(parsePairingLink(appPairingLink(BACKEND, 'Ab-_9'))).toEqual({ kind: 'app', backendUrl: BACKEND, code: 'Ab-_9' });
    expect(parsePairingLink(webPairingLink('https://app.example/', BACKEND, 'Ab-_9'))).toEqual({ kind: 'web', backendUrl: BACKEND, code: 'Ab-_9' });
    expect(parsePairingLink('hestia:pair?url=https%3A%2F%2Fb.example#code=x')).toEqual({ kind: 'app', backendUrl: 'https://b.example', code: 'x' });
  });

  it('a code with characters that need escaping survives the round trip', () => {
    expect(parsePairingLink(appPairingLink(BACKEND, 'a b/c#d'))?.code).toBe('a b/c#d');
    expect(parsePairingLink(webPairingLink('https://app.example', BACKEND, 'a b/c#d'))?.code).toBe('a b/c#d');
  });

  it('is null for anything that is not a pairing link', () => {
    for (const link of [
      'not a url',
      'hestia://pair?url=https%3A%2F%2Fb.example', // no code
      'hestia://pair#code=x', // no backend
      'hestia://open?url=https%3A%2F%2Fb.example#code=x', // another action
      'other://pair?url=https%3A%2F%2Fb.example#code=x', // another scheme
      'https://app.example/login?url=https%3A%2F%2Fb.example#pair=x', // no mode=add
      'https://app.example/settings?mode=add&url=https%3A%2F%2Fb.example#pair=x', // not the login page
      'https://app.example/login?mode=add&url=https%3A%2F%2Fb.example#code=x', // the app's fragment on the web link
      'javascript://pair?url=x#code=y',
      'hestia://pair?url=https%3A%2F%2Fb.example#code=%E0%A4%A', // bad escape
    ]) {
      expect(parsePairingLink(link), link).toBeNull();
    }
  });
});
