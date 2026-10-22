import { describe, expect, it } from 'vitest';
import { RECAP_STATUSES } from '../../src/contract/recap.js';
import { parseRecapOutput, RECAP_OUTPUT_JSON_SCHEMA } from '../../src/recap/schema.js';

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: unknown; items?: JsonSchema };

// Every object in the schema, wherever it is nested.
function objects(schema: JsonSchema): JsonSchema[] {
  const nested = [...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])];
  return [...(schema.type === 'object' ? [schema] : []), ...nested.flatMap(objects)];
}

const good = {
  items: [
    { id: null, title: '將登入頁改為深色主題', status: 'implemented', turns: { from: 0, to: 0 }, mergedFrom: [] },
    { id: 'r_ab12cd34', title: '之後新增 Google 登入', status: 'planned', turns: { from: 2, to: 2 }, mergedFrom: ['r_00000000'] },
  ],
};

describe('the recap output schema', () => {
  it('is strict, as Codex requires: every object closed, every property required', () => {
    const found = objects(RECAP_OUTPUT_JSON_SCHEMA as unknown as JsonSchema);
    expect(found).toHaveLength(3);
    for (const object of found) {
      expect(object.additionalProperties).toBe(false);
      expect([...(object.required ?? [])].sort()).toEqual(Object.keys(object.properties ?? {}).sort());
    }
    expect(RECAP_OUTPUT_JSON_SCHEMA.properties.items.items.properties.status.enum).toEqual([...RECAP_STATUSES]);
  });

  it('takes an answer of its shape', () => {
    expect(parseRecapOutput(good)).toEqual({ ok: true, output: good });
  });

  it.each([
    ['not an object', 'items'],
    ['no items', {}],
    ['an extra field', { ...good, note: 'x' }],
    ['an item with an extra field', { items: [{ ...good.items[0], why: 'x' }] }],
    ['an unknown status', { items: [{ ...good.items[0], status: 'done' }] }],
    ['a missing mergedFrom', { items: [{ id: null, title: 'x', status: 'uncertain', turns: { from: 0, to: 0 } }] }],
    ['a fractional turn', { items: [{ ...good.items[0], turns: { from: 0.5, to: 1 } }] }],
    ['a numeric id', { items: [{ ...good.items[0], id: 3 }] }],
    // Claude doesn't hold the model to the schema: an answer to a loose one (2026-10-05, L4).
    ['what Claude answered to a loose schema', { x: 'StructuredOutput' }],
  ])('refuses %s', (_name, raw) => {
    expect(parseRecapOutput(raw).ok).toBe(false);
  });
});
