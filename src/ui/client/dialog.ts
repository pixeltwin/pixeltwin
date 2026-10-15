// Dialogs (UI spec §6.1): native <dialog> with showModal(), which makes the rest of the page
// inert and returns focus to the opener on close.
//   <button data-dialog-open="new-token">   opens <dialog id="new-token">
//   <button data-dialog-close>               closes the dialog it is in
//   <button data-confirm="Delete it?">       asks before its form is submitted

export interface ConfirmOptions {
  confirmLabel?: string;
  danger?: boolean;
}

/** Resolves true when the person confirms; Escape, Cancel and clicking outside resolve false. */
export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm';
    const text = document.createElement('p');
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = options.danger ? 'danger' : 'primary';
    ok.textContent = options.confirmLabel ?? 'Confirm';
    actions.append(cancel, ok);
    dialog.append(text, actions);

    let answer = false;
    cancel.addEventListener('click', () => dialog.close());
    ok.addEventListener('click', () => {
      answer = true;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    closeOnBackdrop(dialog);
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}

/** A click on the backdrop (outside the dialog's box) closes it. */
function closeOnBackdrop(dialog: HTMLDialogElement): void {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
}

export function openDialog(id: string): HTMLDialogElement | null {
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return null;
  if (!dialog.open) dialog.showModal();
  return dialog;
}

export function initDialogs(): void {
  for (const dialog of document.querySelectorAll('dialog')) closeOnBackdrop(dialog);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const opener = target?.closest<HTMLElement>('[data-dialog-open]');
    if (opener && openDialog(opener.dataset.dialogOpen as string)) {
      event.preventDefault();
      return;
    }
    const closer = target?.closest<HTMLElement>('[data-dialog-close]');
    if (closer) {
      event.preventDefault();
      closer.closest('dialog')?.close();
    }
  });

  // Buttons with data-confirm ask first; a confirmed submit goes through untouched.
  const confirmed = new WeakSet<HTMLElement>();
  document.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    const message = submitter?.dataset.confirm;
    if (!submitter || !message || confirmed.has(submitter)) return;
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    void confirmDialog(message, {
      confirmLabel: submitter.dataset.confirmLabel ?? submitter.textContent?.trim() ?? 'Confirm',
      danger: submitter.classList.contains('danger'),
    }).then((yes) => {
      if (!yes) return;
      confirmed.add(submitter);
      form.requestSubmit(submitter);
      confirmed.delete(submitter);
    });
  });
}
