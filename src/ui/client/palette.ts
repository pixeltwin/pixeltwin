// The ⌘K / Ctrl+K command palette (UI spec §4.3): projects, the current project's branches and
// recent builds, and actions. Loaded on first use; data is fetched once per page.
import { api, basePath } from './api.ts';
import { rank } from './rank.ts';

interface Entry {
  label: string;
  hint: string;
  group: string;
  href?: string;
  run?: () => void;
  recency: number;
}

interface Page<T> {
  items: T[];
}

// Actions sort above everything else when the query is empty.
const ACTION = 2e15;

let dialog: HTMLDialogElement | null = null;
let entries: Promise<Entry[]> | null = null;
let refresh: () => Promise<void> = async () => {};

function cycleTheme(): void {
  const order = ['light', 'dark', 'system'];
  const now = document.documentElement.dataset.theme ?? 'light';
  const next = order[(order.indexOf(now) + 1) % order.length];
  document.querySelector<HTMLButtonElement>(`.theme-switch button[value="${next}"]`)?.click();
}

async function load(): Promise<Entry[]> {
  const base = basePath();
  const project = document.body.dataset.project;
  const admin = document.body.dataset.role === 'admin';
  const manages = document.body.dataset.canManage !== undefined;
  const out: Entry[] = [];

  const review = document.querySelector<HTMLAnchorElement>('[data-palette-review]');
  if (review)
    out.push({
      label: 'Review pending checks',
      hint: '',
      group: 'Action',
      href: review.href,
      recency: ACTION + 1,
    });
  out.push({ label: 'Toggle theme', hint: 'light, dark, system', group: 'Action', run: cycleTheme, recency: ACTION });
  out.push({ label: 'All projects', hint: '', group: 'Action', href: `${base}/ui`, recency: ACTION });
  out.push({ label: 'API docs', hint: '', group: 'Action', href: `${base}/docs`, recency: ACTION });
  if (admin) out.push({ label: 'Users', hint: '', group: 'Action', href: `${base}/ui/admin/users`, recency: ACTION });
  if (project && manages) {
    out.push({
      label: 'New token',
      hint: project,
      group: 'Action',
      href: `${base}/ui/p/${project}/settings/tokens/new`,
      recency: ACTION,
    });
  }

  const [projects, branches, builds] = await Promise.all([
    api<Page<{ slug: string; name: string }>>('GET', '/projects').catch(() => ({ items: [] })),
    project
      ? api<Array<{ branch: string; latest: { createdAt: number } }>>('GET', `/projects/${project}/branches`).catch(
          () => [],
        )
      : Promise.resolve([]),
    project
      ? api<Page<{ id: string; number: number; branch: string; createdAt: number }>>(
          'GET',
          `/projects/${project}/builds?limit=20`,
        ).catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] }),
  ]);
  for (const p of projects.items) {
    out.push({ label: p.name, hint: p.slug, group: 'Project', href: `${base}/ui/p/${p.slug}`, recency: 0 });
  }
  for (const b of branches) {
    out.push({
      label: b.branch,
      hint: '',
      group: 'Branch',
      href: `${base}/ui/p/${project}/builds?branch=${encodeURIComponent(b.branch)}`,
      recency: b.latest.createdAt,
    });
  }
  for (const b of builds.items) {
    out.push({
      label: `#${b.number} ${b.branch}`,
      hint: '',
      group: 'Build',
      href: `${base}/ui/builds/${b.id}`,
      recency: b.createdAt,
    });
  }
  return out;
}

function build(): HTMLDialogElement {
  const box = document.createElement('dialog');
  box.className = 'palette';
  box.setAttribute('aria-label', 'Search and commands');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search projects, branches, builds and actions…';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');
  input.setAttribute('aria-autocomplete', 'list');
  const list = document.createElement('ul');
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  box.append(input, list);

  let shown: Entry[] = [];
  let active = 0;

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    box.close();
    if (entry.run) entry.run();
    else if (entry.href) location.assign(entry.href);
  };
  const paint = () => {
    list.replaceChildren(
      ...shown.map((entry, i) => {
        const li = document.createElement('li');
        li.id = `palette-option-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        const label = document.createElement('span');
        label.textContent = entry.label;
        const hint = document.createElement('span');
        hint.className = 'muted';
        hint.textContent = entry.hint ? `${entry.group} · ${entry.hint}` : entry.group;
        li.append(label, hint);
        li.addEventListener('mousemove', () => {
          if (active === i) return;
          active = i;
          paint();
        });
        li.addEventListener('click', () => go(entry));
        return li;
      }),
    );
    if (shown.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'Nothing matches.';
      list.append(empty);
    }
    input.setAttribute('aria-activedescendant', shown.length ? `palette-option-${active}` : '');
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  refresh = async () => {
    entries ??= load();
    shown = rank(await entries, input.value, 30);
    active = 0;
    paint();
  };

  input.addEventListener('input', () => void refresh());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + shown.length) % Math.max(1, shown.length);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(shown[active]);
    }
  });
  box.addEventListener('close', () => {
    input.value = '';
  });
  box.addEventListener('click', (e) => {
    if (e.target === box) box.close();
  });
  document.body.append(box);
  return box;
}

/** Opens the palette, or closes it when it is open (⌘K twice). */
export function open(): void {
  dialog ??= build();
  if (dialog.open) {
    dialog.close();
    return;
  }
  dialog.showModal();
  dialog.querySelector('input')?.focus();
  void refresh();
}
