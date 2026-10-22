// Shape-only check (8-4-4-4-12 hex): enough for ids that only name a file
// or a lock we then verify some other way.
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RFC 4122 layout (version 1-8, variant 10xx) — what Claude Code's own
// session ids always are, so anything else is not one of them.
export const RFC4122_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
