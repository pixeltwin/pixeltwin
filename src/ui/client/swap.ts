// Swapping server markup into the page (live updates, build page pages) without flashing images
// that are already shown: the page adds state to the markup (loaded images, change masks), which
// a fresh copy from the server does not have.

/** Classes and attributes the client adds to server markup. */
const CLIENT_CLASSES = ['is-loaded', 'is-broken'];
const CLIENT_ATTRIBUTES = ['data-painted', 'data-revealing', 'data-gone'];

/** The element's markup as the server sent it: without what the client added since. */
export function serverMarkup(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const mask of copy.querySelectorAll('.thumb-mask')) mask.remove();
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    for (const name of CLIENT_CLASSES) el.classList.remove(name);
    if (el.getAttribute('class') === '') el.removeAttribute('class');
    for (const name of CLIENT_ATTRIBUTES) el.removeAttribute(name);
  }
  return copy.outerHTML;
}

/**
 * Gives `fresh` (not yet in the page) what `current` shows already: images that were loaded stay
 * loaded (no skeleton for a picture in the cache), group crops stay revealed, and a change mask
 * moves over when the thumbnail is the same.
 */
export function adopt(fresh: Element, current: Element): void {
  const loaded = new Set(
    [...current.querySelectorAll<HTMLImageElement>('img.is-loaded:not(.is-broken)')].map((img) => img.src),
  );
  for (const img of fresh.querySelectorAll<HTMLImageElement>('img'))
    if (loaded.has(img.src)) img.classList.add('is-loaded');
  const revealed = new Set(
    [...current.querySelectorAll('.crop-pane.is-loaded:not(.is-broken) image')].map((i) => i.getAttribute('href')),
  );
  for (const crop of fresh.querySelectorAll<HTMLElement>('.group-crop')) {
    const panes = [...crop.querySelectorAll('.crop-pane')];
    if (panes.length > 0 && panes.every((p) => revealed.has(p.querySelector('image')?.getAttribute('href') ?? null))) {
      crop.dataset.revealing = '';
      for (const pane of panes) pane.classList.add('is-loaded');
    }
  }
  const masks = new Map<string, HTMLCanvasElement>();
  for (const thumb of current.querySelectorAll<HTMLElement>('.thumb[data-diff]')) {
    const mask = thumb.querySelector<HTMLCanvasElement>('.thumb-mask');
    const src = thumb.querySelector('img')?.src;
    if (mask && src) masks.set(`${thumb.dataset.diff} ${src}`, mask);
  }
  for (const thumb of fresh.querySelectorAll<HTMLElement>('.thumb[data-diff]')) {
    const stack = thumb.querySelector('.thumb-stack');
    const mask = masks.get(`${thumb.dataset.diff} ${thumb.querySelector('img')?.src}`);
    if (!stack || !mask) continue;
    // Moved, not copied: a canvas copy would be blank. Sized the same, so it fits.
    mask.style.animation = 'none';
    stack.append(mask);
    thumb.dataset.painted = '';
  }
}

/** What takes the focus for a card on the build page: a group card itself, else its link. */
export function focusTarget(card: Element): HTMLElement | null {
  if (card instanceof HTMLElement && card.matches('[data-group-card]')) return card;
  return card.querySelector<HTMLElement>('a.check-card') ?? (card instanceof HTMLElement ? card : null);
}

/** The build page card holding the focus, if any. */
export function focusedCard(): HTMLElement | null {
  return document.activeElement?.closest<HTMLElement>('.check-card-wrap') ?? null;
}
