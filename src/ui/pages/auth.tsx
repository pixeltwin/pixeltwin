import type { OpenAPIHono } from '@hono/zod-openapi';
import { createSession, deleteSession } from '../../domain/auth/sessions';
import { completeSetup } from '../../domain/auth/setup';
import { authenticate } from '../../domain/auth/users';
import { getSignupSettings } from '../../domain/signup';
import { AppError } from '../../errors';
import { clientIp } from '../../http/client-ip';
import { clearSessionCookie, setSessionCookie } from '../../http/cookies';
import type { AppEnv, Services } from '../../http/env';
import { takeSignup } from '../../http/routes/signup';
import { describedBy, Field, formErrors, PasswordField } from '../components';
import { field, safeNext, type Ui, uiOf } from '../context';
import { Layout } from '../layout';

function LoginPage({
  ui,
  next,
  email,
  error,
  signup,
}: {
  ui: Ui;
  next: string;
  email?: string | undefined;
  error?: string;
  signup: boolean;
}) {
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
        {signup && (
          <p class="auth-alt">
            No account yet? <a href={ui.url('/ui/signup')}>Request access</a>
          </p>
        )}
      </div>
    </Layout>
  );
}

function SetupPage(props: {
  ui: Ui;
  token: string;
  /** Show the token as a field: the page was opened without its link, or the token was wrong. */
  askToken: boolean;
  email?: string | undefined;
  errors?: Record<string, string>;
}) {
  const { ui, token } = props;
  const errors = props.errors ?? {};
  const passwordHint = 'At least 10 characters.';
  const tokenHint = 'The server log prints it as setupToken when it starts with no users, with a setup link.';
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
          {props.askToken ? (
            <Field id="setup-token" label="Setup token" hint={tokenHint} error={errors.token}>
              <input
                {...describedBy('setup-token', tokenHint, errors.token)}
                name="token"
                type="text"
                autocomplete="off"
                spellcheck={false}
                required
                value={token}
              />
            </Field>
          ) : (
            <input type="hidden" name="token" value={token} />
          )}
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

type SignupValues = { email?: string | undefined; name?: string | undefined; note?: string | undefined };

function SignupPage(props: { ui: Ui; values?: SignupValues; errors?: Record<string, string> }) {
  const { ui } = props;
  const values = props.values ?? {};
  const errors = props.errors ?? {};
  const hint = 'At least 10 characters.';
  const noteHint = 'Which project you need, and why. Admins read it.';
  return (
    <Layout ui={ui} title="Request access">
      <div class="auth-card">
        <h1>Request access</h1>
        <p class="sub">An admin looks at your request and decides which projects you get.</p>
        <form method="post" action={ui.url('/ui/signup')}>
          {errors._form && (
            <p class="flash error" role="alert">
              {errors._form}
            </p>
          )}
          <Field id="signup-email" label="Email" error={errors.email}>
            <input
              name="email"
              type="email"
              autocomplete="username"
              required
              value={values.email ?? ''}
              {...describedBy('signup-email', undefined, errors.email)}
            />
          </Field>
          <Field id="signup-password" label="Password" hint={hint} error={errors.password}>
            <PasswordField>
              <input
                name="password"
                type="password"
                autocomplete="new-password"
                minlength={10}
                required
                {...describedBy('signup-password', hint, errors.password)}
              />
            </PasswordField>
          </Field>
          <Field id="signup-name" label="Name (optional)" error={errors.name}>
            <input
              name="name"
              type="text"
              autocomplete="name"
              value={values.name ?? ''}
              {...describedBy('signup-name', undefined, errors.name)}
            />
          </Field>
          <Field id="signup-note" label="Note (optional)" hint={noteHint} error={errors.note}>
            <textarea name="note" rows={3} maxlength={1000} {...describedBy('signup-note', noteHint, errors.note)}>
              {values.note ?? ''}
            </textarea>
          </Field>
          <button class="primary wide" type="submit">
            Request access
          </button>
        </form>
        <p class="auth-alt">
          Have an account? <a href={ui.url('/ui/login')}>Log in</a>
        </p>
      </div>
    </Layout>
  );
}

function SignupReceived({ ui, verify }: { ui: Ui; verify: boolean }) {
  return (
    <Layout ui={ui} title="Request received">
      <div class="auth-card">
        <h1>Request received</h1>
        <p class="sub">
          {verify
            ? 'Check your mail and open the link in it to confirm your email; an admin then looks at your request.'
            : 'An admin looks at your request. Log in any time to see whether it was approved.'}
        </p>
        <a class="button wide" href={ui.url('/ui/login')}>
          Go to log in
        </a>
      </div>
    </Layout>
  );
}

export function registerAuthPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  const signupOpen = async () => (await getSignupSettings(s.deps)).mode !== 'off';

  app.get('/ui/signup', async (c) => {
    const ui = uiOf(c, s);
    if (ui.user) return c.redirect(ui.url('/ui'), 303);
    if (!(await signupOpen())) throw new AppError('signup_closed', 404, 'This server does not take sign-ups.');
    return c.html(<SignupPage ui={ui} />);
  });

  app.post('/ui/signup', async (c) => {
    const ui = uiOf(c, s);
    const form = await c.req.parseBody();
    const values = { email: field(form, 'email'), name: field(form, 'name'), note: field(form, 'note') };
    const input = Object.fromEntries(
      Object.entries({ ...values, password: typeof form.password === 'string' ? form.password : '' }).filter(
        ([, v]) => v !== undefined && v !== '',
      ),
    );
    try {
      await takeSignup(s, c, input);
      return c.html(<SignupReceived ui={ui} verify={!!s.mailer} />, 202);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500 || err.code === 'signup_closed') throw err;
      return c.html(<SignupPage ui={ui} values={values} errors={formErrors(err)} />, err.status as 422 | 429);
    }
  });

  app.get('/ui/login', async (c) => {
    const ui = uiOf(c, s);
    const next = safeNext(c.req.query('next'));
    if (ui.user) return c.redirect(ui.url(next), 303);
    if (s.setup.open) return c.redirect(ui.url('/ui/setup'), 303);
    return c.html(<LoginPage ui={ui} next={next} signup={await signupOpen()} />);
  });

  app.post('/ui/login', async (c) => {
    const ui = uiOf(c, s);
    const form = await c.req.parseBody();
    const email = field(form, 'email') ?? '';
    const password = typeof form.password === 'string' ? form.password : '';
    const next = safeNext(field(form, 'next'));
    if (!s.loginLimiter.hit(clientIp(c), email)) {
      return c.html(
        <LoginPage
          ui={ui}
          next={next}
          email={email}
          error="Too many attempts; wait a minute."
          signup={await signupOpen()}
        />,
        429,
      );
    }
    const user = await authenticate(s.deps, email, password);
    if (!user)
      return c.html(
        <LoginPage
          ui={ui}
          next={next}
          email={email}
          error="The email or password is wrong."
          signup={await signupOpen()}
        />,
        401,
      );
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
    const token = c.req.query('token') ?? '';
    return c.html(<SetupPage ui={ui} token={token} askToken={!token} />);
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
      // A missing or wrong token is shown on the token field, which appears for it.
      const errors = err.code === 'invalid_setup_token' ? { token: err.detail } : formErrors(err);
      return c.html(
        <SetupPage ui={ui} token={token} askToken={!token || 'token' in errors} email={email} errors={errors} />,
        err.status as 403 | 422,
      );
    }
  });
}
