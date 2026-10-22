// What scripts/install.sh needs to know from config.ts, so the installer
// names no frontend of its own (built to dist/scripts/, run with node):
//
//   install-config.js cors-defaults          what a blank CORS_ALLOWED_ORIGINS allows
//   install-config.js web-frontend           the official web frontend
//   install-config.js missing-app-webviews LIST    app WebView origins LIST lacks
//
// One answer per run, comma-separated, on one line.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { APP_WEBVIEW_ORIGINS, DEFAULT_CORS_ALLOWED_ORIGINS, DEFAULT_FRONTEND_ORIGIN } from '../src/config.js';

export function missingAppWebviewOrigins(list: string): string[] {
  const listed = new Set(list.split(',').map((origin) => origin.trim().replace(/\/+$/, '')));
  return APP_WEBVIEW_ORIGINS.filter((origin) => !listed.has(origin));
}

export function installConfig(args: string[]): string | null {
  const [what, value] = args;
  if (what === 'cors-defaults') return DEFAULT_CORS_ALLOWED_ORIGINS.join(',');
  if (what === 'web-frontend') return DEFAULT_FRONTEND_ORIGIN;
  if (what === 'missing-app-webviews' && value !== undefined) return missingAppWebviewOrigins(value).join(',');
  return null;
}

// Only when run, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const answer = installConfig(process.argv.slice(2));
  if (answer === null) {
    console.error('usage: install-config.js cors-defaults | web-frontend | missing-app-webviews LIST');
    process.exit(2);
  }
  console.log(answer);
}
