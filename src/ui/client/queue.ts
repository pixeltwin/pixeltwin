// Pure: no DOM access. Which check focus mode shows next (UI spec §5.2).

export interface Frame {
  id: string;
  /** The check's review state: none, pending, approved or rejected. */
  review: string;
}

/** Index where `id` sits, or where it would sit by id order when it is not in the list. */
function position(frames: Frame[], id: string): number {
  const at = frames.findIndex((f) => f.id === id);
  if (at >= 0) return at;
  const after = frames.findIndex((f) => f.id > id);
  return (after < 0 ? frames.length : after) - 0.5;
}

/** The next check waiting for review after `current`, wrapping around; null when none waits. */
export function nextPending(frames: Frame[], current: string): string | null {
  const from = position(frames, current);
  const waiting = frames.filter((f) => f.review === 'pending' && f.id !== current);
  const later = waiting.find((f) => frames.indexOf(f) > from);
  return (later ?? waiting[0])?.id ?? null;
}

export function adjacent(frames: Frame[], current: string): { previous: string | null; next: string | null } {
  const at = position(frames, current);
  const previous = frames.filter((_, i) => i < at).at(-1)?.id ?? null;
  const next = frames.find((_, i) => i > at)?.id ?? null;
  return { previous, next };
}
