// Promote page, Compare: side by side (main, branch, diff) or a slider (the branch over main).
// Scroll (or pinch) zooms at the pointer, a drag moves (in the slider, unzoomed, it moves the
// divider), a double-click switches between fit and 100 %. Every image of a screen shares one view,
// so the same spot stays side by side.
import { actualView, clampPan, fitView, panBy, type Size, type View, zoomAt } from './zoom.ts';

function mount(group: HTMLElement): void {
  const viewports = [...group.querySelectorAll<HTMLElement>('.promote-viewport')];
  const images = viewports.flatMap((v) => [...v.querySelectorAll('img')]);
  const first = images[0];
  if (!first) return;
  const modes = group.parentElement?.querySelector<HTMLElement>('.promote-modes');
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

  const render = () => {
    for (const viewport of viewports) viewport.classList.toggle('zoomed', view !== null);
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
  };

  // Zooming keeps each viewport at the height it had fitted, so the page does not jump.
  const lockHeights = () => {
    for (const viewport of visible()) viewport.style.height = `${viewport.clientHeight}px`;
  };
  const unlockHeights = () => {
    for (const viewport of viewports) viewport.style.removeProperty('height');
  };
  const setView = (next: View | null) => {
    if (next && next.scale <= fitView(image(), box()).scale + 1e-6) next = null;
    if (next && !view) lockHeights();
    if (!next) unlockHeights();
    view = next ? clampPan(next, image(), box()) : null;
    render();
  };

  if (modes && slider) {
    modes.hidden = false;
    const buttons = [...modes.querySelectorAll<HTMLButtonElement>('[data-promote-mode]')];
    for (const button of buttons) {
      button.addEventListener('click', () => {
        group.dataset.mode = button.dataset.promoteMode;
        for (const b of buttons) b.setAttribute('aria-pressed', String(b === button));
        setView(null);
      });
    }
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
        setView(zoomAt(view ?? fitView(image(), box()), Math.exp(-e.deltaY * 0.0015), local(e), image(), box()));
      },
      { passive: false },
    );
    viewport.addEventListener('dblclick', () => setView(view ? null : actualView(image(), box())));
    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Unzoomed, a drag in the slider moves its divider; zoomed, a drag pans (the divider stays).
      const moveDivider = viewport === slider && !view;
      if (!moveDivider && !view) return;
      e.preventDefault();
      viewport.setPointerCapture(e.pointerId);
      let last = { x: e.clientX, y: e.clientY };
      const place = (ev: PointerEvent) => {
        const r = viewport.getBoundingClientRect();
        split = Math.min(1, Math.max(0, (ev.clientX - r.left) / (r.width || 1)));
        render();
      };
      if (moveDivider) place(e);
      const move = (ev: PointerEvent) => {
        if (moveDivider) return place(ev);
        if (!view) return;
        setView(panBy(view, ev.clientX - last.x, ev.clientY - last.y, image(), box()));
        last = { x: ev.clientX, y: ev.clientY };
      };
      const end = () => {
        viewport.removeEventListener('pointermove', move);
        viewport.removeEventListener('pointerup', end);
        viewport.removeEventListener('pointercancel', end);
      };
      viewport.addEventListener('pointermove', move);
      viewport.addEventListener('pointerup', end);
      viewport.addEventListener('pointercancel', end);
    });
  }
}

export function init(): void {
  for (const group of document.querySelectorAll<HTMLElement>('.promote-large')) mount(group);
}
