import type { Child } from 'hono/jsx';

/** Coloured label for a verdict, result or review state. */
export function Badge({ value }: { value: string }) {
  return <span class={`badge ${value}`}>{value}</span>;
}

/** `2026-10-15 13:55 UTC`: deterministic, no client-side formatting. */
export function When({ at }: { at: number | null }) {
  if (at === null) return <span class="muted">—</span>;
  const iso = new Date(at).toISOString();
  return <time datetime={iso}>{`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`}</time>;
}

export function Variant({ variant }: { variant: Record<string, string> }) {
  const entries = Object.entries(variant);
  if (entries.length === 0) return <span class="muted">no variant</span>;
  return <span class="muted">{entries.map(([k, v]) => `${k}=${v}`).join(' · ')}</span>;
}

export function Pager({ newer, older }: { newer?: string | undefined; older?: string | undefined }) {
  if (!newer && !older) return null;
  return (
    <div class="pager">
      <span>{newer && <a href={newer}>← Newest</a>}</span>
      <span>{older && <a href={older}>Older →</a>}</span>
    </div>
  );
}

export function Panel({ children }: { children?: Child }) {
  return <section class="panel">{children}</section>;
}
