// A project's notes changed in a way that can give something new to work
// on — a note created or edited, moved in, or marked not done again: told
// by the notes routes (routes/notes.ts), heard by whoever reacts to it —
// an optional module, through the module host (module-host/ports.ts). In
// this process only; nothing is kept.

type Listener = (projectId: string) => void;

const listeners = new Set<Listener>();

export function onNotesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceNotesChanged(projectId: string): void {
  for (const listener of listeners) {
    try {
      listener(projectId);
    } catch (err) {
      console.error('[notes] a notes-changed listener failed', err);
    }
  }
}
