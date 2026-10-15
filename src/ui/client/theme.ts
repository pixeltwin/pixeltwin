// Theme switch without a page load (UI spec §3.4): same cookie as POST /ui/theme.

const THEMES = ['light', 'dark', 'system'];

export function initTheme(): void {
  document.addEventListener('submit', (event) => {
    const form = event.target;
    const button = event.submitter;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('theme-switch')) return;
    const theme = button instanceof HTMLButtonElement ? button.value : '';
    if (!THEMES.includes(theme)) return;
    event.preventDefault();
    const secure = location.protocol === 'https:' ? '; secure' : '';
    // biome-ignore lint/suspicious/noDocumentCookie: the server reads this cookie to render the theme.
    document.cookie = `pt_theme=${theme}; path=/; max-age=31536000; samesite=lax${secure}`;
    document.documentElement.dataset.theme = theme;
    for (const b of form.querySelectorAll('button[name="theme"]')) {
      b.setAttribute('aria-pressed', String((b as HTMLButtonElement).value === theme));
    }
    form.closest('details')?.removeAttribute('open');
  });
}
