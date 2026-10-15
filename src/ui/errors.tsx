import type { Context } from 'hono';
import { AppError } from '../errors';
import type { AppEnv, Services } from '../http/env';
import { titleFor } from '../http/problem';
import { uiOf } from './context';
import { Layout } from './layout';

/** HTML error page for /ui requests (the API keeps problem+json). */
export function renderUiError(c: Context<AppEnv>, s: Services, err: unknown, requestId: string): Response {
  const status = err instanceof AppError ? err.status : 500;
  const title = err instanceof AppError ? titleFor(err.code) : 'Something went wrong';
  const detail =
    err instanceof AppError
      ? err.detail
      : `An unexpected error occurred. Quote request ${requestId} when reporting it.`;
  const ui = uiOf(c, s);
  const html = (
    <Layout ui={ui} title={title}>
      <div class="panel narrow">
        <h1>{title}</h1>
        <p>{detail}</p>
        <p>
          <a href={ui.url('/ui')}>Back to projects</a>
        </p>
      </div>
    </Layout>
  );
  return new Response(`${html}`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-request-id': requestId },
  });
}
