// Ignore and compare areas drawn on the focus-mode stage (Plan 6). Pick a kind in the toolbar
// (or press I / C), drag over a screenshot, and the area is saved and the check compared again.
// Click an area (or Edit in the info strip) to move or resize it, then Save. Delete in the info
// strip removes one. Alt+drag an area, or Cmd/Ctrl+D (Duplicate) on the picked one, adds a copy
// of the same size. Without JavaScript only Delete works (a plain form).
import { api } from './api.ts';
import { hint } from './keys.ts';
import { copyPlace, dragged, type Handle, MIN_SIZE, type Rect, type Size, same } from './rects.ts';
import { toast } from './toast.ts';

type Kind = 'ignore' | 'compare';

const ADDED: Record<Kind, string> = { ignore: 'Ignore area added', compare: 'Compare area added' };

/** An edited area saves itself this long after its last change. */
const AUTOSAVE_MS = 5_000;

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

const MAC = navigator.platform.startsWith('Mac');
const MOD = MAC ? '⌘' : 'Ctrl+';
const ALT = MAC ? '⌥' : 'Alt';

/** The area to pick once the check is shown again: the duplicate just made. */
let pick: { checkId: string; id: string } | null = null;
/**
 * The last duplicate and the rectangle it was copied from: Cmd+D on it repeats the move it got
 * (smart duplicate), and Cmd+Z or Undo on its toast deletes it. Any other area change forgets it.
 */
let lastCopy: { checkId: string; id: string; from: Rect } | null = null;

