// Live check: run one sweep the way the schedule does and print it. Also
// rewrites the snapshot file the API serves.
// Usage: npm run probe-account-status [-- --show-email]
import { sweep } from '../src/account-status/index.js';

const showEmail = process.argv.includes('--show-email');
const report = await sweep('manual');
for (const a of report.accounts) {
  const email = a.identity.email && !showEmail ? a.identity.email.replace(/^(.).*@/, '$1***@') : a.identity.email;
  console.log(`\n${a.id}  [${a.state}${a.stale ? ', stale' : ''}]  via ${a.method ?? '-'}  plan=${a.identity.plan ?? '-'}  ${email ?? ''}`);
  for (const w of a.windows) console.log(`  ${w.label.padEnd(6)} used ${String(w.usedPercent).padStart(5)}%  left ${String(w.remainingPercent).padStart(5)}%  resets ${w.resetsAt ?? '-'}`);
  if (a.credits) console.log(`  credits: balance=${a.credits.balance} has=${a.credits.hasCredits} unlimited=${a.credits.unlimited}`);
  if (a.error) console.log(`  error: ${a.error}`);
}
console.log(`\njanus=${report.janusAvailable} sweptAt=${report.sweptAt}`);
