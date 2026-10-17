import type { Context } from 'hono';
import type { AppEnv, Services } from '../../http/env';
import { uiOf } from '../context';
import { Layout } from '../layout';

/**
 * What a signed-up user sees on every page until an admin decides (no project data at all):
 * waiting, or turned down with the reason. Only logging out and the theme work.
 */
export async function waitingPage(c: Context<AppEnv>, s: Services, rejected: boolean): Promise<Response> {
  const ui = uiOf(c, s);
  const reason = rejected
    ? ((
        await s.deps.db
          .selectFrom('accessRequests')
          .select('reason')
          .where('userId', '=', ui.user?.id ?? '')
          .executeTakeFirst()
      )?.reason ?? null)
    : null;
  const title = rejected ? 'Your request was turned down' : 'Waiting for an admin to approve your access';
  return c.html(
    <Layout ui={ui} title={rejected ? 'Request turned down' : 'Waiting for approval'}>
      <div class="auth-card">
        <h1>{title}</h1>
        <p class="sub">
          {rejected
            ? 'An admin decided not to give this account access.'
            : 'Your request reached the admins. Once one of them approves it, this page shows your projects.'}
        </p>
        {reason && <p class="flash notice">{`Reason: ${reason}`}</p>}
        <form method="post" action={ui.url('/ui/logout')}>
          <button class="wide" type="submit">
            Log out
          </button>
        </form>
      </div>
    </Layout>,
    403,
  );
}