/** Deletes the last duplicate, then shows its check again if it is still the one on screen. */
async function undoCopy(changed: (checkId: string) => Promise<void>): Promise<void> {
  const copy = lastCopy;
  if (!copy) return;
  lastCopy = null;
  try {
    await api('DELETE', `/checks/${copy.checkId}/areas/${copy.id}`);
    toast('Duplicate removed', { timeout: 2000 });
    if (document.querySelector<HTMLElement>('#review')?.dataset.check === copy.checkId) await changed(copy.checkId);
  } catch (err) {
    toast(`Couldn't remove the duplicate: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
  }
}

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

function rectOf(el: SVGElement): Rect {
  const n = (name: string) => Number(el.getAttribute(name));
  return { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
}

const sizeOf = (layer: SVGSVGElement): Size => ({
  width: layer.viewBox.baseVal.width,
  height: layer.viewBox.baseVal.height,
});

const kindOf = (el: Element): Kind => (el.classList.contains('area-compare') ? 'compare' : 'ignore');

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
    kind: Kind;
    original: Rect;
    rect: Rect;
    box: HTMLElement;
    /** The picked screenshot's pixel size (its area layer's viewBox). */
    size: Size;
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
    const size = sizeOf(layer);
    const areaKind = kindOf(target);
    const box = document.createElement('div');
    box.className = `area-editor area-editor-${areaKind}`;
    box.dataset.handle = 'move';
    box.title =
      `Drag to move, ${ALT}+drag to duplicate. ${MOD}D duplicates, arrows nudge 1 px ` +
      '(Shift: 10 px), Delete removes.';
    for (const handle of HANDLES) {
      const grip = document.createElement('span');
      grip.className = `area-handle area-handle-${handle}`;
      grip.dataset.handle = handle;
      box.append(grip);
    }
    host.append(box);
    const original = rectOf(target);
    editing = { id, kind: areaKind, original, rect: { ...original }, box, size, layer };
    for (const el of rectsOf(id)) el.classList.add('is-editing');
    if (stage) stage.dataset.drawing = 'edit';
    showEditBar(true);
    paintEdit();

    box.addEventListener('pointerdown', (event) => {
      const e = event as PointerEvent;
      if (e.button !== 0 || !editing) return;
      // Alt (Option) drags out a copy instead, wherever on the box the drag starts.
      if (e.altKey) {
        copyDrag(e, box, { id: editing.id, kind: editing.kind, rect: editing.rect }, editing.layer);
        return;
      }
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

  // Duplicating: a new area of the same kind and size, saved like a drawn one, then picked so it
  // can be dragged or nudged into place.
  interface Source {
    id: string;
    kind: Kind;
    rect: Rect;
  }
  const limit = Number(root.dataset.areaLimit) || Number.POSITIVE_INFINITY;
  /** Says so and returns true when the snapshot cannot take another area. */
  const atLimit = () => {
    if (root.querySelectorAll('[data-area-item]').length < limit) return false;
    toast(`This snapshot already has ${limit} areas, the most it can have. Delete one to add another.`, {
      tone: 'danger',
    });
    return true;
  };

  /** Repeats the last duplicate's move when `source` is that duplicate, still of the same size. */
  const stepFor = (source: Source) => {
    const copy = lastCopy;
    if (copy?.checkId !== checkId || copy.id !== source.id) return undefined;
    if (copy.from.width !== source.rect.width || copy.from.height !== source.rect.height) return undefined;
    return { dx: source.rect.x - copy.from.x, dy: source.rect.y - copy.from.y };
  };

  const duplicate = async (source: Source, to: Rect) => {
    if (saving || atLimit()) return;
    saving = true;
    stopCountdown();
    let patched = false;
    try {
      // A move not saved yet is saved first: the check is shown again below, which would drop it.
      if (editing && !same(editing.rect, editing.original)) {
        await api('PATCH', `/checks/${checkId}/areas/${editing.id}`, editing.rect);
        editing.original = editing.rect;
        patched = true;
      }
      const { area } = await api<{ area: { id: string } }>('POST', `/checks/${checkId}/areas`, {
        kind: source.kind,
        ...to,
      });
      lastCopy = { checkId, id: area.id, from: source.rect };
      pick = { checkId, id: area.id };
      toast('Area duplicated', {
        tone: 'success',
        timeout: 4000,
        action: { label: `Undo (${MOD}Z)`, run: () => void undoCopy(changed) },
      });
      if (!gone) await changed(checkId);
    } catch (err) {
      toast(`Couldn't duplicate the area: ${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
      if (patched && !gone) await changed(checkId);
    } finally {
      saving = false;
    }
  };

  /** Cmd/Ctrl+D and Duplicate: a copy next to the area (see copyPlace), picked at once. */
  const duplicateNextTo = (source: Source, size: Size) =>
    void duplicate(source, copyPlace(source.rect, size, stepFor(source)));

  /** Alt+drag: a copy follows the pointer, the area stays; the copy is added where it is dropped. */
  const copyDrag = (e: PointerEvent, capture: HTMLElement, source: Source, layer: SVGSVGElement) => {
    e.stopPropagation();
    e.preventDefault();
    const host = layer.parentElement;
    if (!host || saving || atLimit()) return;
    const size = sizeOf(layer);
    const scale = layer.getBoundingClientRect().width / size.width || 1;
    const start = { x: e.clientX, y: e.clientY };
    let to = source.rect;
    const ghost = document.createElement('div');
    ghost.className = `area-ghost area-ghost-${source.kind}`;
    const paint = () => {
      ghost.style.left = `${(to.x / size.width) * 100}%`;
      ghost.style.top = `${(to.y / size.height) * 100}%`;
      ghost.style.width = `${(to.width / size.width) * 100}%`;
      ghost.style.height = `${(to.height / size.height) * 100}%`;
    };
    paint();
    host.append(ghost);
    capture.setPointerCapture(e.pointerId);
    const move = (ev: Event) => {
      const p = ev as PointerEvent;
      const dx = Math.round((p.clientX - start.x) / scale);
      const dy = Math.round((p.clientY - start.y) / scale);
      to = dragged(source.rect, 'move', dx, dy, size.width, size.height);
      paint();
    };
    const finish = (ev: Event | null) => {
      capture.removeEventListener('pointermove', move);
      capture.removeEventListener('pointerup', finish);
      capture.removeEventListener('pointercancel', finish);
      capture.removeEventListener('lostpointercapture', finish);
      abandon = null;
      ghost.remove();
      // An Alt+click (no move) adds nothing.
      if (ev?.type === 'pointerup' && !same(to, source.rect)) void duplicate(source, to);
    };
    abandon = () => finish(null);
    capture.addEventListener('pointermove', move);
    capture.addEventListener('pointerup', finish);
    capture.addEventListener('pointercancel', finish);
    capture.addEventListener('lostpointercapture', finish);
  };

  /** The area as it is now: the picked one with its unsaved move, else its copy on screen. */
  const sourceOf = (id: string): { source: Source; size: Size } | null => {
    if (editing?.id === id) {
      return { source: { id, kind: editing.kind, rect: editing.rect }, size: editing.size };
    }
    const rects = rectsOf(id);
    const el = rects.find((r) => r.getBoundingClientRect().width > 0) ?? rects[0];
    const layer = el?.ownerSVGElement;
    if (!el || !layer) return null;
    return { source: { id, kind: kindOf(el), rect: rectOf(el) }, size: sizeOf(layer) };
  };

  for (const b of buttons) listen(b, 'click', () => setKind(kind === b.dataset.draw ? null : (b.dataset.draw as Kind)));
  // Escape leaves drawing or editing before it can mean "back to the build". While editing,
  // Enter saves, the arrow keys nudge the area (Shift: 10 px) instead of changing checks, Delete
  // (or Backspace) deletes it and Cmd/Ctrl+D duplicates it. Cmd/Ctrl+Z deletes the last duplicate.
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
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (document.querySelector('dialog[open]')) return;
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      const letter = e.key.toLowerCase();
      if (canEdit && mod && letter === 'z' && lastCopy?.checkId === checkId) {
        take();
        if (!e.repeat) void undoCopy(changed);
        return;
      }
      if (editing && mod && letter === 'd') {
        // Also keeps the browser from bookmarking the page.
        take();
        if (!e.repeat) duplicateNextTo({ id: editing.id, kind: editing.kind, rect: editing.rect }, editing.size);
        return;
      }
      if (!editing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        take();
        root.querySelector<HTMLFormElement>(`form[data-area-delete="${editing.id}"]`)?.requestSubmit();
      } else if (e.key === 'Escape') {
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
    if (atLimit()) return;
    try {
      await api('POST', `/checks/${checkId}/areas`, { kind: drawn, ...rect });
      lastCopy = null;
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
          const layer = target.ownerSVGElement;
          const found = e.altKey ? sourceOf(target.dataset.area as string) : null;
          if (found && layer) {
            copyDrag(e, viewport, found.source, layer);
            return;
          }
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
  const duplicateButton = editBar?.querySelector<HTMLButtonElement>('[data-area-duplicate-picked]');
  if (duplicateButton) {
    listen(duplicateButton, 'click', () => {
      if (editing) duplicateNextTo({ id: editing.id, kind: editing.kind, rect: editing.rect }, editing.size);
    });
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-area-duplicate]')) {
    button.hidden = false;
    listen(button, 'click', () => {
      const found = sourceOf(button.dataset.areaDuplicate as string);
      if (found) duplicateNextTo(found.source, found.size);
    });
  }
  // The shortcut as this platform writes it, on the buttons and in their tooltips.
  for (const kbd of root.querySelectorAll<HTMLElement>('[data-mod-key]'))
    kbd.textContent = `${MOD}${kbd.dataset.modKey}`;
  for (const el of root.querySelectorAll<HTMLElement>('[data-mod-title]')) {
    el.title = (el.dataset.modTitle as string).replace('{mod}', MOD);
  }

  if (canEdit) {
    for (const rect of root.querySelectorAll<SVGRectElement>('rect[data-area]')) {
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `Click to move or resize, ${ALT}+drag to duplicate`;
      rect.append(title);
    }
    for (const [key, label] of [
      ['alt+drag', 'Duplicate an area: drag the copy where it goes'],
      ['mod+d', 'Duplicate the picked area'],
      ['arrows', 'Nudge the picked area 1 px'],
      ['shift+arrows', 'Nudge the picked area 10 px'],
      ['delete', 'Delete the picked area'],
      ['mod+z', 'Remove the duplicate just made'],
    ] as const) {
      cleanups.push(hint(key, label));
    }
    // While Alt (Option) is held, pointing at an area shows the copy cursor.
    const copying = (on: boolean) => stage?.toggleAttribute('data-copying', on);
    listen(document, 'keydown', (e) => (e as KeyboardEvent).key === 'Alt' && copying(true));
    listen(document, 'keyup', (e) => (e as KeyboardEvent).key === 'Alt' && copying(false));
    if (stage) listen(stage, 'pointermove', (e) => copying((e as PointerEvent).altKey));
    listen(window, 'blur', () => copying(false));
  }

  // The duplicate just made comes back picked, ready to be dragged or nudged into place.
  if (pick?.checkId === checkId && canEdit) {
    const target = rectsOf(pick.id).find((el) => el.getBoundingClientRect().width > 0) ?? rectsOf(pick.id)[0];
    if (target) startEditing(target);
  }
  pick = null;

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
          lastCopy = null;
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
          if (lastCopy?.id === areaId) lastCopy = null;
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
    stage?.removeAttribute('data-copying');
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
