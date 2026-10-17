// Insights charts: one styled tooltip for the band under the pointer, and the arrow keys along a
// focused chart. The charts read without it: each band keeps a native <title> until this starts,
// and every chart has its numbers in a table.
import { hint } from './keys.ts';

let tip: HTMLDivElement | null = null;

function tooltip(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.setAttribute('aria-live', 'polite');
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function hide(): void {
  if (tip) tip.hidden = true;
  for (const band of document.querySelectorAll('.chart-band.is-active')) band.classList.remove('is-active');
}

/** Shows band `band` of `plot`: its lines as the tooltip (values first), its crosshair. */
function show(plot: HTMLElement, band: Element): void {
  hide();
  band.classList.add('is-active');
  const [title, ...rows] = (band.getAttribute('data-tip') ?? '').split('\n');
  const slots = (plot.dataset.slots ?? '').split(' ');
  const box = tooltip();
  box.replaceChildren();
  const head = document.createElement('p');
  head.className = 'chart-tip-title';
  head.textContent = title ?? '';
  box.append(head);
  rows.forEach((row, i) => {
    const at = row.lastIndexOf(': ');
    const line = document.createElement('p');
    const key = document.createElement('span');
    key.className = `chart-tip-key viz-${slots[i] ?? '1'}`;
    const value = document.createElement('strong');
    value.textContent = row.slice(at + 2);
    line.append(key, value, document.createTextNode(` ${row.slice(0, at)}`));
    box.append(line);
  });
  box.hidden = false;
  const hit = band.querySelector('.chart-hit')?.getBoundingClientRect();
  const area = plot.getBoundingClientRect();
  if (!hit) return;
  const width = box.offsetWidth;
  const center = hit.left + hit.width / 2;
  const left = Math.min(Math.max(8, center - width / 2), document.documentElement.clientWidth - width - 8);
  box.style.left = `${left + window.scrollX}px`;
  box.style.top = `${area.top + window.scrollY - box.offsetHeight - 6}px`;
}

export function init(): void {
  const plots = document.querySelectorAll<HTMLElement>('[data-chart]');
  if (plots.length === 0) return;
  hint('arrowleft', 'Previous day of a focused chart');
  hint('arrowright', 'Next day of a focused chart');
  for (const plot of plots) {
    const bands = [...plot.querySelectorAll('.chart-band')];
    // The styled tooltip replaces the native one.
    for (const band of bands) band.querySelector('title')?.remove();
    let current = -1;
    const go = (i: number) => {
      current = Math.max(0, Math.min(bands.length - 1, i));
      const band = bands[current];
      if (band) show(plot, band);
    };
    plot.addEventListener('pointermove', (event) => {
      const band = event.target instanceof Element ? event.target.closest('.chart-band') : null;
      if (!band || band.classList.contains('is-active')) return;
      current = bands.indexOf(band);
      show(plot, band);
    });
    plot.addEventListener('pointerleave', () => {
      if (document.activeElement !== plot) hide();
    });
    plot.addEventListener('focus', () => go(current < 0 ? bands.length - 1 : current));
    plot.addEventListener('blur', hide);
    plot.addEventListener('keydown', (event) => {
      const moves: Record<string, number> = {
        ArrowLeft: current - 1,
        ArrowRight: current + 1,
        Home: 0,
        End: bands.length - 1,
      };
      if (event.key === 'Escape') {
        hide();
        return;
      }
      const to = moves[event.key];
      if (to === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      go(to);
    });
  }
  window.addEventListener('resize', hide);
}
