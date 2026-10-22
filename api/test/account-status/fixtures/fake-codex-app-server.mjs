// Stand-in for `codex app-server`: answers the handshake + two reads the way
// codex-cli 0.156 does. FAKE_CODEX_MODE=unauth mimics a logged-out CODEX_HOME.
import process from 'node:process';
import readline from 'node:readline';
const unauth = process.env.FAKE_CODEX_MODE === 'unauth';
const hang = process.env.FAKE_CODEX_MODE === 'hang';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (hang) return;
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake', codexHome: process.env.CODEX_HOME } });
  if (m.method === 'account/read') {
    out({ method: 'some/notification', params: {} });
    out({ id: m.id, result: unauth ? { account: null, requiresOpenaiAuth: true }
      : { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });
  }
  if (m.method === 'account/rateLimits/read') {
    out(unauth
      ? { id: m.id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } }
      : { id: m.id, result: { rateLimits: {
          limitId: 'codex', primary: { usedPercent: 73, windowDurationMins: 300, resetsAt: 1790242233 },
          secondary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1790461329 },
          credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus' } } });
  }
});
