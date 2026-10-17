// Toasts (UI spec §3.2): short messages in the layout's aria-live region, with an optional
// action (Undo, Retry). With JavaScript they replace the server's flash banners.

/** The colour of what happened: green done, red rejected or failed, amber needs a look. */
export type ToastTone = 'neutral' | 'success' | 'danger' | 'warning';

export interface ToastOptions {
  tone?: ToastTone;
  action?: { label: string; run: () => void };
  /** Milliseconds before it closes by itself; 0 keeps it open. Default 5000. */
  timeout?: number;
}

export interface Toast {
  close(): void;
}

function region(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('[data-toasts]');
  if (existing) return existing;
  const created = document.createElement('div');
  created.className = 'toasts';
  created.setAttribute('aria-live', 'polite');
  created.dataset.toasts = '';
  document.body.append(created);
  return created;
}

/**
 * On a page with a review action bar (the check page) the top right holds the check's own
 * navigation, so toasts sit centred just above the action bar instead, clear of every button.
 */
function place(container: HTMLElement): void {
  const bar = document.querySelector<HTMLElement>('.action-bar');
  container.classList.toggle('above-actions', bar !== null);
  if (!bar) return;
  const gap = 12;
  container.style.setProperty(
    '--toasts-bottom',
    `${Math.max(gap, window.innerHeight - bar.getBoundingClientRect().top + gap)}px`,
  );
}

export function toast(message: string, options: ToastOptions = {}): Toast {
  const el = document.createElement('div');
  el.className = `toast tone-${options.tone ?? 'neutral'}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (options.action) {
    const { label, run } = options.action;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small ghost';
    button.textContent = label;
    button.addEventListener('click', () => {
      close();
      run();
    });
    el.append(button);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'small ghost toast-close';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', close);
  el.append(dismiss);

  const container = region();
  place(container);
  // One toast at a time: a new one replaces what was shown.
  container.replaceChildren(el);
  const timeout = options.timeout ?? 5000;
  if (timeout > 0) timer = setTimeout(close, timeout);
  return { close };
}

/** Server flash banners (`.flash`) become toasts; the banner stays for no-JS visitors only. */
export function initToasts(): void {
  for (const flash of document.querySelectorAll<HTMLElement>('main .flash')) {
    toast(flash.textContent ?? '', { tone: flash.classList.contains('error') ? 'danger' : 'success' });
    flash.remove();
  }
}
