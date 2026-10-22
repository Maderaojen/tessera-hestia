import { z } from 'zod';
import { RECAP_STATUSES } from '../contract/recap.js';

// What the model answers with. One
// JSON Schema goes to both CLIs (Codex --output-schema, Claude
// --json-schema), in OpenAI's strict structured-output form: every object
// closes with additionalProperties: false and lists all its properties as
// required, with null standing in for "none". Codex refuses anything less
// strict; Claude doesn't check, so every answer is validated here again.

export const RECAP_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'status', 'turns', 'mergedFrom'],
        properties: {
          id: { type: ['string', 'null'] },
          title: { type: 'string' },
          status: { type: 'string', enum: [...RECAP_STATUSES] },
          turns: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to'],
            properties: { from: { type: 'integer' }, to: { type: 'integer' } },
          },
          mergedFrom: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const outputSchema = z.object({
  items: z.array(z.object({
    id: z.string().nullable(),
    title: z.string(),
    status: z.enum(RECAP_STATUSES),
    turns: z.object({ from: z.number().int(), to: z.number().int() }).strict(),
    mergedFrom: z.array(z.string()),
  }).strict()),
}).strict();

export type RecapOutput = z.infer<typeof outputSchema>;
export type RecapOutputItem = RecapOutput['items'][number];

/**
 * The model's answer, if it has the schema's shape; why not, otherwise.
 * The reason names only where and what kind of mismatch (`items.0.status:
 * invalid_value`), never a value from the answer, which may quote the
 * conversation: it goes to the server log.
 */
export function parseRecapOutput(raw: unknown): { ok: true; output: RecapOutput } | { ok: false; reason: string } {
  const parsed = outputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, output: parsed.data };
  const reason = parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`).join('; ');
  return { ok: false, reason };
}
