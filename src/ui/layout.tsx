import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { ASSET_PATHS } from './assets';
import type { Ui } from './context';

export interface LayoutProps {
  ui: Ui;
  title: string;
  notice?: string | undefined;
  error?: string | undefined;
  children?: Child;
}

export function Layout({ ui, title, notice, error, children }: LayoutProps) {
  // The doctype keeps browsers out of quirks mode; JSX cannot express it.
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{`${title} · pixeltwin`}</title>
          <link rel="stylesheet" href={ui.url(ASSET_PATHS.css)} />
          <script src={ui.url(ASSET_PATHS.js)} defer />
        </head>
        <body>
          <header class="top">
            <a class="brand" href={ui.url('/ui')}>
              pixeltwin
            </a>
            {ui.user && (
              <nav>
                <a href={ui.url('/ui')}>Projects</a>
                {ui.user.role === 'admin' && <a href={ui.url('/ui/admin/users')}>Users</a>}
                <a href={ui.url('/docs')}>API</a>
                <span>{ui.user.email}</span>
                <form class="inline" method="post" action={ui.url('/ui/logout')}>
                  <button type="submit">Log out</button>
                </form>
              </nav>
            )}
          </header>
          <main>
            {notice && <p class="notice">{notice}</p>}
            {error && <p class="error">{error}</p>}
            {children}
          </main>
        </body>
      </html>
    </>
  );
}
