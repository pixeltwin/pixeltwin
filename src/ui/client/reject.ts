// The reject popover (ui/reject-menu.tsx): a <details> anchored to a Reject button. Opened (R, or
// a click), the categories take the focus: 1–7 picks one (again unpicks it), a letter starts the
// comment, Enter rejects, Esc closes. While it is open no global shortcut sees the keys. One menu
// is open at a time; a click outside closes it. Rejecting is the page's: `onReject` gets the form
// and what it says (the check page posts it, the build page posts the group in place).
import { popoverAction } from './reasons.ts';

export interface RejectBody {
  reasonCode?: string;
  reason?: string;
}

/** What the form says: the picked category and the comment, when given. */
export function bodyOfReject(form: HTMLFormElement): RejectBody {
  const data = new FormData(form);
  const reasonCode = String(data.get('reasonCode') ?? '');
  const reason = String(data.get('reason') ?? '').trim();
  return { ...(reasonCode ? { reasonCode } : {}), ...(reason ? { reason } : {}) };
}

function menuOf(node: EventTarget | null): HTMLDetailsElement | null {
  return node instanceof Element ? node.closest<HTMLDetailsElement>('details[data-reject-menu]') : null;
}

/**
 * A popover that would end below the window (a card in the build page's bottom row: that page does
 * not scroll) opens upwards instead, when there is room above; it opens downwards again next time.
 */
function place(menu: HTMLDetailsElement): void {
  if (menu.classList.contains('up')) return;
  const box = menu.querySelector('.reject-popover')?.getBoundingClientRect();
  if (box && box.bottom > window.innerHeight && box.height < menu.getBoundingClientRect().top) {
    menu.classList.add('up');
    menu.dataset.flipped = '';
  }
}

function unplace(menu: HTMLDetailsElement): void {
  if (menu.dataset.flipped === undefined) return;
  menu.classList.remove('up');
  delete menu.dataset.flipped;
}

export function closeMenu(menu: HTMLDetailsElement, focusButton = true): void {
  if (!menu.open) return;
  const hadFocus = menu.contains(document.activeElement);
  menu.open = false;
  unplace(menu);
  menu.querySelector<HTMLFormElement>('form')?.reset();
  if (focusButton && hadFocus) menu.querySelector<HTMLElement>('summary')?.focus();
}

function pick(menu: HTMLDetailsElement, index: number): void {
  const radios = [...menu.querySelectorAll<HTMLInputElement>('input[name="reasonCode"]')];
  const radio = radios[index];
  if (!radio) return;
  radio.checked = !radio.checked;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

let started = false;

/** Opens the menu (closing any other) and gives its categories the focus at once. */
export function openMenu(menu: HTMLDetailsElement): void {
  menu.open = true;
  place(menu);
  menu.querySelector<HTMLElement>('[data-reason-chips]')?.focus({ preventScroll: true });
}

/**
 * Starts the popover behaviour on the page; `onReject` handles a submitted reject form (one posted
 * in place, `data-inplace`, is left to the live island).
 */
export function initRejectMenus(
  onReject: (form: HTMLFormElement, body: RejectBody, label: string) => void = () => {},
): void {
  if (started) return;
  started = true;
  // toggle does not bubble: listen in the capture phase, also for menus swapped in later.
  document.addEventListener(
    'toggle',
    (event) => {
      const menu = event.target instanceof HTMLDetailsElement && event.target.matches('[data-reject-menu]');
      if (!menu) return;
      const details = event.target as HTMLDetailsElement;
      if (!details.open) {
        details.querySelector<HTMLFormElement>('form')?.reset();
        unplace(details);
        return;
      }
      place(details);
      for (const other of document.querySelectorAll<HTMLDetailsElement>('details[data-reject-menu][open]')) {
        if (other !== details) closeMenu(other, false);
      }
      details.querySelector<HTMLElement>('[data-reason-chips]')?.focus({ preventScroll: true });
    },
    true,
  );
  // Before the global shortcuts (they listen on the document in the bubble phase).
  document.addEventListener(
    'keydown',
    (event) => {
      const menu = menuOf(event.target);
      if (!menu?.open) return;
      const target = event.target as HTMLElement;
      // On the Reject button itself only Esc is the menu's (Enter and Space toggle it).
      if (target.tagName === 'SUMMARY') {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        event.preventDefault();
        closeMenu(menu);
        return;
      }
      const action = popoverAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        inComment: target.matches('[data-reason-comment]'),
        onButton: target instanceof HTMLButtonElement,
      });
      if (event.ctrlKey || event.metaKey) return;
      event.stopPropagation();
      if (action.kind === 'cancel') {
        event.preventDefault();
        closeMenu(menu);
      } else if (action.kind === 'submit') {
        event.preventDefault();
        menu.querySelector<HTMLFormElement>('form')?.requestSubmit();
      } else if (action.kind === 'pick') {
        event.preventDefault();
        pick(menu, action.index);
      } else if (action.kind === 'comment') {
        menu.querySelector<HTMLInputElement>('[data-reason-comment]')?.focus();
      }
    },
    true,
  );
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-reject-cancel]')) {
      const menu = menuOf(target);
      if (menu) closeMenu(menu);
      return;
    }
    for (const open of document.querySelectorAll<HTMLDetailsElement>('details[data-reject-menu][open]')) {
      if (!open.contains(target)) closeMenu(open, false);
    }
  });
  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form?.matches('[data-reject-form]') || event.defaultPrevented) return;
    const menu = menuOf(form);
    // A form posted in place (the build page's live island) reads its fields first; close after.
    if (form.dataset.inplace) {
      if (menu) setTimeout(() => closeMenu(menu), 0);
      return;
    }
    event.preventDefault();
    const body = bodyOfReject(form);
    // The picked chip's words, for the page's toast.
    const label = form.querySelector('input[name="reasonCode"]:checked')?.closest('label')?.querySelector('span');
    const words = label?.textContent?.trim() ?? '';
    if (menu) closeMenu(menu);
    onReject(form, body, words);
  });
}
