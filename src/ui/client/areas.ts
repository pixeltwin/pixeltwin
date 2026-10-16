// Ignore and compare areas drawn on the focus-mode stage (Plan 6). Pick a kind in the toolbar
// (or press I / C), drag over a screenshot, and the area is saved and the check compared again.
// Delete in the info strip removes one. Without JavaScript only Delete works (a plain form).
import { api } from './api.ts';
import { toast } from './toast.ts';

type Kind = 'ignore' | 'compare';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smaller drags are taken for clicks, not areas. */
const MIN_SIZE = 4;

const ADDED: Record<Kind, string> = { ignore: 'Ignore area added', compare: 'Compare area added' };

/** The drag from `a` to `b`, in the pixels of `img` (whatever its zoom), clamped to the image. */
function toImage(img: HTMLImageElement, a: { x: number; y: number }, b: { x: number; y: number }): Rect | null {
  const box = img.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const sx = img.naturalWidth / box.width;
  const sy = img.naturalHeight / box.height;
  const clampX = (v: number) => Math.min(img.naturalWidth, Math.max(0, Math.round((v - box.left) * sx)));
  const clampY = (v: number) => Math.min(img.naturalHeight, Math.max(0, Math.round((v - box.top) * sy)));
  const x1 = clampX(Math.min(a.x, b.x));
  const x2 = clampX(Math.max(a.x, b.x));
  const y1 = clampY(Math.min(a.y, b.y));
  const y2 = clampY(Math.max(a.y, b.y));
  if (x2 - x1 < MIN_SIZE || y2 - y1 < MIN_SIZE) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Wires drawing and deleting into the current #review. `changed` shows the check again after
 * the server compared it with the new areas. Returns the cleanup for the next swap.
 */
export function mountAreas(root: HTMLElement, changed: (checkId: string) => Promise<void>): () => void {
  const stage = root.querySelector<HTMLElement>('#stage');
  const checkId = root.dataset.check as string;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-draw]')];
  const cleanups: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, handler: (event: Event) => void, options?: boolean) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  let kind: Kind | null = null;
  /** Ends a drag in progress without saving (set while dragging). */
  let abandon: (() => void) | null = null;
  /** Set once the next check replaced this one: a late save must not pull the reviewer back. */
  let gone = false;
  const setKind = (next: Kind | null) => {
    kind = next;
    if (stage) {
      if (next) stage.dataset.drawing = next;
      else delete stage.dataset.drawing;
    }
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.draw === next));
  };

  for (const b of buttons) listen(b, 'click', () => setKind(kind === b.dataset.draw ? null : (b.dataset.draw as Kind)));
  // Escape leaves drawing before it can mean "back to the build".
  listen(
    document,
    'keydown',
    (e) => {
      if (kind && (e as KeyboardEvent).key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setKind(null);
      }
    },
    true,
  );

  const save = async (drawn: Kind, rect: Rect) => {
    try {
      await api('POST', `/checks/${checkId}/areas`, { kind: drawn, ...rect });
      toast(ADDED[drawn], { tone: 'success', timeout: 2500 });
      if (!gone) await changed(checkId);
    } catch (err) {
      toast(`Couldn't add the area: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
    }
  };

  for (const viewport of stage?.querySelectorAll<HTMLElement>('.viewport') ?? []) {
    listen(viewport, 'pointerdown', (event) => {
      const e = event as PointerEvent;
      if (!kind || e.button !== 0) return;
      const img =
        viewport.querySelector<HTMLImageElement>('img.layer-top') ??
        viewport.querySelector<HTMLImageElement>('.shot img');
      if (!img?.naturalWidth) return;
      e.preventDefault();
      viewport.setPointerCapture(e.pointerId);
      const drawing = kind;
      const start = { x: e.clientX, y: e.clientY };
      const draft = document.createElement('div');
      draft.className = `area-draft area-draft-${drawing}`;
      document.body.append(draft);
      const place = (x: number, y: number) => {
        draft.style.left = `${Math.min(start.x, x)}px`;
        draft.style.top = `${Math.min(start.y, y)}px`;
        draft.style.width = `${Math.abs(x - start.x)}px`;
        draft.style.height = `${Math.abs(y - start.y)}px`;
      };
      place(start.x, start.y);
      const move = (ev: Event) => place((ev as PointerEvent).clientX, (ev as PointerEvent).clientY);
      // Ends the drag however it ends: a release saves, a cancel or a swap only cleans up.
      const finish = (ev: Event | null) => {
        viewport.removeEventListener('pointermove', move);
        viewport.removeEventListener('pointerup', finish);
        viewport.removeEventListener('pointercancel', finish);
        viewport.removeEventListener('lostpointercapture', finish);
        abandon = null;
        draft.remove();
        setKind(null);
        if (ev?.type !== 'pointerup') return;
        const p = ev as PointerEvent;
        const rect = toImage(img, start, { x: p.clientX, y: p.clientY });
        if (rect) void save(drawing, rect);
      };
      abandon = () => finish(null);
      viewport.addEventListener('pointermove', move);
      viewport.addEventListener('pointerup', finish);
      viewport.addEventListener('pointercancel', finish);
      viewport.addEventListener('lostpointercapture', finish);
    });
  }

  // Pointing at (or tabbing into) an area in the list lights it up on every screenshot.
  for (const item of root.querySelectorAll<HTMLElement>('[data-area-item]')) {
    const rects = [...root.querySelectorAll<SVGElement>(`[data-area="${item.dataset.areaItem}"]`)];
    const light = (on: boolean) => {
      item.classList.toggle('is-hot', on);
      for (const rect of rects) rect.classList.toggle('is-hot', on);
    };
    listen(item, 'pointerenter', () => light(true));
    listen(item, 'pointerleave', () => light(false));
    listen(item, 'focusin', () => light(true));
    listen(item, 'focusout', () => light(false));
  }

  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-area-delete]')) {
    listen(form, 'submit', (e) => {
      e.preventDefault();
      const areaId = form.dataset.areaDelete as string;
      void (async () => {
        try {
          await api('DELETE', `/checks/${checkId}/areas/${areaId}`);
          toast('Area deleted', { timeout: 2000 });
          if (!gone) await changed(checkId);
        } catch (err) {
          toast(`Couldn't delete the area: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
        }
      })();
    });
  }

  return () => {
    gone = true;
    abandon?.();
    setKind(null);
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
