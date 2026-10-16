// Build page search: narrows the grid while you type, by name or variant, and keeps the search
// in the address (so live updates and reloads fetch the same search from the server). Enter
// submits the form, which also searches checks beyond the first page.

export function init(): void {
  const input = document.querySelector<HTMLInputElement>('[data-check-search]');
  if (!input) return;

  const apply = () => {
    const text = input.value.trim().toLowerCase();
    const cards = [...document.querySelectorAll<HTMLElement>('.check-card[data-search]')];
    let shown = 0;
    for (const card of cards) {
      const hit = !text || (card.dataset.search ?? '').includes(text);
      card.hidden = !hit;
      if (hit) shown += 1;
    }
    const empty = document.querySelector<HTMLElement>('[data-search-empty]');
    if (empty && cards.length > 0) {
      empty.hidden = shown > 0;
      const title = empty.querySelector('h3');
      if (title) title.textContent = 'No checks match this search.';
    }
    const url = new URL(location.href);
    if (text) url.searchParams.set('q', input.value.trim());
    else url.searchParams.delete('q');
    url.searchParams.delete('cursor');
    history.replaceState(history.state, '', url);
  };

  input.addEventListener('input', apply);
}
