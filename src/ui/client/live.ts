// Live updates (UI spec §4.4): a page re-fetches itself and swaps every changed `[data-live]`
// element while the tab is visible. While it shows a running build (`data-live-open`) it polls
// every 5 s; a page where new builds or reviews may appear (`data-live-watch`) polls every 10 s.
// Both slow down to 30 s when nothing changes for a while (rank.ts pollDelay).
import { ApiError, api, fetchPage } from './api.ts';
import { pollDelay } from './rank.ts';
import { toast } from './toast.ts';

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
      const fresh = doc.querySelector(`[data-live="${CSS.escape(current.dataset.live ?? '')}"]`);
      if (!fresh) {
        // Onboarding disappears when the first build arrives: show the real page.
        if (current.hasAttribute('data-live-reload')) {
          location.reload();
          return;
        }
        continue;
      }
      if (fresh.outerHTML !== current.outerHTML) {
        current.replaceWith(document.importNode(fresh, true));
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
    if (!form || !path) return;
    event.preventDefault();
    void submitInPlace(form, path);
  });

  async function submitInPlace(form: HTMLFormElement, path: string): Promise<void> {
    const button = form.querySelector('button');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      await api('POST', path, {});
      toast(form.dataset.inplaceDone ?? 'Done', { tone: 'success' });
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
    let doc: Document;
    try {
      doc = await fetchPage(location.href);
    } catch {
      schedule();
      return;
    }
    const card = form.closest<HTMLElement>('[id]');
    const swaps = ['[data-live="build-head"]', '[data-live="chips"]', '[data-live="tags"]'];
    for (const selector of swaps) {
      const current = document.querySelector(selector);
      const fresh = doc.querySelector(selector);
      if (current && fresh && fresh.outerHTML !== current.outerHTML)
        current.replaceWith(document.importNode(fresh, true));
    }
    if (card) {
      const fresh = doc.getElementById(card.id);
      if (fresh) card.replaceWith(document.importNode(fresh, true));
      // Filtered out now (approved under New or Unresolved): it stays until the next visit.
      else form.remove();
    }
    schedule();
  }

  document.addEventListener('visibilitychange', () => {
    unchanged = 0;
    schedule();
  });
  schedule();
}
