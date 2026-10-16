// Ignore and compare areas drawn on the focus-mode stage (Plan 6). Pick a kind in the toolbar
// (or press I / C), drag over a screenshot, and the area is saved and the check compared again.
// Click an area (or Edit in the info strip) to move or resize it, then Save. Delete in the info
// strip removes one. Without JavaScript only Delete works (a plain form).
import { api } from './api.ts';
import { toast } from './toast.ts';

type Kind = 'ignore' | 'compare';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smaller drags are taken for clicks, not areas; an edited area cannot shrink below it either. */
const MIN_SIZE = 4;

const ADDED: Record<Kind, string> = { ignore: 'Ignore area added', compare: 'Compare area added' };

/** An edited area saves itself this long after its last change. */
const AUTOSAVE_MS = 5_000;

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number] | 'move';

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

/** `from` moved or resized by (dx, dy) image pixels through `handle`, kept inside a w×h image. */
function dragged(from: Rect, handle: Handle, dx: number, dy: number, w: number, h: number): Rect {
  if (handle === 'move') {
    return {
      ...from,
      x: Math.min(w - from.width, Math.max(0, from.x + dx)),
      y: Math.min(h - from.height, Math.max(0, from.y + dy)),
    };
  }
  let left = from.x;
  let top = from.y;
  let right = from.x + from.width;
  let bottom = from.y + from.height;
  if (handle.includes('w')) left = Math.min(right - MIN_SIZE, Math.max(0, left + dx));
  if (handle.includes('e')) right = Math.max(left + MIN_SIZE, Math.min(w, right + dx));
  if (handle.includes('n')) top = Math.min(bottom - MIN_SIZE, Math.max(0, top + dy));
  if (handle.includes('s')) bottom = Math.max(top + MIN_SIZE, Math.min(h, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function rectOf(el: SVGElement): Rect {
  const n = (name: string) => Number(el.getAttribute(name));
  return { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
}

const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Wires drawing, editing and deleting into the current #review. `changed` shows the check again
 * after the server compared it with the new areas. Returns the cleanup for the next swap.
 */
export function mountAreas(root: HTMLElement, changed: (checkId: string) => Promise<void>): () => void {
  const stage = root.querySelector<HTMLElement>('#stage');
  const checkId = root.dataset.check as string;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-draw]')];
  const editBar = root.querySelector<HTMLElement>('.area-edit-bar');
  const drawTools = root.querySelector<HTMLElement>('.draw-tools');
  // The edit bar takes the drawing tools' place, so the toolbar keeps its height and the
  // screenshot does not move under the pointer.
  const showEditBar = (on: boolean) => {
    if (editBar) editBar.hidden = !on;
    if (drawTools) drawTools.hidden = on;
  };
  const editButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-area-edit]')];
  const canEdit = editButtons.length > 0;
  const cleanups: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, handler: (event: Event) => void, options?: boolean) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };
  const rectsOf = (id: string) => [...root.querySelectorAll<SVGRectElement>(`rect[data-area="${id}"]`)];

  let kind: Kind | null = null;
  /** Ends a drag in progress without saving (set while dragging). */
  let abandon: (() => void) | null = null;
  /** Set once the next check replaced this one: a late save must not pull the reviewer back. */
  let gone = false;

  // Editing: one area at a time, shown as a box with handles over the screenshot it was picked
  // on; every copy of the area (the other panes) follows live.
  interface Editing {
    id: string;
    original: Rect;
    rect: Rect;
    box: HTMLElement;
    /** The picked screenshot's pixel size (its area layer's viewBox). */
    size: { width: number; height: number };
    layer: SVGSVGElement;
  }
  let editing: Editing | null = null;
  let saving = false;
  let autosave: ReturnType<typeof setTimeout> | undefined;
  // The autosave countdown: a ring that empties over AUTOSAVE_MS and the whole seconds left.
  const countdown = editBar?.querySelector<HTMLElement>('[data-autosave]');
  const secondsLeft = countdown?.querySelector<HTMLElement>('[data-autosave-left]');
  let tick: ReturnType<typeof setInterval> | undefined;
  const stopCountdown = () => {
    clearTimeout(autosave);
    clearInterval(tick);
    if (countdown) {
      countdown.hidden = true;
      countdown.classList.remove('running');
    }
  };
  const startCountdown = () => {
    stopCountdown();
    const ends = Date.now() + AUTOSAVE_MS;
    const show = () => {
      const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
      if (secondsLeft) secondsLeft.textContent = `${left}s`;
      countdown?.setAttribute('aria-label', `Saves itself in ${left} s`);
    };
    if (countdown) {
      countdown.hidden = false;
      // Restart the ring's animation: drop the class, let the browser notice, add it again.
      void countdown.offsetWidth;
      countdown.style.setProperty('--autosave-ms', `${AUTOSAVE_MS}ms`);
      countdown.classList.add('running');
    }
    show();
    tick = setInterval(show, 250);
    autosave = setTimeout(() => void saveEdit(), AUTOSAVE_MS);
  };

  const paintEdit = () => {
    if (!editing) return;
    const { rect, box, size } = editing;
    box.style.left = `${(rect.x / size.width) * 100}%`;
    box.style.top = `${(rect.y / size.height) * 100}%`;
    box.style.width = `${(rect.width / size.width) * 100}%`;
    box.style.height = `${(rect.height / size.height) * 100}%`;
    for (const el of rectsOf(editing.id)) {
      el.setAttribute('x', String(rect.x));
      el.setAttribute('y', String(rect.y));
      el.setAttribute('width', String(rect.width));
      el.setAttribute('height', String(rect.height));
    }
  };

  const stopEditing = (restore: boolean) => {
    stopCountdown();
    if (!editing) return;
    if (restore) editing.rect = editing.original;
    paintEdit();
    editing.box.remove();
    for (const el of rectsOf(editing.id)) el.classList.remove('is-editing');
    editing = null;
    showEditBar(false);
    if (stage?.dataset.drawing === 'edit') delete stage.dataset.drawing;
  };

  const setKind = (next: Kind | null) => {
    if (next) stopEditing(true);
    kind = next;
    if (stage) {
      if (next) stage.dataset.drawing = next;
      else if (stage.dataset.drawing !== 'edit') delete stage.dataset.drawing;
    }
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.draw === next));
  };

  const startEditing = (target: SVGRectElement) => {
    const id = target.dataset.area as string;
    if (editing?.id === id || saving) return;
    stopEditing(true);
    setKind(null);
    const layer = target.ownerSVGElement;
    const host = layer?.parentElement;
    if (!layer || !host) return;
    const size = { width: layer.viewBox.baseVal.width, height: layer.viewBox.baseVal.height };
    const box = document.createElement('div');
    box.className = `area-editor area-editor-${target.classList.contains('area-compare') ? 'compare' : 'ignore'}`;
    box.dataset.handle = 'move';
    for (const handle of HANDLES) {
      const grip = document.createElement('span');
      grip.className = `area-handle area-handle-${handle}`;
      grip.dataset.handle = handle;
      box.append(grip);
    }
    host.append(box);
    const original = rectOf(target);
    editing = { id, original, rect: { ...original }, box, size, layer };
    for (const el of rectsOf(id)) el.classList.add('is-editing');
    if (stage) stage.dataset.drawing = 'edit';
    showEditBar(true);
    paintEdit();

    box.addEventListener('pointerdown', (event) => {
      const e = event as PointerEvent;
      if (e.button !== 0 || !editing) return;
      // The viewport would pan; this drag is the area's.
      e.stopPropagation();
      e.preventDefault();
      const handle = ((e.target as HTMLElement).dataset.handle ?? 'move') as Handle;
      const from = { ...editing.rect };
      const start = { x: e.clientX, y: e.clientY };
      const scale = editing.layer.getBoundingClientRect().width / editing.size.width || 1;
      box.setPointerCapture(e.pointerId);
      const move = (ev: Event) => {
        if (!editing) return;
        const p = ev as PointerEvent;
        const dx = Math.round((p.clientX - start.x) / scale);
        const dy = Math.round((p.clientY - start.y) / scale);
        editing.rect = dragged(from, handle, dx, dy, editing.size.width, editing.size.height);
        paintEdit();
      };
      const end = () => {
        edited();
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', end);
        box.removeEventListener('pointercancel', end);
        box.removeEventListener('lostpointercapture', end);
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);
      box.addEventListener('lostpointercapture', end);
    });
  };

  // Every change restarts the countdown; when it runs out the area saves itself.
  const edited = () => {
    if (!editing || same(editing.rect, editing.original)) return stopCountdown();
    startCountdown();
  };

  const saveEdit = async () => {
    stopCountdown();
    if (!editing || saving) return;
    const { id, rect, original } = editing;
    if (same(rect, original)) return stopEditing(false);
    saving = true;
    try {
      await api('PATCH', `/checks/${checkId}/areas/${id}`, rect);
      // The saved rectangle is the one to keep.
      editing.original = rect;
      stopEditing(false);
      toast('Area updated', { tone: 'success', timeout: 2500 });
      if (!gone) await changed(checkId);
    } catch (err) {
      toast(`Couldn't update the area: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
    } finally {
      saving = false;
    }
  };

  for (const b of buttons) listen(b, 'click', () => setKind(kind === b.dataset.draw ? null : (b.dataset.draw as Kind)));
  // Escape leaves drawing or editing before it can mean "back to the build". While editing,
  // Enter saves and the arrow keys nudge the area (Shift: 10 px) instead of changing checks.
  listen(
    document,
    'keydown',
    (event) => {
      const e = event as KeyboardEvent;
      const take = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (kind && e.key === 'Escape') {
        take();
        setKind(null);
        return;
      }
      if (!editing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
      if (e.key === 'Escape') {
        take();
        stopEditing(true);
      } else if (e.key === 'Enter') {
        take();
        void saveEdit();
      } else if (e.key.startsWith('Arrow')) {
        take();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        editing.rect = dragged(editing.rect, 'move', dx, dy, editing.size.width, editing.size.height);
        paintEdit();
        edited();
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
    // A press on an area (not while drawing) picks it for editing instead of panning.
    if (canEdit) {
      listen(
        viewport,
        'pointerdown',
        (event) => {
          const e = event as PointerEvent;
          if (kind || e.button !== 0 || !(e.target instanceof SVGRectElement)) return;
          const target = e.target.closest<SVGRectElement>('rect[data-area]');
          if (!target) return;
          e.stopPropagation();
          e.preventDefault();
          startEditing(target);
        },
        true,
      );
    }
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

  if (stage && canEdit) stage.dataset.areasEditable = '';
  for (const button of editButtons) {
    button.hidden = false;
    listen(button, 'click', () => {
      // The copy on a screenshot that is on screen in the current mode.
      const target = rectsOf(button.dataset.areaEdit as string).find((el) => el.getBoundingClientRect().width > 0);
      if (target) startEditing(target);
    });
  }
  const saveButton = editBar?.querySelector<HTMLButtonElement>('[data-area-save]');
  const cancelButton = editBar?.querySelector<HTMLButtonElement>('[data-area-cancel]');
  if (saveButton) listen(saveButton, 'click', () => void saveEdit());
  if (cancelButton) listen(cancelButton, 'click', () => stopEditing(true));

  // Pointing at (or tabbing into) an area in the list lights it up on every screenshot.
  for (const item of root.querySelectorAll<HTMLElement>('[data-area-item]')) {
    const rects = rectsOf(item.dataset.areaItem as string);
    const light = (on: boolean) => {
      item.classList.toggle('is-hot', on);
      for (const rect of rects) rect.classList.toggle('is-hot', on);
    };
    listen(item, 'pointerenter', () => light(true));
    listen(item, 'pointerleave', () => light(false));
    listen(item, 'focusin', () => light(true));
    listen(item, 'focusout', () => light(false));
  }

  // Ignore next to a change: the same area through the API, then the check compared again.
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-area-add]')) {
    listen(form, 'submit', (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const number = (name: string) => Number(data.get(name));
      const added = data.get('kind') === 'compare' ? 'compare' : 'ignore';
      void save(added, { x: number('x'), y: number('y'), width: number('width'), height: number('height') });
    });
  }

  // Ignore all changes: one call adds an area around each, then the check is compared again.
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-ignore-changes]')) {
    listen(form, 'submit', (e) => {
      e.preventDefault();
      const button = form.querySelector('button');
      if (button) button.disabled = true;
      void (async () => {
        try {
          const { areas } = await api<{ areas: unknown[] }>('POST', `/checks/${checkId}/areas/ignore-changes`);
          toast(`Ignored ${areas.length} changes`, { tone: 'success', timeout: 2000 });
          if (!gone) await changed(checkId);
        } catch (err) {
          if (button) button.disabled = false;
          toast(`Couldn't ignore the changes: ${err instanceof Error ? err.message : String(err)}`, {
            tone: 'danger',
          });
        }
      })();
    });
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
    stopEditing(true);
    setKind(null);
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
