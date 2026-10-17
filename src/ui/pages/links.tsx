import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { LinkPurpose } from '../../db/schema';
import { acceptReset } from '../../domain/auth/resets';
import { createSession } from '../../domain/auth/sessions';
import { acceptInvite, describeLink } from '../../domain/invites';
import { membershipsOf } from '../../domain/members';
import { AppError } from '../../errors';
import { clientIp } from '../../http/client-ip';
import { setSessionCookie } from '../../http/cookies';
import type { AppEnv, Services } from '../../http/env';
import { describedBy, Field, formErrors, PasswordField } from '../components';
import { type Ui, uiOf } from '../context';
import { Layout } from '../layout';

// One-time links (invites, password resets): public pages, without a session (see session.ts).

const PROBLEMS: Record<string, { title: string; text: string }> = {
  link_invalid: {
    title: 'This link does not work',
    text: 'It may have been replaced by a newer one or revoked. Ask whoever sent it for a new link.',
  },
  link_used: { title: 'This link was already used', text: 'Log in with the password chosen then.' },
  link_expired: { title: 'This link has expired', text: 'Ask whoever sent it for a new one.' },
};

function LinkProblem({ ui, code }: { ui: Ui; code: string }) {
  const problem = PROBLEMS[code] ?? (PROBLEMS.link_invalid as { title: string; text: string });
  return (
    <Layout ui={ui} title={problem.title}>
      <div class="auth-card">
        <h1>{problem.title}</h1>
        <p class="sub">{problem.text}</p>
        <a class="button wide" href={ui.url('/ui/login')}>
          Go to log in
        </a>
      </div>
    </Layout>
  );
}

function PasswordPage(props: {
  ui: Ui;
  purpose: LinkPurpose;
  action: string;
  email: string;
  projects: string[];
  errors?: Record<string, string>;
}) {
  const { ui, email } = props;
  const errors = props.errors ?? {};
  const invite = props.purpose === 'invite';
  const hint = 'At least 10 characters.';
  const title = invite ? 'Join pixeltwin' : 'Set a new password';
  return (
    <Layout ui={ui} title={title}>
      <div class="auth-card">
        <h1>{title}</h1>
        <p class="sub">
          {invite
            ? `You are invited as ${email}${props.projects.length ? ` to ${props.projects.join(', ')}` : ''}. Choose a password to create your account.`
            : `For ${email}. Every other session of this account ends.`}
        </p>
        <form method="post" action={ui.url(props.action)}>
          {errors._form && (
            <p class="flash error" role="alert">
              {errors._form}
            </p>
          )}
          {/* For password managers: the account this password belongs to. The invite fixes the email. */}
          <input type="email" name="username" autocomplete="username" value={email} readonly hidden />
          <Field id="link-password" label={invite ? 'Password' : 'New password'} hint={hint} error={errors.password}>
            <PasswordField>
              <input
                name="password"
                type="password"
                autocomplete="new-password"
                minlength={10}
                required
                {...describedBy('link-password', hint, errors.password)}
              />
            </PasswordField>
          </Field>
          <button class="primary wide" type="submit">
            {invite ? 'Create account' : 'Set password'}
          </button>
        </form>
      </div>
    </Layout>
  );
}

const PURPOSE_OF: Record<string, LinkPurpose> = { invite: 'invite', reset: 'password_reset' };

export function registerLinkPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  /** Limited per IP like logins, for the page and the form alike. */
  const limited = (c: Context<AppEnv>) => !s.loginLimiter.hit(clientIp(c), 'one-time-link');

  const problem = (c: Context<AppEnv>, err: unknown) => {
    if (!(err instanceof AppError) || !(err.code in PROBLEMS)) throw err;
    return c.html(<LinkProblem ui={uiOf(c, s)} code={err.code} />, err.status as 404 | 410);
  };

  for (const kind of ['invite', 'reset'] as const) {
    const purpose = PURPOSE_OF[kind] as LinkPurpose;
    const path = `/ui/${kind}/:token`;

    app.get(path, async (c) => {
      const ui = uiOf(c, s);
      if (limited(c)) throw new AppError('rate_limited', 429, 'Too many attempts; wait a minute and try again.');
      const token = c.req.param('token') ?? '';
      try {
        const link = await describeLink(s.deps, token);
        if (link.purpose !== purpose) throw new AppError('link_invalid', 404, 'Wrong kind of link.');
        return c.html(
          <PasswordPage
            ui={ui}
            purpose={purpose}
            action={`/ui/${kind}/${token}`}
            email={link.email}
            projects={link.projects}
          />,
        );
      } catch (err) {
        return problem(c, err);
      }
    });

    app.post(path, async (c) => {
      const ui = uiOf(c, s);
      if (limited(c)) throw new AppError('rate_limited', 429, 'Too many attempts; wait a minute and try again.');
      const token = c.req.param('token') ?? '';
      const form = await c.req.parseBody();
      const input = { password: typeof form.password === 'string' ? form.password : '' };
      let link: Awaited<ReturnType<typeof describeLink>>;
      try {
        link = await describeLink(s.deps, token);
        if (link.purpose !== purpose) throw new AppError('link_invalid', 404, 'Wrong kind of link.');
      } catch (err) {
        return problem(c, err);
      }
      try {
        const user =
          purpose === 'invite' ? await acceptInvite(s.deps, token, input) : await acceptReset(s.deps, token, input);
        setSessionCookie(c, s.config.publicUrl, await createSession(s.deps, user.id));
        if (purpose === 'password_reset') return c.redirect(ui.url('/ui?done=password-set'), 303);
        // Straight into the project they were invited to, when there is just one.
        const mine = (await membershipsOf(s.deps, user.id)).get(user.id) ?? [];
        const only = mine.length === 1 ? mine[0] : undefined;
        return c.redirect(ui.url(only ? `/ui/p/${only.slug}?done=welcome-invite` : '/ui?done=welcome-invite'), 303);
      } catch (err) {
        if (err instanceof AppError && err.code in PROBLEMS) return problem(c, err);
        if (!(err instanceof AppError) || err.status >= 500) throw err;
        return c.html(
          <PasswordPage
            ui={ui}
            purpose={purpose}
            action={`/ui/${kind}/${token}`}
            email={link.email}
            projects={link.projects}
            errors={formErrors(err)}
          />,
          err.status as 409 | 422,
        );
      }
    });
  }
}
