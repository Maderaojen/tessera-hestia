import { describe, expect, it } from 'vitest';
import { frontendOrigin, isTailnetUrl, pairBackendUrl, pairingLink, pairingLinks, pairLinkKinds, phoneReachHint } from '../../src/cli/pairLink.js';
import { DEFAULT_CORS_ALLOWED_ORIGINS, DEFAULT_FRONTEND_ORIGIN } from '../../src/config.js';

describe('pairingLink', () => {
  it('opens the add-host form with the backend filled in, the code after the # (never sent to a server)', () => {
    const link = pairingLink('https://app.example/', 'https://box.tail1.ts.net:8443', 'Ab-_9');
    expect(link).toBe('https://app.example/login?mode=add&url=https%3A%2F%2Fbox.tail1.ts.net%3A8443#pair=Ab-_9');
    const parsed = new URL(link);
    expect(parsed.searchParams.get('url')).toBe('https://box.tail1.ts.net:8443');
    expect(parsed.search).not.toContain('Ab-_9');
  });
});

describe('frontendOrigin', () => {
  it('is the first allowed origin, or the public one', () => {
    expect(frontendOrigin(' https://a.example/ , https://b.example', 'https://pub.example')).toBe('https://a.example');
    expect(frontendOrigin(undefined, 'https://pub.example')).toBe('https://pub.example');
    expect(frontendOrigin('', 'https://pub.example')).toBe('https://pub.example');
    expect(frontendOrigin('*,https://b.example', 'https://pub.example')).toBe('https://b.example');
  });

  it("skips the app WebView origins: nothing there for a browser to open", () => {
    expect(frontendOrigin('capacitor://localhost,https://localhost,https://web.example', 'https://pub.example')).toBe('https://web.example');
    expect(frontendOrigin('capacitor://localhost, https://localhost/', 'https://pub.example')).toBe('https://pub.example');
    expect(frontendOrigin('tauri://localhost,http://tauri.localhost,https://web.example', 'https://pub.example')).toBe('https://web.example');
    expect(frontendOrigin('http://tauri.localhost', 'https://pub.example')).toBe('https://pub.example');
    // A dev server on localhost with a port is a web frontend.
    expect(frontendOrigin('http://localhost:5173', 'https://pub.example')).toBe('http://localhost:5173');
  });

  it('with the default allowlist written out (the app alone), falls back to the web frontend given', () => {
    expect(frontendOrigin(DEFAULT_CORS_ALLOWED_ORIGINS.join(','), DEFAULT_FRONTEND_ORIGIN)).toBe(DEFAULT_FRONTEND_ORIGIN);
    expect(frontendOrigin(DEFAULT_CORS_ALLOWED_ORIGINS.join(','), 'https://pub.example')).toBe('https://pub.example');
  });
});

describe('pairLinkKinds', () => {
  it('is the app link unless asked otherwise: the app is the frontend offered', () => {
    expect(pairLinkKinds(undefined)).toEqual(['app']);
    expect(pairLinkKinds('')).toEqual(['app']);
    expect(pairLinkKinds(' Web ')).toEqual(['web']);
    expect(pairLinkKinds('app')).toEqual(['app']);
    expect(pairLinkKinds('both')).toEqual(['web', 'app']);
  });

  it('refuses anything else', () => {
    expect(pairLinkKinds('native')).toBeNull();
    expect(pairLinkKinds('web,app')).toBeNull();
  });
});

describe('pairingLinks', () => {
  it('carries the same backend and code in each kind, in the order asked', () => {
    const links = pairingLinks(['web', 'app'], 'https://app.example', 'https://box.tail1.ts.net', 'c0de');
    expect(links.map((l) => l.kind)).toEqual(['web', 'app']);
    expect(links[0]!.link).toBe('https://app.example/login?mode=add&url=https%3A%2F%2Fbox.tail1.ts.net#pair=c0de');
    expect(links[1]!.link).toBe('hestia://pair?url=https%3A%2F%2Fbox.tail1.ts.net#code=c0de');
  });
});

describe('pairBackendUrl', () => {
  it('accepts what the add-host form accepts: https, or http only to this machine', () => {
    expect(pairBackendUrl(' https://box.tail1.ts.net/ ')).toBe('https://box.tail1.ts.net');
    expect(pairBackendUrl('https://box.tail1.ts.net:8443/api')).toBe('https://box.tail1.ts.net:8443');
    expect(pairBackendUrl('http://127.0.0.1:4791')).toBe('http://127.0.0.1:4791');
    expect(pairBackendUrl('http://localhost:4791/')).toBe('http://localhost:4791');
  });

  it('refuses anything the phone could not use or would send the password over in the clear', () => {
    for (const bad of ['box.tail1.ts.net', 'http://box.tail1.ts.net', 'http://192.168.1.5:4791', 'ftp://box.example', 'https://u:p@box.example', 'https://box.example/?x=1', 'https://box.example/#x', 'http://127.0.0.1.evil.example', '']) {
      expect(pairBackendUrl(bad), bad).toBeNull();
    }
  });
});

describe('phoneReachHint', () => {
  it('asks for Tailscale on the phone only for a tailnet address', () => {
    expect(isTailnetUrl('https://box.tail1.ts.net:8443')).toBe(true);
    expect(isTailnetUrl('https://box.example')).toBe(false);
    expect(isTailnetUrl('https://ts.net.example')).toBe(false);
    expect(phoneReachHint('https://box.tail1.ts.net')).toContain('Tailscale');
    expect(phoneReachHint('https://box.example')).not.toContain('Tailscale');
    expect(phoneReachHint('https://box.example')).toContain('https://box.example');
  });
});
