// Copy buttons: `<button data-copy="text">` or `<button data-copy-from="element-id">`.
import { toast } from './toast.ts';

/** The Clipboard API needs a secure context; plain-http installs fall back to execCommand. */
async function writeText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'visually-hidden';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

export function initCopy(): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-copy], [data-copy-from]')) {
    button.hidden = false;
  }
  document.addEventListener('click', async (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-copy], [data-copy-from]') : null;
    if (!button) return;
    event.preventDefault();
    const from = button.dataset.copyFrom ? document.getElementById(button.dataset.copyFrom) : null;
    const text = button.dataset.copy ?? from?.textContent ?? '';
    if (await writeText(text.trim())) toast('Copied to clipboard', { tone: 'success', timeout: 2000 });
    else toast('Copy failed: select the text and copy it by hand.', { tone: 'error' });
  });
}
