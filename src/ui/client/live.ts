// Live updates (UI spec §4.4): while a page shows an open build, it re-fetches itself and swaps
// every changed `[data-live]` element. Polls every 5 s while the tab is visible, every 30 s after
// 10 unchanged polls, and stops once nothing on the page is `data-live-open` any more.
import { fetchPage } from './api.ts';
import { pollDelay } from './rank.ts';

export function init(): void {
  let unchanged = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    clearTimeout(timer);
    if (document.visibilityState === 'visible' && document.querySelector('[data-live-open]')) {
      timer = setTimeout(tick, pollDelay(unchanged));
    }
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
