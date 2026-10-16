// The New token dialog (UI spec §4.2): creates the token through the API and shows it in the
// dialog, once, with Copy. Without JavaScript the form posts and the page shows the token.
import { ApiError, api } from './api.ts';

interface CreatedToken {
  token: string;
  name: string;
  scopes: string[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Same markup as the server's TokenCreated component. */
function created(token: CreatedToken): HTMLElement {
  const box = el('div', 'token-created');
  box.append(el('h2', '', `Token “${token.name}” created`));
  const scopes = el('p', 'status');
  for (const scope of token.scopes) scopes.append(el('span', 'pill tone-grey', scope));
  const row = el('div', 'token-row');
  const value = el('code', '', token.token);
  value.id = 'new-token-value';
  const copy = el('button', 'primary small', 'Copy');
  copy.type = 'button';
  copy.dataset.copyFrom = 'new-token-value';
  row.append(value, copy);
  const warning = el('p', 'warning', 'This is the only time the full token is shown. Store it in your CI secrets now.');
  const command = el('pre', 'command');
  command.append(el('code', '', `export PIXELTWIN_TOKEN=${token.token}`));
  const actions = el('div', 'dialog-actions');
  const done = el('button', 'primary', 'Done');
  done.type = 'button';
  // The page's token list (or onboarding step) is out of date now.
  done.addEventListener('click', () => location.reload());
  actions.append(done);
  box.append(scopes, row, warning, command, actions);
  return box;
}

export function init(): void {
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('dialog [data-token-form]')) return;
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const scopes = data.getAll('scopes').map(String);
    form.querySelector('.form-error')?.remove();
    try {
      const token = await api<CreatedToken>('POST', `/projects/${form.dataset.slug}/tokens`, { name, scopes });
      const dialog = form.closest('dialog');
      dialog?.querySelector('h2')?.remove();
      form.replaceWith(created(token));
      dialog?.addEventListener('close', () => location.reload(), { once: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      const message = el('p', 'flash error form-error', err instanceof Error ? err.message : String(err));
      form.prepend(message);
    }
  });
}
