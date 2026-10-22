import type { UsageEvent } from './parsers.js';

// Fixed standard/global API-equivalent list rates per million tokens,
// verified 2026-10-05. Estimates are not subscription charges or quota.
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/models/gpt-5
export const PRICING_VERSION = '2026-10-05-standard-v1';
export function estimateCost(event: UsageEvent): number | null {
  if (event.inferenceGeo && !['global', 'not_available', ''].includes(event.inferenceGeo)) return null;
  if (event.serviceTier && !['standard', 'default'].includes(event.serviceTier)) return null;
  const model = event.model ?? '';
  let input: number, output: number, cached: number, write: number, write1h: number;
  if (/^claude-sonnet-4-5(?:-\d{8})?$/.test(model)) {
    const long = event.input + event.cached + event.cacheWrite > 200_000;
    if (long) return null; // Legacy long-context rates require pricing-era evidence.
    input = 3; output = 15; cached = input * .1; write = input * 1.25; write1h = input * 2;
  } else if (/^claude-sonnet-4-6(?:-\d{8})?$/.test(model)) {
    input = 3; output = 15; cached = .3; write = 3.75; write1h = 6;
  } else if (/^claude-opus-4-[56](?:-\d{8})?$/.test(model)) {
    input = 5; output = 25; cached = .5; write = 6.25; write1h = 10;
  } else if (/^claude-sonnet-5-5(?:-\d{8})?$/.test(model)) {
    input = 2; output = 10; cached = .2; write = 2.5; write1h = 4;
  } else if (/^claude-opus-5-5(?:-\d{8})?$/.test(model)) {
    input = 4; output = 20; cached = .2; write = 5; write1h = 8;
  } else if (['gpt-5.2', 'gpt-5.3-codex'].includes(model)) {
    input = 1.75; output = 14; cached = .175; write = 0; write1h = 0;
    if (event.cacheWrite) return null;
  } else if (model === 'gpt-5.4') {
    if (event.input + event.cached > 272_000) return null;
    input = 2.5; output = 15; cached = .25; write = 0; write1h = 0;
    if (event.cacheWrite) return null;
  } else if (/^claude-haiku-4-5(?:-\d{8})?$/.test(model)) {
    input = 1; output = 5; cached = .1; write = 1.25; write1h = 2;
  } else if (model === 'gpt-5' || model === 'gpt-5-2025-08-07') {
    input = 1.25; output = 10; cached = .125; write = 0; write1h = 0;
    if (event.cacheWrite) return null;
  } else return null;
  const hour = event.cacheWrite1h ?? 0;
  if (hour > event.cacheWrite) return null;
  return (event.input * input + event.output * output + event.cached * cached + (event.cacheWrite - hour) * write + hour * write1h) / 1_000_000;
}
