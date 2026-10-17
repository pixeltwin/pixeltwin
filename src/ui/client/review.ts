// The focus-mode island (UI spec §5): the compare viewer, plus reviewing without page loads.
// Approve and Reject call the API, then the next check's server-rendered page replaces #review;
// pages are fetched ahead, so moving on is instant. Without JavaScript the same forms post.
import { ApiError, api, basePath, fetchPage } from './api.ts';
import { mountAreas } from './areas.ts';
import { onKey } from './keys.ts';
import { adjacent, type Frame, nextPending } from './queue.ts';
import { toast } from './toast.ts';
import { mountViewer } from './viewer.ts';

type Action = 'approve' | 'reject';

interface BuildJson {
  number: number;
  verdict: string;
}

const VERDICT_WORDS: Record<string, string> = {
  empty: 'empty',
  error: 'error',
  rejected: 'rejected',
  pending: 'needs review',
  passed: 'passed',
};
const TONES: Record<string, string> = {
  passed: 'green',
  approved: 'green',
  pending: 'amber',
  rejected: 'red',
  error: 'red',
};

let root: HTMLElement;
let unmountViewer: () => void = () => {};
let unmountAreas: () => void = () => {};
let busy = false;
let initialPending = 0;
let lastReviewed: string | null = null;
/** Reviews made in this session: the server markup of prefetched pages predates them. */
const states = new Map<string, string>();
const session = { approved: 0, rejected: 0, skipped: 0 };
const pages = new Map<string, Promise<Document>>();

const currentId = () => root.dataset.check as string;
const currentName = () => root.querySelector('.review-title h1')?.textContent ?? 'check';
const checkUrl = (id: string) =>
  `${basePath()}/ui/checks/${id}?filter=${encodeURIComponent(root.dataset.filter ?? 'pending')}`;

function frames(): Frame[] {
  return [...root.querySelectorAll<HTMLElement>('[data-frame]')].map((el) => {
    const id = el.dataset.frame as string;
    return { id, review: states.get(id) ?? el.dataset.review ?? 'none' };
  });
}

function page(url: string): Promise<Document> {
  let loading = pages.get(url);
  if (!loading) {
    loading = fetchPage(url);
    pages.set(url, loading);
    loading.catch(() => pages.delete(url));
  }
  return loading;
}

function forget(id: string): void {
  pages.delete(checkUrl(id));
}

/** Paints this session's reviews and the progress bar onto freshly swapped markup. */
function paint(): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-frame]')) {
    const state = states.get(el.dataset.frame as string);
    if (!state) continue;
    el.dataset.review = state;
    const dot = el.querySelector('.dot');
    if (dot) dot.className = `dot tone-${TONES[state] ?? 'grey'}`;
  }
  const bar = root.querySelector<HTMLElement>('[data-progress]');
  const fill = bar?.firstElementChild;
  if (bar && fill instanceof HTMLElement && initialPending > 0) {
    bar.hidden = false;
    const done = session.approved + session.rejected;
    fill.style.width = `${Math.min(100, (done / initialPending) * 100)}%`;
  }
}

function prefetchNext(): void {
  const id = nextPending(frames(), currentId()) ?? adjacent(frames(), currentId()).next;
  if (!id) return;
  page(checkUrl(id))
    .then((doc) => {
      for (const img of doc.querySelectorAll('#stage img')) new Image().src = img.getAttribute('src') ?? '';
    })
    .catch(() => {});
}

/** Shows another check by swapping in its server-rendered #review; falls back to a page load. */
async function show(id: string, url = checkUrl(id)): Promise<void> {
  let doc: Document;
  try {
    doc = await page(url);
  } catch {
    location.assign(url);
    return;
  }
  const next = doc.getElementById('review');
  if (!next) {
    location.assign(url);
    return;
  }
  unmountViewer();
  unmountAreas();
  // Images already shown come from the cache: no skeleton flash for them.
  const shown = new Set([...root.querySelectorAll<HTMLImageElement>('img.is-loaded')].map((img) => img.src));
  const fresh = document.importNode(next, true);
  for (const img of fresh.querySelectorAll<HTMLImageElement>('img'))
    if (shown.has(img.src)) img.classList.add('is-loaded');
  root.replaceWith(fresh);
  root = fresh;
  const crumbs = doc.querySelector('.crumbs');
  if (crumbs) document.querySelector('.crumbs')?.replaceWith(document.importNode(crumbs, true));
  document.title = doc.title;
  history.replaceState(null, '', url);
  paint();
  unmountViewer = mountViewer(root);
  unmountAreas = mountAreas(root, reload);
  prefetchNext();
}

