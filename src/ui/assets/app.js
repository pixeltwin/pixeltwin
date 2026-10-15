// Keyboard shortcuts for the review pages: any element with data-key="x" is triggered by key x.
// Forms are submitted, links followed. Typing in a field never triggers a shortcut.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return;
  const element = document.querySelector(`[data-key="${CSS.escape(event.key)}"]`);
  if (!element) return;
  event.preventDefault();
  if (element instanceof HTMLFormElement) element.requestSubmit();
  else if (element instanceof HTMLElement) element.click();
});

// Buttons with data-confirm ask before submitting their form.
document.addEventListener('submit', (event) => {
  const submitter = event.submitter;
  const message = submitter?.getAttribute('data-confirm');
  if (message && !window.confirm(message)) event.preventDefault();
});
