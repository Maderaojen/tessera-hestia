import typed from './prompts/typed.json' with { type: 'json' };

// What the app types into a CLI, word for word: handoff, delegation and
// branch line instructions. Written for the LLM, so Chinese only and kept
// in prompts/typed.json rather than in code;
// part of the contract because clients recognize these lines in
// transcripts. `{name}` takes a value, as in the API's own text.

export type TypedKey = keyof typeof typed;

export function typedText(key: TypedKey, values: Record<string, string | number> = {}): string {
  return typed[key].replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : match));
}
