import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { ASSET_PATHS } from './assets';
import { clientModulePath } from './client-assets';
import type { Ui } from './context';
import { THEMES } from './theme';

/** One step of the breadcrumb; the last one is the current page and is not a link. */
export interface Crumb {
  label: string;
  href?: string | undefined;
}

export interface LayoutProps {
  ui: Ui;
  title: string;
  crumbs?: Crumb[];
  notice?: string | undefined;
  error?: string | undefined;
  /** Client islands this page starts (UI spec §3.2), e.g. `['review']`. */
  islands?: string[];
  /** `focus`: a full-width page without the content column (focus-mode review). */
  variant?: 'focus';
  /** The project this page belongs to: the palette offers its branches and builds. */
  project?: string;
  children?: Child;
}

const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System' } as const;

/** The pixeltwin mark: inline SVG, so the shell needs no image request. */
function Brand({ ui }: { ui: Ui }) {
  return (
    <a class="brand" href={ui.url('/ui')}>
      <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3 22 20H2Z" />
      </svg>
      <span>pixeltwin</span>
    </a>
  );
}

function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav class="crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => (
          <li>
            {crumb.href && i < crumbs.length - 1 ? (
              <a href={crumb.href}>{crumb.label}</a>
            ) : (
              <span aria-current="page">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A `<details>` menu: opens and closes without JavaScript. */
function UserMenu({ ui }: { ui: Ui }) {
  const user = ui.user;
  if (!user) return null;
  return (
    <details class="menu">
      <summary>
        <span class="avatar" aria-hidden="true">
          {user.email.charAt(0).toUpperCase()}
        </span>
        <span class="menu-email">{user.email}</span>
      </summary>
      <div class="menu-panel">
        <form class="theme-switch" method="post" action={ui.url('/ui/theme')}>
          <span class="menu-label">Theme</span>
          <input type="hidden" name="next" value={ui.here} />
          <div class="segmented">
            {THEMES.map((theme) => (
              <button type="submit" name="theme" value={theme} aria-pressed={ui.theme === theme ? 'true' : 'false'}>
                {THEME_LABELS[theme]}
              </button>
            ))}
          </div>
        </form>
        <a class="menu-item" href={ui.url('/docs')}>
          API docs
        </a>
        {user.role === 'admin' && (
          <a class="menu-item" href={ui.url('/ui/admin/users')}>
            Users
          </a>
        )}
        <form method="post" action={ui.url('/ui/logout')}>
          <button class="menu-item" type="submit">
            Log out
          </button>
        </form>
      </div>
    </details>
  );
}

export function Layout({ ui, title, crumbs, notice, error, islands, variant, project, children }: LayoutProps) {
  // The doctype keeps browsers out of quirks mode; JSX cannot express it.
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en" data-theme={ui.theme}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{`${title} · pixeltwin`}</title>
          <link rel="icon" type="image/svg+xml" href={ui.url(ASSET_PATHS.favicon)} />
          <link rel="stylesheet" href={ui.url(ASSET_PATHS.css)} />
          <script type="module" src={ui.url(clientModulePath('boot'))} />
        </head>
        <body
          data-base={ui.url('')}
          data-islands={islands?.join(' ') || undefined}
          data-project={project}
          data-role={ui.user?.role}
          class={variant}
        >
          <a class="skip-link" href="#main">
            Skip to content
          </a>
          <header class="topbar">
            <Brand ui={ui} />
            {crumbs && crumbs.length > 0 && <Crumbs crumbs={crumbs} />}
            <div class="topbar-end">
              {ui.user && (
                // Shown by the boot script: the palette needs JavaScript.
                <button type="button" class="palette-hint ghost small" data-palette-open hidden>
                  <span>Search</span> <kbd>⌘K</kbd>
                </button>
              )}
              <UserMenu ui={ui} />
            </div>
          </header>
          <main id="main">
            {notice && (
              <p class="flash notice" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p class="flash error" role="alert">
                {error}
              </p>
            )}
            {children}
          </main>
          <div class="toasts" aria-live="polite" data-toasts="" />
        </body>
      </html>
    </>
  );
}
