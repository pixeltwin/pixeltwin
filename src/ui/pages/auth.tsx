import type { OpenAPIHono } from '@hono/zod-openapi';
import { createSession, deleteSession } from '../../domain/auth/sessions';
import { completeSetup } from '../../domain/auth/setup';
import { authenticate } from '../../domain/auth/users';
import { AppError } from '../../errors';
import { clientIp } from '../../http/client-ip';
import { clearSessionCookie, setSessionCookie } from '../../http/cookies';
import type { AppEnv, Services } from '../../http/env';
import { describedBy, Field, formErrors, PasswordField } from '../components';
import { field, safeNext, type Ui, uiOf } from '../context';
import { Layout } from '../layout';

function LoginPage({ ui, next, email, error }: { ui: Ui; next: string; email?: string | undefined; error?: string }) {
  return (
    <Layout ui={ui} title="Log in">
      <div class="auth-card">
        <h1>Log in</h1>
        <p class="sub">Review and approve your visual changes.</p>
        <form method="post" action={ui.url('/ui/login')}>
          {error && (
            <p class="flash error" role="alert">
              {error}
            </p>
          )}
          <input type="hidden" name="next" value={next} />
          <Field id="login-email" label="Email">
            <input
              name="email"
              type="email"
              autocomplete="username"
              required
              value={email ?? ''}
              {...describedBy('login-email')}
            />
          </Field>
          <Field id="login-password" label="Password">
            <PasswordField>
              <input
                name="password"
                type="password"
                autocomplete="current-password"
                required
                {...describedBy('login-password')}
              />
            </PasswordField>
          </Field>
          <button class="primary wide" type="submit">
            Log in
          </button>
        </form>
      </div>
    </Layout>
  );
}

function SetupPage(props: { ui: Ui; token: string; email?: string | undefined; errors?: Record<string, string> }) {
  const { ui, token } = props;
  const errors = props.errors ?? {};
  const passwordHint = 'At least 10 characters.';
  return (
    <Layout ui={ui} title="Set up pixeltwin">
      <div class="auth-card">
        <h1>Create the first admin</h1>
        <p class="sub">
          This account manages users, projects and tokens. Open this page with the setup link printed in the server log
          (for Docker: docker logs pixeltwin).
        </p>
        <form method="post" action={ui.url('/ui/setup')}>
          {errors._form && (
            <p class="flash error" role="alert">
              {errors._form}
            </p>
          )}
          <input type="hidden" name="token" value={token} />
          <Field id="setup-email" label="Email" error={errors.email}>
            <input
              name="email"
              type="email"
              autocomplete="username"
              required
              value={props.email ?? ''}
              {...describedBy('setup-email', undefined, errors.email)}
            />
          </Field>
          <Field id="setup-password" label="Password" hint={passwordHint} error={errors.password}>
            <PasswordField>
              <input
                name="password"
                type="password"
                autocomplete="new-password"
                minlength={10}
                required
                {...describedBy('setup-password', passwordHint, errors.password)}
              />
            </PasswordField>
          </Field>
          <button class="primary wide" type="submit">
            Create admin
          </button>
        </form>
      </div>
    </Layout>
  );
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
      return c.html(
        <SetupPage ui={ui} token={token} email={email} errors={formErrors(err)} />,
        err.status as 403 | 422,
      );
    }
  });
}
