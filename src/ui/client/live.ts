// Live updates (UI spec §4.4): a page re-fetches itself and swaps every changed `[data-live]`
// element while the tab is visible. While it shows a running build (`data-live-open`) it polls
// every 5 s; a page where new builds or reviews may appear (`data-live-watch`) polls every 10 s.
// Both slow down to 30 s when nothing changes for a while (rank.ts pollDelay).
import { ApiError, api, fetchPage } from './api.ts';
import { onKey } from './keys.ts';
import { pollDelay } from './rank.ts';
import { bodyOfReject, closeMenu, initRejectMenus, openMenu } from './reject.ts';
import { adopt, focusedCard, focusTarget, serverMarkup } from './swap.ts';
import { toast } from './toast.ts';

/**
 * What a form posts in place: its `data-inplace-body` (JSON), else its checkIds inputs and, for a
 * reject popover, the category and comment; else nothing.
 */
function bodyOf(form: HTMLFormElement): Record<string, unknown> {
  if (form.dataset.inplaceBody) return JSON.parse(form.dataset.inplaceBody) as Record<string, unknown>;
  const ids = [...form.querySelectorAll<HTMLInputElement>('input[name="checkIds"]')].map((input) => input.value);
  const why = form.matches('[data-reject-form]') ? bodyOfReject(form) : {};
  return { ...(ids.length > 0 ? { checkIds: ids } : {}), ...why };
}

