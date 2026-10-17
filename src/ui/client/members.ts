// Members (project settings): the email field of "Add member" searches the users who could be
// added, as an accessible combobox. Without JavaScript it is a plain email field.
import { api } from './api.ts';

interface Candidate {
  id: string;
  email: string;
  role: string;
}

const DEBOUNCE_MS = 200;

function setup(input: HTMLInputElement): void {
  const slug = input.dataset.memberSearch ?? '';
  const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
  if (!slug || !(list instanceof HTMLUListElement)) return;
  input.setAttribute('role', 'combobox');
  list.setAttribute('role', 'listbox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  let items: Candidate[] = [];
  /** No user matches a whole email: the one option is to invite it. */
  let invite: string | null = null;
  const options = () => (invite ? 1 : items.length);
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = '';

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const mark = (index: number) => {
    active = index;
    const all = [...list.querySelectorAll('[role="option"]')];
    for (const [i, li] of all.entries()) li.setAttribute('aria-selected', String(i === index));
    const current = all[index];
    if (current) {
      input.setAttribute('aria-activedescendant', current.id);
      current.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };

  const inviteNow = (email: string) => {
    input.value = email;
    close();
    const button = input.form?.querySelector<HTMLButtonElement>('[data-invite-submit]');
    if (button) input.form?.requestSubmit(button);
  };

  const pick = (candidate: Candidate) => {
    input.value = candidate.email;
    close();
    input.dispatchEvent(new CustomEvent('member-picked', { bubbles: true, detail: candidate }));
  };

  const render = (query: string) => {
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'combobox-empty';
      empty.setAttribute('aria-disabled', 'true');
      empty.textContent = 'No users match';
      list.append(empty);
      invite = /^[^\s@]+@[^\s@]+$/.test(query) ? query : null;
      if (invite) {
        const email = invite;
        const li = document.createElement('li');
        li.id = `${list.id}-0`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.className = 'combobox-invite';
        li.textContent = `Invite ${email}`;
        li.addEventListener('mousedown', (event) => {
          event.preventDefault();
          inviteNow(email);
        });
        list.append(li);
      }
    } else invite = null;
    for (const [i, candidate] of items.entries()) {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const email = document.createElement('span');
      email.textContent = candidate.email;
      const role = document.createElement('span');
      role.className = 'muted';
      role.textContent = candidate.role;
      li.append(email, role);
      // mousedown, not click: the input must not lose focus (and close the list) first.
      li.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(candidate);
      });
      list.append(li);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    mark(-1);
  };

  const search = async () => {
    const query = input.value.trim();
    if (query.length < 2) {
      close();
      return;
    }
    asked = query;
    try {
      const found = await api<{ items: Candidate[] }>(
        'GET',
        `/projects/${encodeURIComponent(slug)}/members/candidates?q=${encodeURIComponent(query)}`,
      );
      // An answer to an older query arrived late: the newer one decides.
      if (asked !== query || input.value.trim() !== query) return;
      items = found.items;
      render(query);
    } catch {
      close();
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (list.hidden) {
      if (event.key === 'ArrowDown' && input.value.trim().length >= 2) {
        event.preventDefault();
        void search();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options() === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      mark((active + step + options()) % options());
    } else if (event.key === 'Enter') {
      const candidate = items[active];
      if (invite && active === 0) {
        event.preventDefault();
        inviteNow(invite);
      } else if (candidate) {
        event.preventDefault();
        pick(candidate);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', close);
}

export function init(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[data-member-search]')) setup(input);
}
