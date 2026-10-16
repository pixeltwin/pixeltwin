import type { Child } from 'hono/jsx';
import type { BuildView } from '../domain/builds';
import type { CheckView } from '../domain/checks';
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

/**
 * A check's variant as tags of their readable values (`ios_16.0` → `ios 16.0`); the keys and the
 * exact values are in the tooltip. Nothing for a check without one.
 */
export function Variant({ variant }: { variant: Record<string, string> }) {
  const entries = Object.entries(variant).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <span class="variant" title={entries.map(([k, v]) => `${k}: ${v}`).join(' · ')}>
      {entries.map(([k, v]) => (
        <span class="variant-tag" data-key={k}>
          {v.replaceAll('_', ' ')}
        </span>
      ))}
    </span>
  );
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
  outdated: 'outdated',
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
  add(counts.result.unchanged, 'passed');
  return parts.join(' · ');
}

/**
 * What a build cost its reviewers: checks that passed automatically (unchanged, or new and approved
 * by the project setting) against those that needed a person (changed or new: decided or waiting).
 */
export function ReviewStats({ counts }: { counts: BuildCounts }) {
  const auto = counts.result.unchanged + counts.autoApproved;
  const { pending, approved, rejected, outdated } = counts.review;
  const needed = pending + approved - counts.autoApproved + rejected + outdated;
  const left = pending > 0 ? ` · ${pending} left` : '';
  return (
    <span
      class="review-stats"
      title="Passed automatically: unchanged, or new and approved by the project setting. Needed review: changed or new, decided by a person or still waiting."
    >
      {`${auto} automatically · ${needed} needed review${left}`}
    </span>
  );
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
/**
 * A password input with an eye button that shows or hides what was typed. The button needs
 * JavaScript (boot.ts), so it stays hidden without it and the field works as a plain one.
 */
export function PasswordField({ children }: { children: Child }) {
  return (
    <div class="password-field">
      {children}
      <button
        type="button"
        class="password-toggle ghost"
        data-password-toggle
        aria-label="Show password"
        aria-pressed="false"
      >
        <svg class="icon icon-eye" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
        </svg>
        <svg class="icon icon-eye-off" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
          <path d="M2.5 2.5l11 11" />
        </svg>
      </button>
    </div>
  );
}

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

/** A running build: a pulsing dot and a word, quieter than a pill (cards, lists, the build page). */
export function RunningIndicator() {
  return (
    <span class="running-indicator">
      <span class="pulse" aria-hidden="true" />
      running
    </span>
  );
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
      <RunningIndicator />
      {attention && <VerdictPill verdict={build.verdict} />}
    </span>
  );
}

/** The thumbnail: the diff for changed checks (changes in red), otherwise the screenshot. */
export function thumbnailSha(check: CheckView): string {
  return check.result === 'changed' && check.diffImageSha ? check.diffImageSha : check.imageSha;
}

const REVIEW_LABELS = {
  none: '',
  pending: 'unresolved',
  approved: 'approved',
  rejected: 'rejected',
  outdated: 'outdated',
} as const;

/** A check's result as its pill says it: an unchanged screenshot has `passed`. */
const RESULT_LABELS: Record<CheckView['result'], string> = {
  unchanged: 'passed',
  changed: 'changed',
  new: 'new',
  error: 'error',
};

/** A check's status in words: `changed · unresolved`, `new · approved`, `passed`. */
export function statusText(check: Pick<CheckView, 'result' | 'review'>): string {
  const review = REVIEW_LABELS[check.review];
  return review ? `${RESULT_LABELS[check.result]} · ${review}` : RESULT_LABELS[check.result];
}

/**
 * The colour a check's card takes: what someone has to do about it first. Red for an error or a
 * rejection, amber for a change and blue for a new screen waiting for review, green once approved
 * (`approved`) or unchanged (`passed`), grey when outdated.
 */
export function cardTone(check: Pick<CheckView, 'result' | 'review'>): string {
  if (check.result === 'error' || check.review === 'rejected') return 'bad';
  if (check.review === 'outdated') return 'outdated';
  if (check.review === 'approved') return 'approved';
  if (check.review === 'pending') return check.result === 'new' ? 'new' : 'changed';
  return 'passed';
}

/** Result and review state of a check: `changed` `unresolved`, `new` `approved`, … */
export function CheckStatus({ check }: { check: Pick<CheckView, 'result' | 'review'> }) {
  return (
    <span class="status">
      <Pill tone={toneOf(check.result)}>{RESULT_LABELS[check.result]}</Pill>
      {check.review !== 'none' && <Pill tone={toneOf(check.review)}>{REVIEW_LABELS[check.review]}</Pill>}
    </span>
  );
}
