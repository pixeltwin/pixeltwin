// All builds page (admins): "select all" for the row checkboxes, and the Delete button names how
// many builds it deletes and stays off while none is picked. Rows the live island replaces are
// picked up again on the next change.

export function init(): void {
  const form = document.querySelector<HTMLFormElement>('[data-builds-form]');
  const button = form?.querySelector<HTMLButtonElement>('[data-delete-selected]');
  if (!form || !button) return;
  const boxes = () => [...form.querySelectorAll<HTMLInputElement>('input[name="build"]')];
  const all = form.querySelector<HTMLInputElement>('[data-select-all]');

  const update = () => {
    const picked = boxes().filter((b) => b.checked).length;
    button.disabled = picked === 0;
    button.textContent = picked === 0 ? 'Delete selected' : `Delete ${picked} build${picked === 1 ? '' : 's'}`;
    button.dataset.confirmLabel = button.textContent;
    if (all) {
      all.checked = picked > 0 && picked === boxes().length;
      all.indeterminate = picked > 0 && picked < boxes().length;
    }
  };

  form.addEventListener('change', (event) => {
    if (all && event.target === all) for (const box of boxes()) box.checked = all.checked;
    update();
  });
  update();
}
