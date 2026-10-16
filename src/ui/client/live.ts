// Live updates (UI spec §4.4): a page re-fetches itself and swaps every changed `[data-live]`
// element while the tab is visible. While it shows a running build (`data-live-open`) it polls
// every 5 s; a page where new builds or reviews may appear (`data-live-watch`) polls every 10 s.
// Both slow down to 30 s when nothing changes for a while (rank.ts pollDelay).
import { fetchPage } from './api.ts';
import { pollDelay } from './rank.ts';

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

  document.addEventListener('visibilitychange', () => {
    unchanged = 0;
    schedule();
  });
  schedule();
}
