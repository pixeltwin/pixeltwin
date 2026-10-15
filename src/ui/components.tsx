import type { Child } from 'hono/jsx';
import type { BuildView } from '../domain/builds';
import type { BuildCounts, Verdict } from '../domain/verdict';
import type { AppError } from '../errors';
import type { Ui } from './context';

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

/** Colour roles for statuses (UI spec §2). Status is never shown by colour alone. */
export type Tone = 'green' | 'amber' | 'blue' | 'red' | 'grey';

const TONES: Record<string, Tone> = {
  passed: 'green',
  unchanged: 'green',
  approved: 'green',
  pending: 'amber',
  changed: 'amber',
  new: 'blue',
  open: 'blue',
  rejected: 'red',
  error: 'red',
};

export function toneOf(value: string): Tone {
  return TONES[value] ?? 'grey';
}

/** A verdict in words: `pending` means a person has to look at it. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  empty: 'empty',
  error: 'error',
  rejected: 'rejected',
  pending: 'needs review',
  passed: 'passed',
};

export function Pill({ tone, children }: { tone: Tone; children?: Child }) {
  return <span class={`pill tone-${tone}`}>{children}</span>;
}

export function VerdictPill({ verdict }: { verdict: Verdict }) {
  return <Pill tone={toneOf(verdict)}>{VERDICT_LABELS[verdict]}</Pill>;
}

/** A status dot; the label is its tooltip and is read out by screen readers. */
export function Dot({ tone, label, live }: { tone: Tone; label: string; live?: boolean }) {
  return (
    <span class={`dot tone-${tone}${live ? ' live' : ''}`} title={label}>
      <span class="visually-hidden">{label}</span>
    </span>
  );
}

/** An open build is running (blue, pulsing); a finalized one shows its verdict. */
export function BuildDot({ build }: { build: Pick<BuildView, 'state' | 'verdict'> }) {
  if (build.state === 'open') return <Dot tone="blue" label="running" live />;
  return <Dot tone={toneOf(build.verdict)} label={VERDICT_LABELS[build.verdict]} />;
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`, else the date. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** Relative time with the exact UTC time as its tooltip. */
export function Ago({ at, now }: { at: number; now?: number }) {
  const iso = new Date(at).toISOString();
  return (
    <time datetime={iso} title={`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`}>
      {ago(at, now ?? Date.now())}
    </time>
  );
}

/** `2 changed · 1 new · 38 unchanged`; zero counts are left out. */
export function countsText(counts: BuildCounts): string {
  if (counts.total === 0) return 'no checks';
  const parts: string[] = [];
  const add = (n: number, word: string) => n > 0 && parts.push(`${n} ${word}`);
  add(counts.result.changed, 'changed');
  add(counts.result.new, 'new');
  add(counts.result.error, counts.result.error === 1 ? 'error' : 'errors');
  add(counts.review.rejected, 'rejected');
  add(counts.result.unchanged, 'unchanged');
  return parts.join(' · ');
}

export interface Tab {
  label: string;
  href: string;
  current: boolean;
}

export function Tabs({ label, items }: { label: string; items: Tab[] }) {
  return (
    <nav class="tabs" aria-label={label}>
      {items.map((tab) => (
        <a href={tab.href} aria-current={tab.current ? 'page' : undefined}>
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

export type ProjectSection = 'branches' | 'builds' | 'settings';

/** Branches · All builds · Settings (UI spec §4.1); Settings only for those who may manage the project. */
export function ProjectTabs({
  ui,
  slug,
  current,
  canManage,
}: {
  ui: Ui;
  slug: string;
  current: ProjectSection;
  canManage: boolean;
}) {
  const items: Tab[] = [
    { label: 'Branches', href: ui.url(`/ui/p/${slug}`), current: current === 'branches' },
    { label: 'All builds', href: ui.url(`/ui/p/${slug}/builds`), current: current === 'builds' },
  ];
  if (canManage) {
    items.push({ label: 'Settings', href: ui.url(`/ui/p/${slug}/settings`), current: current === 'settings' });
  }
  return <Tabs label="Project" items={items} />;
}

/** A form field with its label, hint and inline error, wired up for screen readers. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: Child;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children}
      {hint && (
        <p class="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p class="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Attributes that tie an input to its Field's hint and error. */
export function describedBy(id: string, hint?: string, error?: string) {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return {
    id,
    ...(ids ? { 'aria-describedby': ids } : {}),
    ...(error ? { 'aria-invalid': 'true' as const } : {}),
  };
}

/** Field errors of a failed form submit, keyed by field name; `_form` holds the rest. */
export function formErrors(err: AppError): Record<string, string> {
  if (!err.errors?.length) return { _form: err.detail };
  const out: Record<string, string> = {};
  for (const e of err.errors) out[e.path.split('.')[0] || '_form'] ??= e.message;
  return out;
}

/**
 * A build's status: its verdict, or `running` while it is open; a running build that already
 * needs attention (pending, rejected, error) shows that too.
 */
export function BuildStatus({ build }: { build: Pick<BuildView, 'state' | 'verdict'> }) {
  if (build.state !== 'open') return <VerdictPill verdict={build.verdict} />;
  const attention = build.verdict !== 'passed' && build.verdict !== 'empty';
  return (
    <span class="status">
      <Pill tone="blue">running</Pill>
      {attention && <VerdictPill verdict={build.verdict} />}
    </span>
  );
}
