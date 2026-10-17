// Build page grid (UI spec §4.2): fits a page of cards to the window so the page does not scroll
// on a desktop, changes pages in place (fetching the next page's markup, with history, so back and
// forward work), searches as you type, and moves the focus between cards with J/K and the arrows,
// on to the next or previous page at the edges. The server renders every page, so without
// JavaScript the pager's links and the search form do the same.
import { basePath, fetchPage } from './api.ts';
import { type Density, fitRows, THUMB } from './fit.ts';
import { onKey } from './keys.ts';
import { adopt, focusedCard, focusTarget, serverMarkup } from './swap.ts';

/** Phones scroll: a fixed page of two columns (of one, large). */
const PHONE = window.matchMedia('(max-width: 640px)');
const PHONE_SIZE = { compact: 12, large: 8 };
const SIZE = { min: 2, max: 60 };
/** The pager's room when a page has none (one page): sizes stay the same either way. */
const PAGER_ROOM = 42;
const COOKIE = 'pt_page_size';
const DENSITY_COOKIE = 'pt_density';
/** How long a page fetched ahead is used before it is fetched again. */
const FRESH_MS = 20_000;

type Focus = 'first' | 'last' | 'keep' | { id: string } | { column: number; edge: 'first' | 'last' };

const grid = () => document.querySelector<HTMLElement>('[data-grid]');
const pager = () => document.querySelector<HTMLElement>('[data-pager]');
const cards = () => [...(grid()?.querySelectorAll<HTMLElement>('.check-card-wrap') ?? [])].filter((c) => !c.hidden);

/** Rows of the fitted page; null on phones. */
let rows: number | null = null;
let navigation = 0;
const ahead = new Map<string, { at: number; doc: Promise<Document> }>();

function state(): { page: number; pages: number; size: number; offset: number } {
  const g = grid();
  const p = pager();
  const size = Number(g?.dataset.size ?? p?.dataset.size ?? 24);
  const page = Number(g?.dataset.page ?? p?.dataset.page ?? 1);
  return { page, pages: Number(p?.dataset.pages ?? 1), size, offset: Number(g?.dataset.offset ?? (page - 1) * size) };
}

/** This page's address with other page parameters (no `focus`: it is applied once). */
function pageUrl(page: number, size = state().size): string {
  const url = new URL(location.href);
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(size));
  url.searchParams.delete('focus');
  url.searchParams.delete('done');
  return url.href;
}

const density = (): Density => (grid()?.dataset.density === 'large' ? 'large' : 'compact');

function columns(): number {
  const g = grid();
  if (!g) return 1;
  return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length);
}

function remember(size: number | Density, name = COOKIE): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing in older Safari and Firefox.
  document.cookie = `${name}=${size}; path=${basePath() || '/'}; max-age=31536000; samesite=lax`;
}

function fetchAhead(url: string): Promise<Document> {
  const known = ahead.get(url);
  if (known && Date.now() - known.at < FRESH_MS) return known.doc;
  const doc = fetchPage(url);
  ahead.set(url, { at: Date.now(), doc });
  doc.catch(() => ahead.delete(url));
  return doc;
}

/** The next page's markup and its first thumbnails (the size this window picks), fetched while idle. */
function prefetch(): void {
  const { page, pages } = state();
  if (page >= pages) return;
  const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 300));
  idle(() => {
    fetchAhead(pageUrl(page + 1))
      .then((doc) => {
        for (const img of [...doc.querySelectorAll<HTMLImageElement>('[data-grid] img')].slice(0, 12)) {
          const next = new Image();
          next.sizes = img.sizes;
          next.srcset = img.srcset;
          next.src = img.src;
        }
        for (const image of doc.querySelectorAll('[data-grid] .crop-pane image'))
          new Image().src = new URL(image.getAttribute('href') ?? '', location.href).href;
      })
      .catch(() => {});
  });
}

/** Measures the room the grid has: the window under the grid's top, less the pager and margin. */
function room(): { height: number; gap: number; body: number; width: number } | null {
  const g = grid();
  if (!g) return null;
  const style = getComputedStyle(g);
  const gap = Number.parseFloat(style.rowGap) || 0;
  const p = pager();
  const pagerRoom = p
    ? p.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(p).marginTop) || 0)
    : PAGER_ROOM;
  const main = document.querySelector('main');
  const bottom = main ? Number.parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
  const top = g.getBoundingClientRect().top + window.scrollY;
  // A card's height without its thumbnail: rows stretch to their tallest card, so take the most.
  let body = 0;
  const width = cards()[0]?.getBoundingClientRect().width ?? 0;
  for (const card of cards()) {
    const thumb = card.querySelector<HTMLElement>('.thumb');
    if (thumb) body = Math.max(body, card.getBoundingClientRect().height - thumb.getBoundingClientRect().height);
  }
  return { height: window.innerHeight - top - pagerRoom - bottom, gap, body, width };
}

