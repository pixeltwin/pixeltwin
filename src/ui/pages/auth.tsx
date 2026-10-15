import type { OpenAPIHono } from '@hono/zod-openapi';
import { createSession, deleteSession } from '../../domain/auth/sessions';
import { completeSetup } from '../../domain/auth/setup';
import { authenticate } from '../../domain/auth/users';
import { AppError } from '../../errors';
import { clientIp } from '../../http/client-ip';
import { clearSessionCookie, setSessionCookie } from '../../http/cookies';
import type { AppEnv, Services } from '../../http/env';
import { field, safeNext, type Ui, uiOf } from '../context';
import { Layout } from '../layout';

function LoginPage({ ui, next, email, error }: { ui: Ui; next: string; email?: string | undefined; error?: string }) {
  return (
    <Layout ui={ui} title="Log in">
      <form class="panel narrow" method="post" action={ui.url('/ui/login')}>
        <h1>Log in</h1>
        {error && <p class="error">{error}</p>}
        <input type="hidden" name="next" value={next} />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value={email ?? ''} />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <p>
          <button class="primary" type="submit">
            Log in
          </button>
        </p>
      </form>
    </Layout>
  );
}

function SetupPage({ ui, token, email, error }: { ui: Ui; token: string; email?: string | undefined; error?: string }) {
  return (
    <Layout ui={ui} title="Set up pixeltwin">
      <form class="panel narrow" method="post" action={ui.url('/ui/setup')}>
        <h1>Create the first admin</h1>
        <p class="sub">This account manages users, projects and tokens.</p>
        {error && <p class="error">{error}</p>}
        <input type="hidden" name="token" value={token} />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value={email ?? ''} />
        <label for="password">Password (at least 10 characters)</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength={10} required />
        <p>
          <button class="primary" type="submit">
            Create admin
          </button>
        </p>
      </form>
    </Layout>
  );
}

function messageOf(err: AppError): string {
  return err.errors?.length ? err.errors.map((e) => `${e.path}: ${e.message}`).join('; ') : err.detail;
}

export function registerAuthPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/login', (c) => {
    const ui = uiOf(c, s);
    const next = safeNext(c.req.query('next'));
    if (ui.user) return c.redirect(ui.url(next), 303);
    if (s.setup.open) return c.redirect(ui.url('/ui/setup'), 303);
    return c.html(<LoginPage ui={ui} next={next} />);
  });

  app.post('/ui/login', async (c) => {
    const ui = uiOf(c, s);
    const form = await c.req.parseBody();
    const email = field(form, 'email') ?? '';
    const password = typeof form.password === 'string' ? form.password : '';
    const next = safeNext(field(form, 'next'));
    if (!s.loginLimiter.hit(clientIp(c), email)) {
      return c.html(<LoginPage ui={ui} next={next} email={email} error="Too many attempts; wait a minute." />, 429);
    }
    const user = await authenticate(s.deps, email, password);
    if (!user)
      return c.html(<LoginPage ui={ui} next={next} email={email} error="The email or password is wrong." />, 401);
    setSessionCookie(c, s.config.publicUrl, await createSession(s.deps, user.id));
    return c.redirect(ui.url(next), 303);
  });

  app.post('/ui/logout', async (c) => {
    const token = c.get('sessionToken');
    if (token) await deleteSession(s.deps, token);
    clearSessionCookie(c, s.config.publicUrl);
    return c.redirect(uiOf(c, s).url('/ui/login'), 303);
  });

  app.get('/ui/setup', (c) => {
    const ui = uiOf(c, s);
    if (!s.setup.open) return c.redirect(ui.url('/ui/login'), 303);
    return c.html(<SetupPage ui={ui} token={c.req.query('token') ?? ''} />);
  });

  app.post('/ui/setup', async (c) => {
    const ui = uiOf(c, s);
    const form = await c.req.parseBody();
    const token = field(form, 'token') ?? '';
    const email = field(form, 'email');
    try {
      const admin = await completeSetup(s.deps, s.setup, { token, email, password: form.password });
      setSessionCookie(c, s.config.publicUrl, await createSession(s.deps, admin.id));
      return c.redirect(ui.url('/ui?done=welcome'), 303);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (err.code === 'setup_complete') return c.redirect(ui.url('/ui/login'), 303);
      return c.html(<SetupPage ui={ui} token={token} email={email} error={messageOf(err)} />, err.status as 403 | 422);
    }
  });
}
