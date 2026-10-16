// Build page: a changed check's thumbnail is its new screenshot; this paints the diff's changed
// pixels over it in red. Thumbnails that arrive later (live updates) are painted too.
import { thumbMask } from './changes.ts';

function paint(thumb: HTMLElement): void {
  const src = thumb.dataset.diff;
  const stack = thumb.querySelector<HTMLElement>('.thumb-stack');
  const shot = stack?.querySelector('img');
  if (!src || !stack || !shot) return;
  thumb.dataset.painted = '';
  const draw = () => {
    const diff = new Image();
    diff.decoding = 'async';
    diff.addEventListener('load', () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(shot.clientWidth * ratio));
      const height = Math.max(1, Math.round(shot.clientHeight * ratio));
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
    diff.src = src;
  };
  if (shot.complete && shot.naturalWidth) draw();
  else shot.addEventListener('load', draw, { once: true });
}

function paintAll(): void {
  for (const thumb of document.querySelectorAll<HTMLElement>('.thumb[data-diff]:not([data-painted])')) paint(thumb);
}

export function init(): void {
  paintAll();
  new MutationObserver(paintAll).observe(document.body, { childList: true, subtree: true });
}