function setThumbHeight(px: number | null): void {
  if (px === null) document.body.style.removeProperty('--fit-thumb-height');
  else document.body.style.setProperty('--fit-thumb-height', `${px}px`);
}

/** Thumbnails as tall as the fitted rows allow on this page; then whatever still overflows, off. */
function fitThumbs(): void {
  if (rows === null) {
    setThumbHeight(null);
    return;
  }
  const measured = room();
  if (!measured) return;
  const fit = fitRows({ ...measured, rows }, density());
  setThumbHeight(fit.thumb);
  for (let i = 0, thumb = fit.thumb; i < 3; i++) {
    const over = document.documentElement.scrollHeight - window.innerHeight;
    if (over <= 0) break;
    thumb = Math.max(THUMB.floor, thumb - Math.ceil(over / rows));
    setThumbHeight(thumb);
  }
}

/** The page size this window fits: columns × rows on a desktop, a fixed one on phones. */
function fittedSize(): number {
  if (PHONE.matches) {
    rows = null;
    setThumbHeight(null);
    return PHONE_SIZE[density()];
  }
  const measured = room();
  if (!measured) return state().size;
  const fit = fitRows(measured, density());
  const cols = columns();
  rows = Math.max(1, Math.min(fit.rows, Math.floor(SIZE.max / cols)));
  return Math.min(SIZE.max, Math.max(SIZE.min, cols * rows));
}

/**
 * Fits the page to the window; a new size keeps the first (or focused) card on the page shown.
 * `again`: the page comes from the server even at the same size (its cards' thumbnails changed).
 */
function refit(again = false): void {
  if (!grid()) return;
  const size = fittedSize();
  remember(size);
  const current = state();
  if (size === current.size && !again) {
    fitThumbs();
    return;
  }
  const list = cards();
  const focused = focusedCard();
  const anchor = focused ? list.indexOf(focused) : 0;
  const index = current.offset + Math.max(0, anchor);
  const page = Math.floor(index / size) + 1;
  void go(pageUrl(page, size), { history: 'replace', focus: focused ? { id: focused.id } : 'keep' });
}

/**
 * Shows another page (or this page again, filled): swaps the grid, the pager and the filter
 * chips from the server's page, keeps loaded thumbnails, sets the address and the focus.
 */
async function go(url: string, options: { history: 'push' | 'replace' | 'none'; focus: Focus }): Promise<void> {
  const turn = ++navigation;
  let doc: Document;
  try {
    doc = await fetchAhead(url);
  } catch {
    location.assign(url);
    return;
  }
  if (turn !== navigation) return;
  ahead.delete(url);
  const before = new Set(cards().map((c) => c.id));
  if (options.history === 'push') history.replaceState({ ...history.state, focus: focusedCard()?.id ?? null }, '');
  const pagerFocus = document.activeElement?.closest('[data-pager]') ? document.activeElement : null;
  const pagerKey =
    pagerFocus?.getAttribute('rel') ?? (pagerFocus instanceof HTMLElement ? pagerFocus.dataset.pageLink : undefined);
  for (const key of ['checks', 'chips', 'tags', 'build-head']) {
    const current = document.querySelector<HTMLElement>(`[data-live="${key}"]`);
    const fresh = doc.querySelector(`[data-live="${key}"]`);
    if (!current || !fresh || serverMarkup(fresh) === serverMarkup(current)) continue;
    const copy = document.importNode(fresh, true) as HTMLElement;
    adopt(copy, current);
    current.replaceWith(copy);
  }
  const shown = new URL(url);
  shown.searchParams.delete('focus');
  // Back and forward come back to the card that had the focus on each page.
  if (options.history === 'push') history.pushState({ grid: true }, '', shown);
  if (options.history === 'replace') history.replaceState({ grid: true }, '', shown);
  fitThumbs();
  place(options.focus, before);
  if (pagerKey && !focusedCard()) {
    const p = pager();
    const target =
      p?.querySelector<HTMLElement>(`[rel="${CSS.escape(pagerKey)}"]`) ??
      p?.querySelector<HTMLElement>('[aria-current="page"]');
    target?.focus();
  }
  prefetch();
}

/** Puts the focus on a card after a page change. */
function place(focus: Focus, before: Set<string>): void {
  const list = cards();
  if (list.length === 0 || focus === 'keep') return;
  let target: HTMLElement | undefined;
  if (focus === 'first') target = list.find((c) => !before.has(c.id)) ?? list[0];
  else if (focus === 'last') target = list[list.length - 1];
  else if ('id' in focus) target = document.getElementById(focus.id) ?? undefined;
  else {
    const cols = columns();
    const lastRow = Math.floor((list.length - 1) / cols) * cols;
    target = list[Math.min(focus.edge === 'first' ? focus.column : lastRow + focus.column, list.length - 1)];
  }
  if (target) focusTarget(target)?.focus();
}

