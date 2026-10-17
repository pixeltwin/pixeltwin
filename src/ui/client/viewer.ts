// Focus-mode compare viewer (UI spec §5.1): Side, Slider, Onion and Diff modes over one shared
// zoom and pan. Mounted on the page's #review element; returns a function that unmounts it.
import { changeMask } from './changes.ts';
import { onKey } from './keys.ts';
import { actualView, fitView, panBy, type Size, type View, zoomAt } from './zoom.ts';

const MODES = ['side', 'slider', 'onion', 'diff'] as const;
type Mode = (typeof MODES)[number];
const MODE_STORAGE = 'pixeltwin.review.mode';

/**
 * The zoom, pan, divider and onion opacity of the check last shown: the same check drawn again
 * (Show diff, an area changed) keeps them, so nothing jumps; another check starts fresh.
 */
let carried: { checkId: string; fit: boolean; view: View; split: number; onion: string } | null = null;
const HIGHLIGHT_STORAGE = 'pixeltwin.review.highlight';

function storedMode(): Mode {
  try {
    const stored = localStorage.getItem(MODE_STORAGE);
    return MODES.find((m) => m === stored) ?? 'slider';
  } catch {
    return 'slider';
  }
}

function storeMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_STORAGE, mode);
  } catch {
    // Private windows may refuse storage; the mode just is not remembered.
  }
}

/** Changed pixels are highlighted unless the reviewer turned it off. */
function storedHighlight(): boolean {
  try {
    return localStorage.getItem(HIGHLIGHT_STORAGE) !== 'off';
  } catch {
    return true;
  }
}

function storeHighlight(on: boolean): void {
  try {
    localStorage.setItem(HIGHLIGHT_STORAGE, on ? 'on' : 'off');
  } catch {
    // Private windows may refuse storage; the choice just is not remembered.
  }
}

/**
 * Draws the diff's changed pixels as a mask over this build's screenshot (in Side, and on the
 * Slider and Onion layers, where it follows this build's half and opacity), and wires the Changes
 * toggle (and H). Returns its cleanup.
 */
function mountHighlight(stage: HTMLElement, drawn: () => void): () => void {
  const toggle = stage.querySelector<HTMLButtonElement>('[data-highlight]');
  const diff = stage.querySelector<HTMLImageElement>('.pane-diff img');
  if (!toggle || !diff) return () => {};
  // Show diff (areas off) is there to see the changes: they are highlighted whatever was chosen.
  let on = stage.hasAttribute('data-areas-off') || storedHighlight();
  const show = () => {
    stage.classList.toggle('highlight-changes', on);
    toggle.setAttribute('aria-pressed', String(on));
  };
  const draw = () => {
    const width = diff.naturalWidth;
    const height = diff.naturalHeight;
    const scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!width || !height || !scratch) return;
    scratch.canvas.width = width;
    scratch.canvas.height = height;
    scratch.drawImage(diff, 0, 0);
    const mask = new ImageData(
      changeMask(scratch.getImageData(0, 0, width, height).data, width, height),
      width,
      height,
    );
    for (const host of stage.querySelectorAll<HTMLElement>('.pane-current .shot, .layers')) {
      const img = host.querySelector<HTMLImageElement>('.layer-top, .shot > img');
      const canvas = document.createElement('canvas');
      canvas.className = 'change-mask';
      canvas.width = width;
      canvas.height = height;
      // The diff spans both images; size the mask in the host image's own pixels.
      canvas.style.width = `${(width / (img?.naturalWidth || width)) * 100}%`;
      canvas.getContext('2d')?.putImageData(mask, 0, 0);
      host.insertBefore(canvas, host.querySelector(':scope > svg, :scope > .divider'));
    }
    drawn();
  };
  const flip = () => {
    on = !on;
    storeHighlight(on);
    show();
  };
  show();
  if (diff.complete) draw();
  else diff.addEventListener('load', draw, { once: true });
  toggle.addEventListener('click', flip);
  const offKey = onKey({ key: 'h', label: 'Highlight changes', run: flip });
  return () => {
    toggle.removeEventListener('click', flip);
    offKey();
    for (const canvas of stage.querySelectorAll('.change-mask')) canvas.remove();
  };
}

