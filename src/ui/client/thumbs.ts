// Build page: a changed check's thumbnail is its new screenshot; this paints the diff's changed
// pixels over it in red. A group card's before and after crops shimmer until both images are
// decoded, then fade in together. Thumbnails that arrive later (pages, live updates) are done too.
import { thumbMask } from './changes.ts';

/** Loads and decodes an image off the page; resolves false when it cannot be shown. */
function decoded(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return img.decode().then(
    () => img,
    () => (img.complete && img.naturalWidth ? img : null),
  );
}

/** The screenshot shown, once it is decoded (boot.ts marks it). */
function shown(shot: HTMLImageElement): Promise<void> {
  if (shot.classList.contains('is-loaded')) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!shot.classList.contains('is-loaded')) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(shot, { attributes: true, attributeFilter: ['class'] });
  });
}

function paint(thumb: HTMLElement): void {
  const src = thumb.dataset.diff;
  const stack = thumb.querySelector<HTMLElement>('.thumb-stack');
  const shot = stack?.querySelector('img');
  if (!src || !stack || !shot) return;
  thumb.dataset.painted = '';
  // Both load at once; the mask is drawn at the screenshot's size once that is on the page.
  void Promise.all([decoded(src), shown(shot)]).then(([diff]) => {
    if (!diff || shot.classList.contains('is-broken') || !stack.isConnected) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(shot.clientWidth * ratio));
    // A part of a full page covers its box (build.css): the mask keeps the diff's own shape and
    // covers the box the same way.
    const height = stack.classList.contains('part')
      ? Math.max(1, Math.round((width * diff.naturalHeight) / Math.max(1, diff.naturalWidth)))
      : Math.max(1, Math.round(shot.clientHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.className = 'thumb-mask';
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(diff, 0, 0, width, height);
    ctx.putImageData(
      new ImageData(thumbMask(ctx.getImageData(0, 0, width, height).data, width, height), width, height),
      0,
      0,
    );
    stack.append(canvas);
  });
}

/** A group card's crops: shown together once both of their images are decoded. */
function reveal(crop: HTMLElement): void {
  crop.dataset.revealing = '';
  const panes = [...crop.querySelectorAll<HTMLElement>('.crop-pane')];
  const sources = panes.map((pane) => pane.querySelector('image')?.getAttribute('href') ?? '');
  void Promise.all(sources.map((src) => (src ? decoded(src) : Promise.resolve(null)))).then((images) => {
    panes.forEach((pane, i) => {
      pane.classList.add('is-loaded');
      if (!images[i]) pane.classList.add('is-broken');
    });
  });
}

function paintAll(): void {
  for (const thumb of document.querySelectorAll<HTMLElement>('.thumb[data-diff]:not([data-painted])')) paint(thumb);
  for (const crop of document.querySelectorAll<HTMLElement>('.group-crop:not([data-revealing])')) reveal(crop);
}

export function init(): void {
  paintAll();
  new MutationObserver(paintAll).observe(document.body, { childList: true, subtree: true });
}