/**
 * The next or previous page. Cards approved here that left the filter make room: the first step
 * forward fills this page with the cards that moved up, so none are skipped.
 */
function step(direction: 1 | -1, focus: Focus): void {
  const { page, pages } = state();
  if (direction === 1 && grid()?.querySelector('[data-gone]')) {
    void go(pageUrl(page), { history: 'replace', focus: 'first' });
    return;
  }
  const target = page + direction;
  if (target < 1 || target > pages) return;
  void go(pageUrl(target), { history: 'push', focus });
}

/** J/K and the arrows: the focus moves card by card (or row by row), across pages at the edges. */
function move(delta: number, byRow: boolean): void {
  const list = cards();
  if (list.length === 0) return;
  const current = focusedCard();
  const index = current ? list.indexOf(current) : -1;
  if (index < 0) {
    const first = delta > 0 ? list[0] : list[list.length - 1];
    if (first) focusTarget(first)?.focus();
    return;
  }
  const cols = columns();
  const target = index + (byRow ? delta * cols : delta);
  const column = index % cols;
  if (target < 0) step(-1, byRow ? { column, edge: 'last' } : 'last');
  else if (target >= list.length) step(1, byRow ? { column, edge: 'first' } : 'first');
  else {
    const card = list[target];
    if (card) focusTarget(card)?.focus();
  }
}

/** Large or compact cards: the grid takes the new columns at once, then the page that fits them. */
function initDensity(): void {
  document.addEventListener('submit', (event) => {
    const form = event.target;
    const button = event.submitter;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('density-switch')) return;
    if (!(button instanceof HTMLButtonElement)) return;
    event.preventDefault();
    const next: Density = button.value === 'compact' ? 'compact' : 'large';
    for (const b of form.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.value === next));
    remember(next, DENSITY_COOKIE);
    const g = grid();
    if (!g || density() === next) return;
    g.dataset.density = next;
    ahead.clear();
    refit(true);
  });
}

function initSearch(): void {
  const input = document.querySelector<HTMLInputElement>('[data-check-search]');
  const form = input?.form;
  if (!input || !form) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = () => {
    clearTimeout(timer);
    const url = new URL(location.href);
    const text = input.value.trim();
    if (text) url.searchParams.set('q', text);
    else url.searchParams.delete('q');
    for (const name of ['page', 'focus', 'done']) url.searchParams.delete(name);
    if (url.href !== location.href) void go(url.href, { history: 'replace', focus: 'keep' });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    search();
  });
}

export function init(): void {
  if (!document.querySelector('[data-live="checks"]')) return;

  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-page-link]') : null;
    if (!link) return;
    event.preventDefault();
    const rel = link.getAttribute('rel');
    if (rel === 'next') step(1, 'first');
    else if (rel === 'prev') step(-1, 'first');
    else void go(link.href, { history: 'push', focus: 'keep' });
  });
  window.addEventListener('popstate', (event: PopStateEvent) => {
    const id = (event.state as { focus?: string | null } | null)?.focus;
    void go(location.href, { history: 'none', focus: id ? { id } : 'keep' });
  });
  document.addEventListener('pixeltwin:reviewed', () => ahead.clear());
  document.addEventListener('pixeltwin:checks-swapped', () => {
    ahead.clear();
    fitThumbs();
  });

  onKey({ key: ']', label: 'Next page', run: () => step(1, 'first') });
  onKey({ key: '[', label: 'Previous page', run: () => step(-1, 'first') });
  onKey({ key: 'j', label: 'Next card', run: () => move(1, false) });
  onKey({ key: 'k', label: 'Previous card', run: () => move(-1, false) });
  onKey({ key: 'arrowright', label: 'Next card', run: () => move(1, false) });
  onKey({ key: 'arrowleft', label: 'Previous card', run: () => move(-1, false) });
  onKey({ key: 'arrowdown', label: 'Card below', run: () => move(1, true) });
  onKey({ key: 'arrowup', label: 'Card above', run: () => move(-1, true) });
  initSearch();
  initDensity();

  let resizing: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = setTimeout(refit, 150);
  });

  // A link with ?focus= (the way back from a check) lands on its card.
  const focus = grid()?.dataset.focus;
  if (focus) {
    // A check's own card, or the group card it is in (its screens link to it).
    const target =
      document.getElementById(focus) ??
      document
        .querySelector(`[data-group-card] a[href*="/ui/checks/${CSS.escape(focus)}?"]`)
        ?.closest('.check-card-wrap');
    if (target) focusTarget(target)?.focus();
    const url = new URL(location.href);
    url.searchParams.delete('focus');
    history.replaceState(history.state, '', url);
  }
  refit();
  prefetch();
}