/**
 * Shows the check again from the server, after its areas changed and it was compared again. The
 * folding lists (Changes, Baseline history) stay as the reviewer left them.
 */
async function reload(id: string): Promise<void> {
  const folded = new Map([...root.querySelectorAll('details')].map((d) => [d.className, d.open]));
  forget(id);
  await show(id);
  for (const details of root.querySelectorAll('details')) {
    const open = folded.get(details.className);
    if (open !== undefined) details.open = open;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** UI spec §5.2: nothing left to review in the filter. */
async function finished(): Promise<void> {
  const build = await api<BuildJson>('GET', `/builds/${root.dataset.build}`).catch(() => null);
  unmountViewer();
  unmountViewer = () => {};
  paint();
  // The header described the last check; on this screen it only leads back.
  root.querySelector('.review-head .status')?.remove();
  root.querySelector('.review-nav')?.remove();
  const panel = el('section', 'reviewed-screen');
  const reviewed = session.approved + session.rejected > 0;
  panel.append(el('h2', '', reviewed ? 'Build reviewed' : 'Nothing waits for review here'));
  panel.append(
    el('p', 'muted', `${session.approved} approved · ${session.rejected} rejected · ${session.skipped} skipped`),
  );
  if (build) {
    const line = el('p', 'verdict-line', `Build #${build.number} is now `);
    line.append(
      el('span', `pill tone-${TONES[build.verdict] ?? 'grey'}`, VERDICT_WORDS[build.verdict] ?? build.verdict),
    );
    panel.append(line);
  }
  const links = el('div', 'page-actions');
  const back = el('a', 'button primary', `Back to build #${root.dataset.buildNumber}`);
  back.href = root.querySelector<HTMLAnchorElement>('[data-key="escape"]')?.href ?? `${basePath()}/ui`;
  const project = el('a', 'button', 'Project');
  project.href = root.dataset.projectHref ?? `${basePath()}/ui`;
  links.append(back, project);
  panel.append(links);
  root.querySelector('.review-body')?.replaceChildren(panel);
  root.querySelector('.action-bar')?.remove();
  back.focus();
}

async function advance(): Promise<void> {
  const id = nextPending(frames(), currentId());
  if (id) await show(id);
  else await finished();
}

/** Someone else reviewed this check first (409): say who, then move on. */
async function alreadyReviewed(id: string): Promise<void> {
  forget(id);
  try {
    const check = await api<{ review: string }>('GET', `/checks/${id}`);
    states.set(id, check.review);
    const by = (await page(checkUrl(id))).querySelector<HTMLElement>('[data-reviewed-by]')?.dataset.reviewedBy;
    toast(`Already ${check.review} by ${by ?? 'another reviewer'}`, { tone: 'warning' });
  } catch {
    toast('Someone else reviewed this check already', { tone: 'warning' });
  }
  await advance();
}

async function review(action: Action): Promise<void> {
  if (busy) return;
  busy = true;
  const id = currentId();
  const name = currentName();
  try {
    try {
      await api('POST', `/checks/${id}/${action}`, {});
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return await alreadyReviewed(id);
      if (err instanceof ApiError && err.status === 401) return;
      toast(`Couldn't ${action} ${name}`, {
        tone: 'danger',
        timeout: 0,
        action: { label: 'Retry', run: () => void review(action) },
      });
      return;
    }
    states.set(id, action === 'approve' ? 'approved' : 'rejected');
    session[action === 'approve' ? 'approved' : 'rejected']++;
    forget(id);
    lastReviewed = id;
    toast(`${action === 'approve' ? 'Approved' : 'Rejected'} ${name}`, {
      tone: action === 'approve' ? 'success' : 'danger',
      action: { label: 'Undo (U)', run: () => void undo(id) },
    });
    await advance();
  } finally {
    busy = false;
  }
}

/** Undo (UI spec §5.2): the last review of this session, else the current check's review. */
async function undo(target: string | null = lastReviewed ?? currentId()): Promise<void> {
  if (!target || busy) return;
  busy = true;
  try {
    try {
      await api('POST', `/checks/${target}/reset`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'review_not_resettable') {
        toast("Can't undo: a newer baseline or a later build builds on this approval.", { tone: 'danger' });
      } else if (err instanceof ApiError && err.code === 'check_not_reviewable') {
        toast('Nothing to undo: this check waits for review.');
      } else if (!(err instanceof ApiError && err.status === 401)) {
        toast(`Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
      }
      return;
    }
    const was = states.get(target);
    if (was === 'approved') session.approved--;
    if (was === 'rejected') session.rejected--;
    states.set(target, 'pending');
    forget(target);
    if (lastReviewed === target) lastReviewed = null;
    toast('Review undone', { timeout: 2000 });
    busy = false;
    await show(target);
  } finally {
    busy = false;
  }
}

function onClick(event: MouseEvent): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (!link || !root.contains(link)) return;
  const id = /\/ui\/checks\/([\w-]+)$/.exec(new URL(link.href).pathname)?.[1];
  if (!id) return;
  event.preventDefault();
  if (link.hasAttribute('data-skip')) session.skipped++;
  // A link that says more than the check and the filter (the Areas switch) is shown as it is.
  void show(id, new URL(link.href).searchParams.has('areas') ? link.href : undefined);
}

function onSubmit(event: SubmitEvent): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !root.contains(form)) return;
  if (form.matches('[data-review-form]')) {
    event.preventDefault();
    const action: Action = event.submitter?.getAttribute('formaction')?.endsWith('/reject') ? 'reject' : 'approve';
    void review(action);
  } else if (form.matches('[data-reset-form]')) {
    event.preventDefault();
    void undo(currentId());
  }
}

/** Phones (UI spec §5.2): swipe left or right for next or previous; never to approve. */
function swipes(): void {
  let start: { x: number; y: number } | null = null;
  document.addEventListener(
    'touchstart',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const busyArea = target?.closest('.action-bar, .divider, .stage[data-zoom="free"], .stage[data-drawing]');
      start =
        e.touches.length === 1 && target && root.contains(target) && !busyArea
          ? { x: e.touches[0]?.clientX ?? 0, y: e.touches[0]?.clientY ?? 0 }
          : null;
    },
    { passive: true },
  );
  document.addEventListener('touchend', (e) => {
    const touch = e.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
    const { previous, next } = adjacent(frames(), currentId());
    const target = dx < 0 ? next : previous;
    if (target) void show(target);
  });
}

export function init(): void {
  const found = document.getElementById('review');
  if (!found) return;
  root = found;
  initialPending = frames().filter((f) => f.review === 'pending').length;
  unmountViewer = mountViewer(root);
  unmountAreas = mountAreas(root, reload);
  paint();
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  onKey({ key: 'u', label: 'Undo the last review', run: () => void undo() });
  // ← and → do what K and J do: the header's previous and next links (UI spec §5.1).
  onKey({
    key: 'arrowleft',
    label: 'Previous check',
    run: () => root.querySelector<HTMLElement>('[data-key="k"]')?.click(),
  });
  onKey({
    key: 'arrowright',
    label: 'Next check',
    run: () => root.querySelector<HTMLElement>('[data-key="j"]')?.click(),
  });
  onKey({
    key: 'escape',
    label: 'Back to the build',
    run: () => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) active.blur();
      else root.querySelector<HTMLAnchorElement>('[data-key="escape"]')?.click();
    },
  });
  swipes();
  prefetchNext();
}