export function init(): void {
  let unchanged = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    clearTimeout(timer);
    if (document.visibilityState !== 'visible') return;
    if (document.querySelector('[data-live-open]')) timer = setTimeout(tick, pollDelay(unchanged, 'open'));
    else if (document.querySelector('[data-live-watch]')) timer = setTimeout(tick, pollDelay(unchanged, 'watch'));
  };

  async function tick(): Promise<void> {
    let doc: Document;
    try {
      doc = await fetchPage(location.href);
    } catch {
      schedule();
      return;
    }
    let changed = false;
    for (const current of document.querySelectorAll<HTMLElement>('[data-live]')) {
      // Cards reviewed in place that left the filter stay until the reviewer changes page.
      if (current.dataset.live === 'checks' && current.querySelector('[data-gone]')) continue;
      // An open reject popover (a reason picked, a comment typed) waits for the next round.
      if (current.querySelector('details[data-reject-menu][open]')) continue;
      const fresh = doc.querySelector(`[data-live="${CSS.escape(current.dataset.live ?? '')}"]`);
      if (!fresh) {
        // Onboarding disappears when the first build arrives: show the real page.
        if (current.hasAttribute('data-live-reload')) {
          location.reload();
          return;
        }
        continue;
      }
      // The page adds state to its markup (loaded images, masks): compare what the server sent.
      if (serverMarkup(fresh) !== serverMarkup(current)) {
        const copy = document.importNode(fresh, true) as HTMLElement;
        adopt(copy, current);
        const focused = current.contains(document.activeElement) ? focusedCard()?.id : undefined;
        current.replaceWith(copy);
        // A card that had the focus keeps it, so the keyboard goes on where it was.
        const card = focused ? document.getElementById(focused) : null;
        if (card) focusTarget(card)?.focus({ preventScroll: true });
        if (copy.dataset.live === 'checks') document.dispatchEvent(new CustomEvent('pixeltwin:checks-swapped'));
        changed = true;
      }
    }
    unchanged = changed ? 0 : unchanged + 1;
    schedule();
  }

  // A form marked data-inplace (Approve on a build card) posts to the API instead, and the page
  // refreshes its live parts: a reload would jump to the card and lose the scroll position.
  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    const path = form?.dataset.inplace;
    // A button that asks first (data-confirm) submits again once confirmed.
    if (!form || !path || event.defaultPrevented) return;
    event.preventDefault();
    void submitInPlace(form, path);
  });

  /** Undoes the last review made in place on this page (U, or Undo on its toast). */
  let lastUndo: (() => Promise<void>) | null = null;

  async function submitInPlace(form: HTMLFormElement, path: string): Promise<void> {
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    // Pages fetched ahead (grid island) show the cards as they were: they are fetched again.
    document.dispatchEvent(new CustomEvent('pixeltwin:reviewed'));
    try {
      const result = await api<{ changed?: string[] }>('POST', path, bodyOf(form));
      const undoPath = form.dataset.inplaceUndo;
      const card = form.closest<HTMLElement>('[id]');
      // A group review undoes exactly the checks it changed, not those reviewed one by one.
      const undo = undoPath
        ? async () => {
            if (lastUndo === undo) lastUndo = null;
            try {
              await api('POST', undoPath, result.changed ? { checkIds: result.changed } : {});
              toast('Review undone', { timeout: 2000 });
            } catch (err) {
              if (err instanceof ApiError && err.code === 'review_not_resettable') {
                toast("Can't undo: a newer baseline or a later build builds on this approval.", { tone: 'danger' });
              } else if (!(err instanceof ApiError && err.status === 401)) {
                toast(`Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
              }
              return;
            }
            unchanged = 0;
            document.dispatchEvent(new CustomEvent('pixeltwin:reviewed'));
            if (card?.id) await refreshCard(card.id, card);
          }
        : null;
      // A group review says how many checks it changed: `{n} screens` in its message.
      const n = result.changed?.length;
      if (n === 0) {
        lastUndo = null;
        toast('Someone else reviewed these checks already', { tone: 'warning' });
      } else {
        lastUndo = undo;
        const tone = form.dataset.inplaceTone === 'danger' ? 'danger' : 'success';
        const done = (form.dataset.inplaceDone ?? 'Done').replace('{n} screens', n === 1 ? '1 screen' : `${n} screens`);
        toast(done, undo ? { tone, action: { label: 'Undo (U)', run: () => void undo() } } : { tone });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (!(err instanceof ApiError && err.status === 409)) {
        if (button) button.disabled = false;
        toast(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
        return;
      }
      toast('Someone else reviewed this check already', { tone: 'warning' });
    }
    unchanged = 0;
    await refreshAround(form);
  }

  /**
   * After an in-place action: the header, the filter chips and the form's own card from a fresh
   * copy of the page. Swapping the whole grid would let the browser re-anchor the scroll.
   */
  async function refreshAround(form: HTMLFormElement): Promise<void> {
    const card = form.closest<HTMLElement>('[id]');
    if (card) await refreshCard(card.id, card, form);
    else await refreshCard(null, null, form);
  }

  /**
   * Swaps the header, the chips and the card with id `id` from a fresh copy of the page. A card
   * that had the focus keeps it (A, R and U go on working on it); a card filtered out now stays
   * until the next visit, without its form.
   */
  async function refreshCard(id: string | null, known: HTMLElement | null, form?: HTMLFormElement): Promise<void> {
    // The page that holds the card now (cards move between pages as others leave the filter).
    const url = new URL(location.href);
    if (id) url.searchParams.set('focus', id);
    let doc: Document;
    try {
      doc = await fetchPage(url.href);
    } catch {
      schedule();
      return;
    }
    const card = id ? (document.getElementById(id) ?? known) : null;
    const swaps = ['[data-live="build-head"]', '[data-live="chips"]', '[data-live="tags"]'];
    for (const selector of swaps) {
      const current = document.querySelector(selector);
      const fresh = doc.querySelector(selector);
      if (current && fresh && serverMarkup(fresh) !== serverMarkup(current))
        current.replaceWith(document.importNode(fresh, true));
    }
    if (card) {
      const focused = card.contains(document.activeElement);
      let fresh = doc.getElementById(card.id);
      let gone = false;
      // Filtered out now (approved under Unresolved): the card stays until the next visit or
      // page change, showing what it is now, as the unfiltered page has it.
      if (!fresh && url.searchParams.has('filter') && url.searchParams.get('filter') !== 'all') {
        url.searchParams.set('filter', 'all');
        fresh = await fetchPage(url.href)
          .then((all) => all.getElementById(card.id))
          .catch(() => null);
        gone = fresh !== null;
      }
      if (fresh) {
        const copy = document.importNode(fresh, true) as HTMLElement;
        adopt(copy, card);
        // The grid island counts these: the next page change first fills this page.
        if (gone) copy.dataset.gone = '';
        card.replaceWith(copy);
        if (focused) focusTarget(copy)?.focus({ preventScroll: true });
      } else form?.remove();
    }
    schedule();
  }

  // A group card with the focus (Tab, or a click on it): A and R review the whole group, U undoes
  // the last review made on this page.
  if (document.querySelector('[data-live="checks"], [data-inplace-undo]')) {
    onKey({ key: 'u', label: 'Undo the last review', run: () => void lastUndo?.() });
  }
  if (document.querySelector('[data-live="checks"]')) {
    // A on a focused new screenshot approves it; on a group card A approves the whole group and
    // R asks why first (the reject popover); Shift+R rejects the group without a reason.
    const cardForm = (action: string) =>
      focusedCard()?.querySelector<HTMLFormElement>(
        action === 'approve'
          ? 'form[data-group-action="approve"], form.card-approve'
          : 'form[data-group-action="reject"]',
      );
    onKey({ key: 'a', label: 'Approve the focused card', run: () => cardForm('approve')?.requestSubmit() });
    onKey({
      key: 'r',
      label: 'Reject the focused group, with why',
      run: () => {
        const menu = cardForm('reject')?.closest<HTMLDetailsElement>('details[data-reject-menu]');
        if (menu) openMenu(menu);
      },
    });
    onKey({
      key: 'shift+r',
      label: 'Reject the focused group without a reason',
      run: () => {
        const form = cardForm('reject');
        if (!form) return;
        const menu = form.closest<HTMLDetailsElement>('details[data-reject-menu]');
        if (menu) closeMenu(menu, false);
        form.reset();
        form.requestSubmit();
      },
    });
  }

  initRejectMenus();

  document.addEventListener('visibilitychange', () => {
    unchanged = 0;
    schedule();
  });
  schedule();
}
