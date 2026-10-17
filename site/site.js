// Tabs for the quickstart and copy buttons on code blocks. Without JavaScript every panel shows, one after another.
for (const tabs of document.querySelectorAll('[data-tabs]')) {
  const list = tabs.querySelector('[role="tablist"]');
  const buttons = [...tabs.querySelectorAll('[role="tab"]')];
  const select = (button, focus) => {
    for (const b of buttons) {
      const on = b === button;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) button.focus();
  };
  list.hidden = false;
  tabs.classList.add('has-tabs');
  select(buttons[0], false);
  for (const [i, button] of buttons.entries()) {
    button.addEventListener('click', () => select(button, false));
    button.addEventListener('keydown', (event) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(buttons[(next + buttons.length) % buttons.length], true);
    });
  }
}

if (navigator.clipboard) {
  for (const pre of document.querySelectorAll('pre[data-copy]')) {
    const head = pre.previousElementSibling;
    if (!head?.classList.contains('code-head')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', `Copy ${head.textContent.trim()}`);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1600);
    });
    head.append(button);
  }
}
