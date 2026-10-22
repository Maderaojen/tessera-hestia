import path from 'node:path';
import { STATE_DIR } from '../config.js';
import { createUsageAnalytics } from './service.js';
import { discoverUsageSources, readUsageBindings } from './adapters.js';

export const usageAnalytics = createUsageAnalytics({ dbPath: path.join(STATE_DIR, 'usage-analytics', 'usage.sqlite'), discoverSources: discoverUsageSources, readBindings: readUsageBindings });
export function startUsageAnalyticsSchedule(): () => void {
  const scan = () => { void usageAnalytics.refresh().catch(() => console.warn('[usage-analytics] background scan failed')); };
  scan();
  const timer = setInterval(scan, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