function sizeOf(img: HTMLImageElement | null): Size {
  return {
    width: img?.naturalWidth || Number(img?.getAttribute('width')) || 1,
    height: img?.naturalHeight || Number(img?.getAttribute('height')) || 1,
  };
}

export function mountViewer(root: HTMLElement): () => void {
  const stage = root.querySelector<HTMLElement>('#stage');
  if (!stage) return () => {};
  const cleanups: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  const isNew = stage.dataset.mode === 'new';
  const buttons = [...stage.querySelectorAll<HTMLButtonElement>('[data-mode-button]')];
  const available = buttons.filter((b) => !b.disabled).map((b) => b.dataset.modeButton as Mode);
  const toolbar = stage.querySelector<HTMLElement>('.stage-toolbar');
  const onionControl = stage.querySelector<HTMLElement>('.onion-control');
  const onion = stage.querySelector<HTMLInputElement>('[data-onion]');
  const zoomLabel = stage.querySelector<HTMLElement>('[data-zoom-label]');
  const layers = stage.querySelector<HTMLElement>('.layers');
  const top = stage.querySelector<HTMLElement>('.layer-top');
  const divider = stage.querySelector<HTMLElement>('.divider');
  const current = stage.querySelector<HTMLImageElement>('.pane-current img');

  stage.classList.add('interactive');
  stage.tabIndex = 0;
  if (toolbar) toolbar.hidden = false;

  let mode: Mode | 'new' = isNew ? 'new' : storedMode();
  if (mode !== 'new' && !available.includes(mode)) mode = 'slider';
  let fit = true;
  let view: View = { scale: 1, x: 0, y: 0 };
  let split = 0.5;
  const checkId = root.dataset.check ?? '';
  if (carried?.checkId === checkId) {
    ({ fit, view, split } = carried);
    if (onion) onion.value = carried.onion;
  }

  const image = () => sizeOf(current);
  const box = (): Size => {
    const viewport = [...stage.querySelectorAll<HTMLElement>('.viewport')].find((v) => v.offsetParent !== null);
    return { width: viewport?.clientWidth || 1, height: viewport?.clientHeight || 1 };
  };

  function render(): void {
    if (fit) view = fitView(image(), box());
    for (const canvas of stage?.querySelectorAll<HTMLElement>('.canvas') ?? []) {
      canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    if (zoomLabel) zoomLabel.textContent = fit ? 'Fit' : `${Math.round(view.scale * 100)}%`;
    // Above 100 % every screenshot pixel becomes a crisp block, so single-pixel changes are visible.
    stage?.classList.toggle('magnified', view.scale > 1);
    if (stage) stage.dataset.zoom = fit ? 'fit' : 'free';
    if (top) {
      top.style.clipPath = mode === 'slider' ? `inset(0 0 0 ${split * 100}%)` : 'none';
      top.style.opacity = mode === 'onion' ? String(Number(onion?.value ?? 50) / 100) : '1';
      // Changes are this build's: on the layers they show only where (and as much as) it does.
      const mask = layers?.querySelector<HTMLElement>('.change-mask');
      if (mask) {
        mask.style.clipPath = top.style.clipPath;
        mask.style.opacity = top.style.opacity;
      }
      // Areas too belong to this build: in Slider they stay on its side of the divider.
      const areaLayer = layers?.querySelector<SVGElement>('.area-layer');
      if (areaLayer) areaLayer.style.clipPath = top.style.clipPath;
    }
    if (divider) {
      divider.hidden = mode !== 'slider';
      divider.style.left = `${split * 100}%`;
    }
  }

  function setMode(next: Mode): void {
    if (!available.includes(next) || !stage) return;
    mode = next;
    stage.dataset.mode = next;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.modeButton === next));
    if (onionControl) onionControl.hidden = next !== 'onion';
    storeMode(next);
    render();
  }

  function toggleZoom(): void {
    fit = !fit;
    if (!fit) view = actualView(image(), box());
    render();
  }

  // Mode buttons and keys 1-4.
  for (const b of buttons) listen(b, 'click', () => setMode(b.dataset.modeButton as Mode));
  available.forEach((m, i) => {
    cleanups.push(
      onKey({ key: String(i + 1), label: `${m[0]?.toUpperCase()}${m.slice(1)} view`, run: () => setMode(m) }),
    );
  });
  cleanups.push(onKey({ key: 'z', label: 'Fit / 100%', run: toggleZoom }));
  // Plain arrows move between checks (review island); with Shift they move the divider.
  for (const [key, step, label] of [
    ['shift+arrowleft', -0.05, 'Slider divider left'],
    ['shift+arrowright', 0.05, 'Slider divider right'],
  ] as const) {
    cleanups.push(
      onKey({
        key,
        label,
        run: () => {
          if (mode !== 'slider') return;
          split = Math.min(1, Math.max(0, split + step));
          render();
        },
      }),
    );
  }
  const zoomButton = stage.querySelector<HTMLElement>('[data-zoom="toggle"]');
  if (zoomButton) listen(zoomButton, 'click', toggleZoom);
  if (onion) listen(onion, 'input', render);
  // Changes in the info strip: pointing at one (or tabbing to it) lights it up on every
  // screenshot; a click keeps it lit until clicked again. The view does not move.
  const changeButtons = [...root.querySelectorAll<HTMLButtonElement>('button[data-change]')];
  let pinned: string | null = null;
  const light = (button: HTMLButtonElement, on: boolean) => {
    const id = button.dataset.change as string;
    const lit = on || pinned === id;
    button.classList.toggle('is-hot', lit);
    for (const rect of stage.querySelectorAll(`rect[data-change="${id}"]`)) rect.classList.toggle('is-hot', lit);
  };
  for (const button of changeButtons) {
    listen(button, 'pointerenter', () => light(button, true));
    listen(button, 'pointerleave', () => light(button, false));
    listen(button, 'focus', () => light(button, true));
    listen(button, 'blur', () => light(button, false));
    listen(button, 'click', () => {
      const id = button.dataset.change as string;
      pinned = pinned === id ? null : id;
      for (const b of changeButtons) {
        b.setAttribute('aria-pressed', String(b.dataset.change === pinned));
        light(b, b === button);
      }
    });
  }

  // Wheel and pinch zoom, drag to pan, drag the divider, double-click for Fit / 100 %.
  for (const viewport of stage.querySelectorAll<HTMLElement>('.viewport')) {
    const pointers = new Map<number, { x: number; y: number }>();
    let dragging: 'pan' | 'divider' | null = null;
    let pinch = 0;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = viewport.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const moveDivider = (e: PointerEvent) => {
      const r = layers?.getBoundingClientRect();
      if (!r || r.width === 0) return;
      split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      render();
    };

    listen(
      viewport,
      'wheel',
      (e) => {
        e.preventDefault();
        fit = false;
        view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), local(e), image(), box());
        render();
      },
      { passive: false },
    );
    listen(viewport, 'pointerdown', (e) => {
      // While an area is being drawn (areas.ts), a drag draws instead of panning.
      if (e.button !== 0 || stage.dataset.drawing) return;
      // No text selection or native image drag: either would paint over the images.
      e.preventDefault();
      viewport.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      // In Slider mode a drag moves the divider, except when zoomed and not grabbing it: then it pans.
      const onDivider = e.target instanceof Element && e.target.closest('.divider');
      dragging = mode === 'slider' && (fit || onDivider) ? 'divider' : 'pan';
      if (dragging === 'divider') moveDivider(e);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    listen(viewport, 'pointermove', (e) => {
      const previous = pointers.get(e.pointerId);
      if (!previous) return;
      const point = local(e);
      pointers.set(e.pointerId, point);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) {
          fit = false;
          view = zoomAt(view, distance / pinch, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, image(), box());
          render();
        }
        pinch = distance;
        return;
      }
      if (dragging === 'divider') return moveDivider(e);
      if (dragging === 'pan' && !fit) {
        view = panBy(view, point.x - previous.x, point.y - previous.y, image(), box());
        render();
      }
    });
    const release = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (pointers.size === 0) dragging = null;
    };
    listen(viewport, 'pointerup', release);
    listen(viewport, 'pointercancel', release);
    listen(viewport, 'dblclick', toggleZoom);
  }

  const resize = new ResizeObserver(() => render());
  resize.observe(stage);
  cleanups.push(() => resize.disconnect());
  for (const img of stage.querySelectorAll('img')) if (!img.complete) listen(img, 'load', () => render());

  cleanups.push(mountHighlight(stage, render));
  if (mode === 'new') render();
  else setMode(mode);
  return () => {
    carried = { checkId, fit, view, split, onion: onion?.value ?? '50' };
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
