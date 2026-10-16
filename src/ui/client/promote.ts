// Promote page, Compare: side by side (main, branch, diff) or a slider (the branch over main).
// A click zooms in where it lands, the wheel (or a pinch) zooms at the pointer, a drag moves, and
// − / Fit / + do the same from the toolbar. Every image of a screen shares one view, so the same
// spot stays side by side. In the slider the divider follows the pointer: no dragging needed.
import { clampPan, fitView, MAX_SCALE, panBy, type Size, type View, zoomAt } from './zoom.ts';

/** A press that moves less than this is a click (zoom in), not a drag (move). */
const CLICK_SLOP = 4;

function mount(group: HTMLElement): void {
  const viewports = [...group.querySelectorAll<HTMLElement>('.promote-viewport')];
  const images = viewports.flatMap((v) => [...v.querySelectorAll('img')]);
  const first = images[0];
  if (!first) return;
  const tools = group.parentElement?.querySelector<HTMLElement>('.promote-tools');
  const label = tools?.querySelector<HTMLElement>('[data-promote-zoom-label]');
  const slider = group.querySelector<HTMLElement>('.promote-slider');
  const topLayer = slider?.querySelector<HTMLElement>('.promote-top-layer');
  const divider = slider?.querySelector<HTMLElement>('.promote-divider');
  /** null: fitted by CSS (the page's own layout). */
  let view: View | null = null;
  let split = 0.5;

  const visible = () => viewports.filter((v) => v.offsetParent !== null);
  const image = (): Size => ({ width: first.naturalWidth || 1, height: first.naturalHeight || 1 });
  const box = (): Size => {
    const v = visible()[0];
    return { width: v?.clientWidth || 1, height: v?.clientHeight || 1 };
  };
  const fit = () => fitView(image(), box());

  const render = () => {
    for (const viewport of viewports) {
      viewport.classList.toggle('zoomed', view !== null);
      viewport.classList.toggle('at-max', (view?.scale ?? 0) >= MAX_SCALE - 1e-6);
    }
    for (const img of images) {
      if (!view) {
        img.removeAttribute('style');
        continue;
      }
      img.style.width = `${img.naturalWidth}px`;
      img.style.height = `${img.naturalHeight}px`;
      img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    if (topLayer) topLayer.style.clipPath = `inset(0 0 0 ${split * 100}%)`;
    if (divider) divider.style.left = `${split * 100}%`;
    if (label) label.textContent = view ? `${Math.round((view.scale / fit().scale) * 100)}%` : 'Fit';
  };

  // Zooming keeps each viewport at the height it had fitted, so the page does not jump.
  const lockHeights = () => {
    for (const viewport of visible()) viewport.style.height = `${viewport.clientHeight}px`;
  };
  const unlockHeights = () => {
    for (const viewport of viewports) viewport.style.removeProperty('height');
  };
  const setView = (next: View | null) => {
    if (next && next.scale <= fit().scale + 1e-6) next = null;
    if (next && !view) lockHeights();
    if (!next) unlockHeights();
    view = next ? clampPan(next, image(), box()) : null;
    render();
  };
  const zoomBy = (factor: number, point = { x: box().width / 2, y: box().height / 2 }) => {
    if (!view) lockHeights();
    setView(zoomAt(view ?? fit(), factor, point, image(), box()));
  };

  if (tools) {
    tools.hidden = false;
    const modes = [...tools.querySelectorAll<HTMLButtonElement>('[data-promote-mode]')];
    for (const button of modes) {
      button.addEventListener('click', () => {
        group.dataset.mode = button.dataset.promoteMode;
        for (const b of modes) b.setAttribute('aria-pressed', String(b === button));
        setView(null);
      });
    }
    tools.querySelector('[data-promote-zoom="in"]')?.addEventListener('click', () => zoomBy(2));
    tools.querySelector('[data-promote-zoom="out"]')?.addEventListener('click', () => view && zoomBy(0.5));
    tools.querySelector('[data-promote-zoom="fit"]')?.addEventListener('click', () => setView(null));
  }

  for (const viewport of viewports) {
    const local = (e: { clientX: number; clientY: number }) => {
      const r = viewport.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.0015), local(e));
      },
      { passive: false },
    );
    // The slider's divider follows the pointer while no button is pressed.
    if (viewport === slider) {
      viewport.addEventListener('pointermove', (e) => {
        if (e.buttons !== 0) return;
        const r = viewport.getBoundingClientRect();
        split = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
        render();
      });
    }
    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      viewport.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY };
      let last = start;
      let dragged = false;
      const move = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > CLICK_SLOP) dragged = true;
        if (dragged && view) setView(panBy(view, ev.clientX - last.x, ev.clientY - last.y, image(), box()));
        last = { x: ev.clientX, y: ev.clientY };
      };
      const end = (ev: PointerEvent) => {
        viewport.removeEventListener('pointermove', move);
        viewport.removeEventListener('pointerup', end);
        viewport.removeEventListener('pointercancel', end);
        if (ev.type === 'pointerup' && !dragged && (view?.scale ?? 0) < MAX_SCALE) zoomBy(2, local(ev));
      };
      viewport.addEventListener('pointermove', move);
      viewport.addEventListener('pointerup', end);
      viewport.addEventListener('pointercancel', end);
    });
  }
  render();
}

export function init(): void {
  for (const group of document.querySelectorAll<HTMLElement>('.promote-large')) mount(group);
}
